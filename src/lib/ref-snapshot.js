// Rank against a git ref instead of the checkout on disk.
//
// The index describes the files in the directory it is pointed at. An agent
// that works in a git worktree cut from origin/main, while the MCP server runs
// from a main checkout 28 commits behind, was handed a ranking of the older
// tree: files added upstream were missing from it, and nothing ranked them
// (bashbop seat-map work, 2026-11-19). A ref's tree is written to a per-user
// cache directory with git plumbing, without touching the repository's index,
// worktrees or branch, and indexed there like any other directory.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getCachedCodeMap } from "./index-cache.js";
import { getGitInfo } from "./repo.js";
import { runCommand } from "./tools.js";

/** `ref` value that means: the upstream, when the checkout is clean and behind it. */
export const AUTO_REF = "auto";

const snapshotDirectory = "solumbe-ref-snapshots";

/**
 * @typedef {object} RefSnapshot
 * @property {string} ref the ref that was ranked (`origin/main`)
 * @property {string} commit its full commit id
 * @property {number} [behind] commits the checkout is behind it, when known
 * @property {"requested" | "behind-upstream"} reason
 */

/**
 * The code map to rank against: the checkout's own, or a ref's tree when one
 * is asked for (`ref: "origin/main"`) or when `ref: "auto"` finds a clean
 * checkout behind its upstream. A dirty checkout is never replaced: its
 * uncommitted files exist only on disk. A snapshot that cannot be written
 * falls back to the checkout. `repo.root` stays the repository's own path;
 * `repo.snapshot` says which ref the files came from.
 * @param {string} [repoPath]
 * @param {{ ref?: string }} [options]
 */
export function getRankingCodeMap(repoPath = ".", options = {}) {
  const root = path.resolve(repoPath);
  const target = snapshotTarget(root, options.ref);
  const dir = target ? materialise(root, target.commit) : undefined;
  if (!target || !dir) return getCachedCodeMap(root);
  const map = getCachedCodeMap(dir);
  const name = map.repo.name === path.basename(dir) ? path.basename(root) : map.repo.name;
  return { ...map, repo: { ...map.repo, root, name, snapshot: target } };
}

/**
 * @param {string} root
 * @param {string} [ref]
 * @returns {RefSnapshot | undefined}
 */
function snapshotTarget(root, ref) {
  const wanted = typeof ref === "string" ? ref.trim() : "";
  if (!wanted) return undefined;
  const git = getGitInfo(root);
  // Only a repository's own root: a subdirectory's files would be indexed
  // under paths the checkout does not use.
  if (!git.available || !sameDirectory(git.root, root)) {
    if (wanted !== AUTO_REF) throw new Error(`ref ${wanted} cannot be ranked: ${root} is not the root of a git repository`);
    return undefined;
  }
  if (wanted === AUTO_REF) {
    if (!git.behind || !git.upstream || !git.clean) return undefined;
    const commit = resolveCommit(root, git.upstream);
    return commit ? { ref: git.upstream, commit, behind: git.behind, reason: "behind-upstream" } : undefined;
  }
  const commit = resolveCommit(root, wanted);
  if (!commit) throw new Error(`ref ${wanted} does not resolve to a commit in ${root}; fetch it or pass an existing ref such as origin/main`);
  // The checkout already is that commit, with nothing uncommitted on top.
  if (git.clean && resolveCommit(root, "HEAD") === commit) return undefined;
  const behind = Number(runCommand("git", ["rev-list", "--count", `HEAD..${commit}`], { cwd: root, timeout: 5000 }).stdout.trim());
  return { ref: wanted, commit, reason: "requested", ...(Number.isFinite(behind) ? { behind } : {}) };
}

/**
 * @param {string} root
 * @param {string} ref
 * @returns {string | undefined}
 */
function resolveCommit(root, ref) {
  const result = runCommand("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { cwd: root, timeout: 5000 });
  const commit = result.stdout.trim();
  return result.ok && /^[0-9a-f]{40,64}$/.test(commit) ? commit : undefined;
}

/**
 * Write a commit's tree under the cache directory, once per commit, keeping
 * only the latest snapshot of each repository.
 * @param {string} root
 * @param {string} commit
 * @returns {string | undefined} the snapshot directory, or undefined when it could not be written
 */
function materialise(root, commit) {
  const base = path.join(os.tmpdir(), snapshotDirectory, crypto.createHash("sha256").update(root).digest("hex").slice(0, 16));
  const dir = path.join(base, commit);
  const marker = `${dir}.complete`;
  if (fs.existsSync(marker) && fs.existsSync(dir)) return dir;
  const partial = `${dir}.partial-${process.pid}`;
  const index = `${partial}.index`;
  try {
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    // A private index file: the repository's own index is not read or written.
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const read = runCommand("git", ["read-tree", commit], { cwd: root, env, timeout: 60000 });
    const checkout = read.ok
      ? runCommand("git", ["checkout-index", "--all", "--force", `--prefix=${partial}${path.sep}`], { cwd: root, env, timeout: 120000 })
      : read;
    if (!checkout.ok) return undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(partial, dir);
    fs.writeFileSync(marker, `${commit}\n`);
    for (const entry of fs.readdirSync(base)) {
      if (entry !== commit && entry !== `${commit}.complete`) fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
    return dir;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(partial, { recursive: true, force: true });
  }
}

/**
 * @param {string | undefined} a
 * @param {string} b
 */
function sameDirectory(a, b) {
  if (!a) return false;
  const real = (/** @type {string} */ dir) => {
    try {
      return fs.realpathSync(dir);
    } catch {
      return path.resolve(dir);
    }
  };
  return real(a) === real(b);
}

/**
 * One line saying which tree a report describes, for its conflicts or notes.
 * @param {string} repoName
 * @param {RefSnapshot} snapshot
 * @returns {string}
 */
export function describeSnapshot(repoName, snapshot) {
  const ahead = snapshot.behind ? `, ${snapshot.behind} commit(s) ahead of the checkout` : "";
  const why = snapshot.reason === "behind-upstream" ? "the checkout is clean and behind it" : "it was requested";
  return `${repoName} was ranked against ${snapshot.ref} @ ${snapshot.commit.slice(0, 7)}${ahead} (${why}); a file listed here may not exist in the checkout until it is pulled. When working in a git worktree, pass its path instead.`;
}
