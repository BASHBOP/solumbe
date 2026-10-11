// solumbe intent: the scope contract.
//
// Convergence scores a diff against the files a request predicts, but it makes
// the prediction after the edit, from the tree the edit produced. A contract
// makes it before. `declareIntent` turns a request into the files it is
// expected to touch and freezes them in a record; the gate then holds the diff
// against that record. A changed file is declared, implied by a declared file
// under one of convergence's named rules, named in an amendment that gives a
// reason, or it was never declared and the contract fails.
//
// The record is identity, not a timestamp: `contractHash` covers the request,
// the commit it was declared at and the declared files, and each amendment
// hashes the one before it, so a later edit to any of them is evident.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateImpact, pathScopeTokens, scopeTokens } from "./impact.js";
import { runCommand } from "./tools.js";

export const INTENT_SCHEMA = "solumbe.intent/v1";

/** Where the command line keeps the declared intent unless told otherwise. */
export const DEFAULT_INTENT_PATH = ".solumbe/intent.json";

/**
 * @typedef {{ seq: number, files: string[], reason: string, amendedAt?: string, prevHash: string, hash: string }} IntentAmendment
 * @typedef {{
 *   schema: string,
 *   request: string,
 *   repo: { name: string },
 *   declaredAt?: string,
 *   head: string | null,
 *   impactEngineVersion: string | number | null,
 *   grounded: boolean,
 *   declared: { owners: string[], supporting: string[], terms?: string[], modules?: string[] },
 *   dirtyAtDeclaration: string[],
 *   amendments: IntentAmendment[],
 *   contractHash: string,
 * }} Intent
 */

/**
 * Declare what a request is expected to touch, before the edit.
 * @param {string} request
 * @param {{ path?: string, top?: number, now?: () => Date }} [options]
 * @returns {Intent}
 */
export function declareIntent(request, options = {}) {
  const task = String(request ?? "").trim();
  if (!task) throw new Error('declare requires a request, e.g. `solumbe declare "add Stripe refunds"`');
  const root = intentRoot(options.path ?? ".");
  return intentFromImpact(generateImpact(task, { path: root, top: options.top ?? 10 }).data, { now: options.now });
}

/**
 * The Git repository an intent is declared in and read from.
 * @param {string} repoPath
 * @returns {string}
 */
export function intentRoot(repoPath) {
  const root = gitText(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error("a declared intent needs a Git repository");
  return root;
}

/**
 * Freeze an impact prediction that has already been made, so a caller that
 * ranked the request once does not rank it again to declare it.
 * @param {any} impact the `data` of `generateImpact`
 * @param {{ now?: () => Date }} [options]
 * @returns {Intent}
 */
export function intentFromImpact(impact, options = {}) {
  const task = String(impact?.query ?? "").trim();
  if (!task) throw new Error("an intent is declared from a request");
  const root = intentRoot(impact.repo?.root ?? ".");
  const owners = sortedUnique(impact.classifications?.requiredOwners ?? []);
  const ownerSet = new Set(owners);
  const supporting = sortedUnique(impact.classifications?.supportingFiles ?? []).filter((file) => !ownerSet.has(file));

  /** @type {Intent} */
  const intent = {
    schema: INTENT_SCHEMA,
    request: task,
    repo: { name: impact.repo?.name ?? path.basename(root) },
    declaredAt: (options.now?.() ?? new Date()).toISOString(),
    head: gitText(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) || null,
    impactEngineVersion: impact.impactEngineVersion ?? null,
    grounded: owners.length > 0,
    // `terms` are the request's own words that name only a small part of the
    // repository: a changed file whose path carries one is in scope, which is
    // how `hubspot:` covers `docs/hubspot-crm-sync.md` and a module that does
    // not exist yet.
    // `modules` are the directories the request names outright: `user:` is
    // `src/user/`, however many paths carry the word.
    declared: { owners, supporting, ...requestScope(task, trackedFiles(root)) },
    // Files that already differed from HEAD when the intent was declared. A
    // contract written after the edit began says so.
    dirtyAtDeclaration: changedSinceHead(root),
    amendments: [],
    contractHash: "",
  };
  intent.contractHash = contractHashOf(intent);
  return intent;
}

/**
 * Add files to a declared intent, with the reason they belong to the change.
 * Returns a new record; the one passed in is left as it was.
 * @param {Intent} intent
 * @param {string[]} files
 * @param {string} reason
 * @param {{ now?: () => Date }} [options]
 * @returns {Intent}
 */
export function amendIntent(intent, files, reason, options = {}) {
  const verified = verifyIntent(intent);
  if (!verified.ok) throw new Error(`cannot amend an intent that does not verify: ${verified.error}`);
  const why = String(reason ?? "").trim();
  if (!why) throw new Error('an amendment needs a reason, e.g. `--reason "session expiry is read by the new refund flow"`');
  const named = sortedUnique((files ?? []).map(normalizeRepoPath));
  if (named.length === 0) throw new Error("an amendment needs at least one file");

  const seq = intent.amendments.length + 1;
  const prevHash = verified.tip;
  /** @type {IntentAmendment} */
  const amendment = {
    seq,
    files: named,
    reason: why,
    amendedAt: (options.now?.() ?? new Date()).toISOString(),
    prevHash,
    hash: amendmentHashOf(prevHash, { seq, files: named, reason: why }),
  };
  return { ...intent, amendments: [...intent.amendments, amendment] };
}

/**
 * Recompute the contract hash and the amendment chain.
 * @param {any} intent
 * @returns {{ ok: true, tip: string } | { ok: false, error: string, tip: null }}
 */
export function verifyIntent(intent) {
  /** @param {string} error @returns {{ ok: false, error: string, tip: null }} */
  const fail = (error) => ({ ok: false, error, tip: null });
  if (!intent || typeof intent !== "object") return fail("it is not an intent record");
  if (intent.schema !== INTENT_SCHEMA) return fail(`its schema is ${JSON.stringify(intent.schema ?? null)}, not ${INTENT_SCHEMA}`);
  if (typeof intent.request !== "string" || !intent.request.trim()) return fail("it carries no request");
  if (!isFileList(intent.declared?.owners) || !isFileList(intent.declared?.supporting) || !isFileList(intent.dirtyAtDeclaration)) {
    return fail("its declared files are not lists of repository paths");
  }
  if (intent.declared.terms !== undefined && !isFileList(intent.declared.terms)) {
    return fail("its scope words are not a list of words");
  }
  if (intent.declared.modules !== undefined && !isFileList(intent.declared.modules)) {
    return fail("its named modules are not a list of directories");
  }
  if (!Array.isArray(intent.amendments)) return fail("its amendments are not a list");
  if (contractHashOf(intent) !== intent.contractHash) {
    return fail("the request, commit or declared files were changed after it was declared (contract hash mismatch)");
  }
  let tip = String(intent.contractHash);
  for (const [index, amendment] of intent.amendments.entries()) {
    const seq = index + 1;
    if (!amendment || typeof amendment !== "object" || amendment.seq !== seq || !isFileList(amendment.files) || amendment.files.length === 0) {
      return fail(`amendment ${seq} is malformed`);
    }
    if (typeof amendment.reason !== "string" || !amendment.reason.trim()) return fail(`amendment ${seq} gives no reason`);
    if (amendment.prevHash !== tip || amendment.hash !== amendmentHashOf(tip, amendment)) {
      return fail(`amendment ${seq} was altered, removed or reordered (amendment hash mismatch)`);
    }
    tip = amendment.hash;
  }
  return { ok: true, tip };
}

/**
 * The files a verified intent covers, as convergence reads a prediction:
 * declared owners, everything else the contract names, and which amendment
 * named a file.
 * @param {Intent} intent
 * @param {string} tip the verified tip hash, bound into the convergence receipt
 * @returns {{ tip: string, owners: string[], related: string[], terms: string[], modules: string[], amended: Map<string, { seq: number, reason: string }> }}
 */
export function declaredScope(intent, tip) {
  const owners = new Set(intent.declared.owners);
  /** @type {Map<string, { seq: number, reason: string }>} */
  const amended = new Map();
  for (const amendment of intent.amendments) {
    for (const file of amendment.files) {
      if (!amended.has(file)) amended.set(file, { seq: amendment.seq, reason: amendment.reason });
    }
  }
  const related = sortedUnique([...intent.declared.supporting, ...amended.keys()]).filter((file) => !owners.has(file));
  return { tip, owners: [...owners].sort(), related, terms: [...(intent.declared.terms ?? [])], modules: [...(intent.declared.modules ?? [])], amended };
}

/**
 * Read an intent from a record, a JSON string, or a path relative to the
 * repository root.
 * @param {string} root
 * @param {unknown} value
 * @returns {Intent}
 */
export function readIntent(root, value) {
  if (value && typeof value === "object") return /** @type {Intent} */ (value);
  const text = String(value ?? "").trim();
  if (!text) throw new Error("no intent was supplied");
  let raw = text;
  if (!text.startsWith("{")) {
    const file = path.resolve(root, text);
    if (!fs.existsSync(file)) throw new Error(`no intent file at ${text}; declare one with \`solumbe declare "<request>"\``);
    raw = fs.readFileSync(file, "utf8");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("the intent is not valid JSON");
  }
}

/**
 * @param {string} root
 * @param {Intent} intent
 * @param {string} [out]
 * @returns {string} the path written
 */
export function writeIntent(root, intent, out = DEFAULT_INTENT_PATH) {
  const file = path.resolve(root, out);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(intent, null, 2)}\n`);
  return file;
}

/**
 * @param {Intent} intent
 * @returns {string}
 */
export function formatIntentMarkdown(intent) {
  const verified = verifyIntent(intent);
  const list = (/** @type {string[]} */ items) => (items.length ? items.map((item) => `\`${item}\``).join(", ") : "none");
  const lines = [
    "# Declared intent",
    "",
    `Request: "${intent.request}"`,
    `Repo: ${intent.repo?.name ?? ""}`,
    `Declared at commit: ${intent.head ?? "no commit yet"}`,
    `Contract: ${verified.ok ? verified.tip : `does not verify (${verified.error})`}`,
    "",
    "## Declared files",
    "",
    `- Owners: ${list(intent.declared.owners)}`,
    `- Supporting: ${list(intent.declared.supporting)}`,
    ...(intent.declared.modules?.length ? [`- Modules the request names: ${list(intent.declared.modules)}`] : []),
    ...(intent.declared.terms?.length ? [`- Scope words (a changed path carrying one is in scope): ${list(intent.declared.terms)}`] : []),
  ];
  if (!intent.grounded) {
    lines.push(
      "",
      'The request predicted no owner file, so the contract declares nothing yet. Name the files or symbols in the request and declare again, or add files with `solumbe amend <file> --reason "<why>"`.',
    );
  }
  if (intent.dirtyAtDeclaration.length) {
    lines.push("", `Already changed when this was declared: ${list(intent.dirtyAtDeclaration)}`);
  }
  if (intent.amendments.length) {
    lines.push("", "## Amendments", "");
    for (const amendment of intent.amendments) lines.push(`- #${amendment.seq} ${list(amendment.files)}: ${amendment.reason}`);
  }
  return lines.join("\n");
}

/** @param {any} intent @returns {string} */
function contractHashOf(intent) {
  return sha256(
    JSON.stringify({
      schema: intent.schema,
      request: intent.request,
      head: intent.head ?? null,
      impactEngineVersion: intent.impactEngineVersion ?? null,
      owners: [...intent.declared.owners].sort(),
      supporting: [...intent.declared.supporting].sort(),
      dirtyAtDeclaration: [...intent.dirtyAtDeclaration].sort(),
      // Present only when the record carries scope words, so one declared
      // before they existed hashes as it did.
      ...(Array.isArray(intent.declared.terms) ? { terms: [...intent.declared.terms].sort() } : {}),
      ...(Array.isArray(intent.declared.modules) ? { modules: [...intent.declared.modules].sort() } : {}),
    }),
  );
}

/**
 * @param {string} prevHash
 * @param {{ seq: number, files: string[], reason: string }} amendment
 * @returns {string}
 */
function amendmentHashOf(prevHash, amendment) {
  return sha256(prevHash + JSON.stringify({ seq: amendment.seq, files: [...amendment.files].sort(), reason: amendment.reason }));
}

/** @param {string} text @returns {string} */
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** @param {unknown} value @returns {value is string[]} */
function isFileList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

/** @param {string[]} items @returns {string[]} */
function sortedUnique(items) {
  return [...new Set(items)].sort();
}

/**
 * A repository-relative path with forward slashes, refusing anything that
 * points outside the repository.
 * @param {string} file
 * @returns {string}
 */
function normalizeRepoPath(file) {
  const text = String(file ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (!text || path.posix.isAbsolute(text) || /^[A-Za-z]:\//.test(text) || text.split("/").includes("..")) {
    throw new Error(`an amendment names files by repository path, not ${JSON.stringify(file)}`);
  }
  return path.posix.normalize(text);
}

// A word names part of a repository when few paths carry it. `event` in an
// events platform is on hundreds of paths and scopes nothing; `hubspot` is on
// a dozen. A word no path carries yet is kept: it names what the change adds.
const SCOPE_TERM_MAX_FILES = 20;
const SCOPE_TERM_MAX_SHARE = 0.03;

// A directory the request names is a module however many files it holds, but
// not when it is most of the repository, or a name every tree has.
const MODULE_MAX_SHARE = 0.2;
const MODULE_MAX_NAMED = 6;
const TREE_NAMES = new Set(["app", "bin", "build", "dist", "lib", "main", "node_modules", "out", "packages", "pkg", "public", "src", "test", "tests"]);
// The same names as words: `src` in a request scopes nothing either.
const TREE_WORDS = new Set([...TREE_NAMES].filter((name) => /^[a-z]+$/.test(name)).flatMap((name) => scopeTokens(name)));

/**
 * What the request's own words scope: `terms`, the words few tracked paths
 * carry, and `modules`, the directories named for one of its words. A tree
 * name, a file extension and a tracked path written in the request are none
 * of them words about the change.
 * @param {string} request
 * @param {string[]} files
 * @returns {{ terms: string[], modules: string[] }}
 */
function requestScope(request, files) {
  // A tracked path written out in the request names that file, which the
  // prediction holds. Its directories are not words about the change: "update
  // greet in src/index.ts" does not scope every `index` under `src`.
  const tracked = new Set(files);
  const prose = String(request)
    .split(/\s+/)
    .filter((word) => !tracked.has(word.replace(/^[`'"(<]+|[`'")>,.:;]+$/g, "").replace(/^\.\//, "")))
    .join(" ");
  const words = scopeTokens(prose).filter((word) => !TREE_WORDS.has(word));
  if (words.length === 0) return { terms: [], modules: [] };
  const wanted = new Set(words);
  /** @type {Map<string, number>} */
  const carried = new Map(words.map((word) => [word, 0]));
  /** @type {Map<string, number>} */
  const directories = new Map();
  /** @type {Set<string>} */
  const extensions = new Set();
  for (const file of files) {
    for (const token of new Set(pathScopeTokens(file))) {
      if (carried.has(token)) carried.set(token, /** @type {number} */ (carried.get(token)) + 1);
    }
    for (const token of scopeTokens(path.posix.extname(file))) extensions.add(token);
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join("/");
      directories.set(directory, (directories.get(directory) ?? 0) + 1);
    }
  }
  const limit = Math.max(SCOPE_TERM_MAX_FILES, Math.ceil(files.length * SCOPE_TERM_MAX_SHARE));
  // `ts` is on no path as a word, and is not a word the change will add.
  const terms = words
    .filter((word) => {
      const paths = /** @type {number} */ (carried.get(word));
      return paths <= limit && !(paths === 0 && extensions.has(word));
    })
    .sort();

  const modules = [...directories.entries()]
    .filter(([directory, held]) => {
      const name = path.posix.basename(directory).toLowerCase();
      if (TREE_NAMES.has(name) || name.startsWith(".") || held > files.length * MODULE_MAX_SHARE) return false;
      const tokens = scopeTokens(name);
      // The whole name is the word: `user` names `src/user`, not `src/user-settings`.
      return tokens.length > 0 && tokens.some((token) => wanted.has(token)) && scopeTokens(name.replace(/[^a-z0-9]+/gi, "")).some((token) => wanted.has(token));
    })
    .map(([directory]) => directory)
    // A module inside a named module adds nothing.
    .filter((directory, _index, all) => !all.some((other) => other !== directory && directory.startsWith(`${other}/`)))
    .sort();
  return { terms, modules: modules.length <= MODULE_MAX_NAMED ? modules : [] };
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function trackedFiles(root) {
  const result = runCommand("git", ["ls-files", "-z"], { cwd: root });
  return result.ok ? String(result.stdout).split("\0").filter(Boolean) : [];
}

/**
 * Tracked files that differ from HEAD, staged or not.
 * @param {string} root
 * @returns {string[]}
 */
function changedSinceHead(root) {
  const unstaged = gitText(root, ["diff", "--name-only", "--relative", "--"]);
  const staged = gitText(root, ["diff", "--cached", "--name-only", "--relative", "--"]);
  return sortedUnique(`${unstaged}\n${staged}`.split("\n").filter(Boolean));
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitText(cwd, args) {
  const result = runCommand("git", args, { cwd });
  return result.ok ? String(result.stdout ?? "").trim() : "";
}
