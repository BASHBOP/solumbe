/// <reference types="node" />
// Replay a repository's own history as a retrieval eval.
//
// The accuracy corpus (eval.js) is labelled by hand on tiny synthetic
// fixtures, and it is saturated: every case passes. A commit is a labelled case
// that already exists. Its subject is the request, and the files it changed are
// the files the work needed. This replays recent commits through the context
// pack, built on the tree as it stood before the commit (the parent), and
// scores the pack against what the commit actually touched:
//
//   - recall@k / MRR / precision@k on the primary files, computed the same way
//     as the corpus (computeRetrievalMetrics);
//   - hit@k: at least one changed file in the top k;
//   - pack recall: changed files found anywhere in the pack (primary, related
//     or tests).
//
// A changed test is expected in the pack's Tests section, which is where the
// pack puts tests, so it counts toward pack recall and not the primary metrics.
//
// A file the commit added did not exist on the parent, so no pack could name
// it; added files are counted but never expected. A changed file the code map
// does not index cannot be ranked either; those are reported as a coverage gap
// (that is how extension-less hook scripts went unranked) and kept out of the
// ranking metrics. Changelogs, which every change touches by convention, are
// ignored. Lockfiles are not: for a dependency request the lockfile is the
// answer, and an engine that indexes it should get credit for ranking it.
//
// It is a measurement, not a gate: its numbers depend on whichever repository
// and commits it reads, so it has no thresholds and is not part of `npm run ci`.
// The inspected repository is only read: each parent tree is exported with
// `git archive` into a temporary directory, scored, and removed with its index
// cache. Nothing from the repository is executed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateContextPack } from "./context-engine.js";
import { computeRetrievalMetrics } from "./eval.js";
import { getCachedCodeMap, getCodeMapCachePath } from "./index-cache.js";
import { runCommand } from "./tools.js";

export const historyEvalVersion = 1;

const DEFAULT_COMMITS = 30;
const DEFAULT_K = 5;
const DEFAULT_MAX_FILES = 12;
const GIT_TIMEOUT_MS = 60000;

// A changelog is touched by convention rather than because the request named
// it. Ranking it would reward a pack for guessing bookkeeping.
const IGNORED_PATTERN = /(^|\/)CHANGELOG(\.[a-z]+)?$/i;

// Release, merge and dependency-bot commits name a version or a package, not
// the work; their subjects are not requests anyone would type.
const SKIPPED_SUBJECT = /^(merge\b|revert\b|chore\(release\)|chore\(deps(-dev)?\)|bump\b|release\b|v?\d+\.\d+\.\d+$)/i;
const BOT_AUTHOR = /\[bot\]|dependabot|renovate/i;

/**
 * @typedef {object} HistoryEvalOptions
 * @property {string} [repoPath] repository to replay (defaults to the current directory)
 * @property {string} [ref] commit to walk back from (defaults to HEAD)
 * @property {number} [commits] how many eligible commits to score (defaults to 30)
 * @property {number} [k] cutoff for the ranking metrics (defaults to 5)
 * @property {number} [maxFiles] skip commits that change more expected files than this (defaults to 12)
 * @property {number} [limit] context pack limit per section (defaults to the pack's own default)
 */

/**
 * @typedef {object} HistoryCommit
 * @property {string} sha
 * @property {string} parent
 * @property {string} author
 * @property {string} subject
 */

/**
 * Replay recent commits of a repository through the context pack.
 * @param {HistoryEvalOptions} [options]
 * @returns {{ data: Record<string, any>, markdown: string }}
 */
export function runHistoryEval(options = {}) {
  const repoPath = path.resolve(options.repoPath ?? ".");
  const ref = options.ref ?? "HEAD";
  const commits = positiveInt(options.commits, DEFAULT_COMMITS);
  const k = positiveInt(options.k, DEFAULT_K);
  const maxFiles = positiveInt(options.maxFiles, DEFAULT_MAX_FILES);

  const top = git(repoPath, ["rev-parse", "--show-toplevel"]).trim();
  const head = git(top, ["rev-parse", ref]).trim();

  /** @type {Record<string, number>} */
  const skipped = {};
  const skip = (/** @type {string} */ reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  /** @type {Record<string, any>[]} */
  const cases = [];
  // A cherry-pick or a re-landed change repeats its subject; scoring both
  // would count one miss twice. The newest copy is kept.
  /** @type {Set<string>} */
  const seenQueries = new Set();
  // Read a few times as many commits as asked for, because releases, merges
  // and bulk changes are skipped.
  for (const commit of listCommits(top, head, commits * 4)) {
    if (cases.length >= commits) break;
    if (!commit.parent) {
      skip("root commit");
      continue;
    }
    if (BOT_AUTHOR.test(commit.author)) {
      skip("bot author");
      continue;
    }
    const query = queryFromSubject(commit.subject);
    if (!query || SKIPPED_SUBJECT.test(commit.subject) || SKIPPED_SUBJECT.test(query)) {
      skip("release, merge or bump subject");
      continue;
    }
    if (seenQueries.has(query.toLowerCase())) {
      skip("repeated subject");
      continue;
    }
    seenQueries.add(query.toLowerCase());
    const changes = changedFiles(top, commit);
    if (changes.expected.length === 0) {
      skip("no existing file changed");
      continue;
    }
    if (changes.expected.length > maxFiles) {
      skip(`more than ${maxFiles} files changed`);
      continue;
    }
    cases.push(scoreCommit(top, commit, query, changes, { k, limit: options.limit }));
  }

  const scoreboard = aggregate(cases, k);
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    evalKind: "history",
    historyEvalVersion,
    repo: { name: path.basename(top), root: top, head, ref },
    k,
    maxFiles,
    counts: { requested: commits, scored: cases.length, skipped },
    scoreboard,
    exitCode: cases.length === 0 ? 1 : 0,
    cases,
  };
  return { data, markdown: formatHistoryEvalMarkdown(data) };
}

/**
 * Turn a commit subject into the request a person would have typed: drop the
 * conventional-commit type and scope (the scope is usually a path hint the
 * requester would not have given) and a trailing pull request number.
 * @param {string} subject
 * @returns {string}
 */
export function queryFromSubject(subject) {
  return String(subject ?? "")
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .trim();
}

/**
 * Split a commit's changes into the files a pack built on its parent could
 * have named and the ones it could not.
 * @param {string} root
 * @param {HistoryCommit} commit
 * @returns {{ expected: string[], added: string[], ignored: string[] }}
 */
function changedFiles(root, commit) {
  const output = git(root, ["diff-tree", "-r", "-z", "--no-commit-id", "--name-status", "-M", commit.parent, commit.sha]);
  const fields = output.split("\0").filter(Boolean);
  /** @type {Set<string>} */
  const expected = new Set();
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const ignored = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i];
    // A rename or copy carries the old path and then the new one; the old path
    // is the file that existed when the work began.
    const renamed = status.startsWith("R") || status.startsWith("C");
    const file = fields[i + 1];
    i += renamed ? 3 : 2;
    if (!file) continue;
    if (status === "A") {
      added.push(file);
    } else if (isIgnored(file)) {
      ignored.push(file);
    } else {
      expected.add(file);
    }
  }
  return { expected: [...expected].sort(), added: added.sort(), ignored: ignored.sort() };
}

/**
 * @param {string} file
 */
function isIgnored(file) {
  return IGNORED_PATTERN.test(file);
}

/**
 * Build the pack on the parent tree and score it against the commit.
 * @param {string} root
 * @param {HistoryCommit} commit
 * @param {string} query
 * @param {{ expected: string[], added: string[], ignored: string[] }} changes
 * @param {{ k: number, limit?: number }} options
 */
function scoreCommit(root, commit, query, changes, { k, limit }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-history-"));
  const tree = path.join(temp, "tree");
  /** @type {string[]} */
  let ranked = [];
  /** @type {string[]} */
  let pack = [];
  /** @type {string[]} */
  let unindexed = [];
  /** @type {string[]} */
  let expected = changes.expected;
  /** @type {string[]} */
  let expectedTests = [];
  /** @type {string|undefined} */
  let error;
  try {
    exportTree(root, commit.parent, tree, temp);
    /** @type {{ files: { path: string, kind: string }[], dependencies?: { path: string }[] }} */
    const map = getCachedCodeMap(tree);
    // An engine that lists manifests and lockfiles beside the source files
    // (`dependencies`) can rank them, so they count as indexed.
    const kinds = new Map([
      ...(map.dependencies ?? []).map((file) => /** @type {[string, string]} */ ([file.path, "dependency"])),
      ...map.files.map((file) => /** @type {[string, string]} */ ([file.path, file.kind])),
    ]);
    unindexed = changes.expected.filter((file) => !kinds.has(file));
    // The pack ranks tests in their own section, never as primary files, so a
    // changed test is expected in the pack but not in the ranked primaries.
    expectedTests = changes.expected.filter((file) => kinds.get(file) === "test");
    expected = changes.expected.filter((file) => kinds.has(file) && kinds.get(file) !== "test");
    const { data } = generateContextPack(query, { paths: [tree], limit });
    const files = (/** @type {{ path: string }[]} */ list) => list.map((file) => file.path);
    ranked = files(data.primaryFiles);
    pack = [...ranked, ...files(data.relatedFiles), ...files(data.tests)];
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    removeQuietly(path.dirname(getCodeMapCachePath(tree)));
    removeQuietly(temp);
  }

  const metrics = computeRetrievalMetrics(expected, ranked, k);
  const needed = [...expected, ...expectedTests];
  const found = needed.filter((file) => pack.includes(file));
  return {
    sha: commit.sha,
    subject: commit.subject,
    query,
    expected,
    expectedTests,
    unindexed,
    added: changes.added,
    ignored: changes.ignored,
    ranked: ranked.slice(0, k),
    missed: needed.filter((file) => !pack.includes(file)),
    metrics,
    hitAtK: metrics.hits > 0,
    packRecall: needed.length === 0 ? null : found.length / needed.length,
    error,
  };
}

/**
 * Write the parent's tracked files into `dest`. `git archive` reads the object
 * store only, so the inspected checkout, its index and its worktree list are
 * untouched.
 * @param {string} root
 * @param {string} sha
 * @param {string} dest
 * @param {string} temp
 */
function exportTree(root, sha, dest, temp) {
  const archive = path.join(temp, "tree.tar");
  git(root, ["archive", "--format=tar", "-o", archive, sha]);
  fs.mkdirSync(dest);
  const result = runCommand("tar", ["-xf", archive, "-C", dest], { timeout: GIT_TIMEOUT_MS });
  if (!result.ok) throw new Error(`tar -xf failed: ${result.stderr.trim() || result.error?.message || result.status}`);
  fs.rmSync(archive, { force: true });
}

/**
 * Non-merge commits reachable from `head`, newest first, with their first
 * parent.
 * @param {string} root
 * @param {string} head
 * @param {number} max
 * @returns {HistoryCommit[]}
 */
function listCommits(root, head, max) {
  const output = git(root, ["log", "--no-merges", `--max-count=${max}`, "--format=%H%x00%P%x00%an <%ae>%x00%s%x1e", head]);
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, parents, author, subject] = record.split("\0");
      return { sha, parent: (parents ?? "").split(" ")[0] ?? "", author: author ?? "", subject: subject ?? "" };
    });
}

/**
 * @param {Record<string, any>[]} cases
 * @param {number} k
 */
function aggregate(cases, k) {
  const scored = cases.filter((c) => !c.error && c.metrics.recallAtK !== null);
  /** @param {(c: Record<string, any>) => number} selector */
  const avg = (selector) => (scored.length === 0 ? 0 : round3(scored.reduce((sum, c) => sum + selector(c), 0) / scored.length));
  const expected = cases.reduce((sum, c) => sum + c.expected.length + c.expectedTests.length + c.unindexed.length, 0);
  const unindexed = cases.reduce((sum, c) => sum + c.unindexed.length, 0);
  return {
    k,
    cases: cases.length,
    scoredCases: scored.length,
    errors: cases.filter((c) => c.error).length,
    hitAtK: avg((c) => (c.hitAtK ? 1 : 0)),
    rAtK: avg((c) => c.metrics.recallAtK ?? 0),
    pAtK: avg((c) => c.metrics.precisionAtK ?? 0),
    mrr: avg((c) => c.metrics.mrr ?? 0),
    packRecall: avg((c) => c.packRecall ?? 0),
    unindexedShare: expected === 0 ? 0 : round3(unindexed / expected),
  };
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatHistoryEvalMarkdown(data) {
  const s = data.scoreboard;
  const skipped = Object.entries(data.counts.skipped);
  const misses = data.cases.filter((/** @type {Record<string, any>} */ c) => c.error || (c.metrics.recallAtK !== null && !c.hitAtK));
  const unindexed = data.cases.flatMap((/** @type {Record<string, any>} */ c) => c.unindexed);
  const lines = [
    "# solumbe History Replay Eval",
    "",
    `Generated: ${data.generatedAt}`,
    `Repository: ${data.repo.name} (${data.repo.root}) at ${String(data.repo.head).slice(0, 12)}`,
    `Commits scored: ${data.counts.scored} of ${data.counts.requested} requested; k: ${data.k}; at most ${data.maxFiles} changed files per commit`,
    "",
    "Each commit's subject is the request and the files it changed are the expected files. The pack is built on the parent tree. A measurement, not a gate: it has no thresholds.",
    "",
    "## Scoreboard",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| hit@${data.k} (any changed file in the top ${data.k}) | ${s.hitAtK} |`,
    `| recall@${data.k} | ${s.rAtK} |`,
    `| precision@${data.k} | ${s.pAtK} |`,
    `| MRR | ${s.mrr} |`,
    `| pack recall (primary, related or tests) | ${s.packRecall} |`,
    `| changed files the code map does not index | ${s.unindexedShare} |`,
    "",
    `Scored ${s.scoredCases} of ${s.cases} cases${s.errors ? `; ${s.errors} errored` : ""}.`,
    "",
    "## Skipped commits",
    "",
    ...(skipped.length ? skipped.map(([reason, count]) => `- ${reason}: ${count}`) : ["- none"]),
    "",
    "## Commits",
    "",
    `| Commit | Request | Expected | r@${data.k} | MRR | Pack recall |`,
    "|---|---|---:|---:|---:|---:|",
    ...data.cases.map(
      (/** @type {Record<string, any>} */ c) =>
        `| ${c.sha.slice(0, 7)} | ${escapeCell(c.query)} | ${c.expected.length} | ${fmt(c.metrics.recallAtK)} | ${fmt(c.metrics.mrr)} | ${fmt(c.packRecall)} |`,
    ),
    "",
    `## Misses (no changed file in the top ${data.k})`,
    "",
    ...(misses.length
      ? misses.map(
          (/** @type {Record<string, any>} */ c) =>
            `- ${c.sha.slice(0, 7)} "${c.query}": ${c.error ? `error: ${c.error}` : `expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.ranked)}`}`,
        )
      : ["- none"]),
    "",
    "## Changed files the code map does not index",
    "",
    ...(unindexed.length ? [...new Set(unindexed)].sort().map((file) => `- ${file}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

/**
 * @param {number|null} value
 */
function fmt(value) {
  return value === null || value === undefined ? "-" : String(round3(value));
}

/**
 * @param {string} text
 */
function escapeCell(text) {
  return text.replace(/\|/g, "\\|");
}

/**
 * @param {number} value
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  const result = runCommand("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 * 64 });
  if (!result.ok) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
}

/**
 * @param {string} target
 */
function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp dir is harmless.
  }
}
