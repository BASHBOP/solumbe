// Local merge-readiness gate ported from pullpass/internal/local/evaluate.go.
// Given a repo + base ref, runs a battery of deterministic checks (changed
// files, secret safety, risk review, release discipline, validation commands,
// dependency audit hint, review-state placeholder) and rolls them up into a
// single PASS/WARN/FAIL verdict.

/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCommand } from "./tools.js";
import { matchRiskPaths, matchSecretPaths, classifyPath, glyphFor } from "./risk-paths.js";
import { MAX_SCAN_BYTES, scanSecretContent, summarizeSecretFindings } from "./secret-scan.js";
import { checkRelease } from "./release-check.js";
import { aggregateVerdict, normalizeGovernance, normalizeProfile, policyCheck, STATUS } from "./policy.js";
import { estimateTokens } from "./tokens.js";
import { captureCommitSubject, captureStagedSubject, generateConvergence, INCONCLUSIVE_BAND } from "./converge.js";
import { executeValidationPlan } from "./validation-attestation.js";

/**
 * A single check produced by the local/PR merge-readiness gates.
 * @typedef {Object} Check
 * @property {string} name
 * @property {CheckStatus} status
 * @property {string} summary
 * @property {string[]} [details]
 * @property {number} [convergence]
 * @property {string} [band]
 * @property {Record<string, any>} [receipt]
 * @property {Record<string, any>} [subject]
 * @property {import("./validation-attestation.js").OutputExcerpt[]} [excerpts]
 */

/**
 * Rolled-up gate result. Mirrors the STATUS values from policy.js.
 * @typedef {"PASS" | "WARN" | "FAIL"} Verdict
 */

/**
 * Status of one check. SKIPPED means the check cannot be evaluated in this
 * mode (a local run has no PR to review); it never changes the verdict.
 * @typedef {Verdict | "SKIPPED"} CheckStatus
 */

const passEngineVersion = 2;

/** Sentinel for a blob that exists but is too large to scan. */
const OVERSIZED = "\u0000solumbe:oversized";

/** Ceiling on one batched `git cat-file` read of a whole changed-file set. */
const MAX_BATCH_BYTES = 256 * 1024 * 1024;

/** Stop collecting once a change is this obviously compromised. */
const MAX_FINDINGS = 40;

/**
 * @param {string} repoPath
 * @param {{ policy?: unknown, governance?: unknown, base?: string, head?: string, request?: string, minConvergence?: number | string, receipt?: string, staged?: boolean, runValidation?: boolean, analyzers?: boolean }} [options]
 */
export function evaluateLocal(repoPath, options = {}) {
  const profile = normalizeProfile(options.policy);
  const governance = normalizeGovernance(options.governance);

  const root = gitRoot(repoPath);
  const base = options.base ?? defaultBase(root);
  const staged = Boolean(options.staged);
  const head = String(options.head ?? "").trim();
  if (staged && head) throw new Error("the local gate evaluates either --head <ref> or --staged, not both");
  /** @type {"staged" | "commit" | "working-tree"} */
  const scope = staged ? "staged" : head ? "commit" : "working-tree";
  let files;
  let subject = null;
  let subjectError = "";
  if (scope !== "working-tree") {
    try {
      const captured = head ? captureCommitSubject(root, base, head) : captureStagedSubject(root, base);
      subject = captured.subject;
      files = captured.changedFiles;
    } catch (/** @type {any} */ error) {
      subjectError = error.message ?? String(error);
      // A head that does not resolve has no change to list; staged mode can
      // still fall back to the index's path list.
      files = head ? [] : changedFiles(root, base, { staged: true });
    }
  } else {
    files = changedFiles(root, base);
  }

  /** @param {string} file */
  const baseContent = (file) => gitShowContent(root, subject?.baseSha ?? base, file);
  // Secret scanning reads the exact subject: the staged or head commit tree
  // when the gate has one, the working tree otherwise. It must never fall back
  // to the base commit — the credential being introduced is only in the change.
  const subjectContent = subject?.treeSha
    ? treeContentReader(root, String(subject.treeSha), files)
    : (/** @type {string} */ file) => readWorkingTreeFile(root, file);
  // Release discipline reads the version from the exact subject too. Reading it
  // from the working tree compared a historic base against whatever the
  // checkout contained and flagged every package.json edit as a version bump.
  const releaseHead = subject?.treeSha ? (/** @type {string} */ file) => gitShowContent(root, String(subject.treeSha), file) : undefined;
  const validationExecution = options.runValidation ? executeValidationPlan({ root, subject }) : null;
  const checks = [
    changedFilesCheck(files),
    ...(scope !== "working-tree" ? [changeSubjectCheck(scope, subject, subjectError)] : []),
    secretCheck(files, subjectContent),
    riskCheck(files, scope),
    ...migrationCheck(files, subjectContent),
    checkRelease(root, files, {
      baseContent,
      headContent: releaseHead,
      governance,
      headRefName: scope === "commit" ? undefined : currentBranch(root),
    }),
    validationCommandsCheck(root),
    ...(validationExecution ? [{ name: "Validation execution", ...validationExecution }] : []),
  ];
  const audit = dependencyAuditCheck(root);
  if (audit) checks.push(audit);
  // The optional analyzers run an installed tool against the tree. A replay
  // over historical trees (`solumbe calibrate --gate`) passes `analyzers: false`
  // so that checking out an old commit runs nothing.
  if (options.analyzers !== false) {
    const drift = contractDriftCheck(root);
    if (drift) checks.push(drift);
    const compliance = complianceControlsCheck(root);
    if (compliance) checks.push(compliance);
    const aiGovernance = aiGovernanceCheck(root);
    if (aiGovernance) checks.push(aiGovernance);
  }
  const convergence = convergenceCheck(root, base, options.request, options.minConvergence, options.receipt, {
    staged,
    subject,
    subjectError,
    diffFiles: scope !== "working-tree" ? files : undefined,
  });
  if (convergence) checks.push(convergence);
  checks.push(localReviewCheck({ staged }));
  checks.push(policyCheck({ profile, governance, files, checks, remote: false }));

  const verdict = aggregateVerdict(checks);

  /** @type {Record<string, unknown> & { tokenEstimate?: { fullJson: number } }} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    passEngineVersion,
    verdict,
    repo: { root, name: path.basename(root) },
    base,
    ...(head ? { head } : {}),
    scope,
    request: options.request ?? "",
    policy: profile,
    governance,
    changedFiles: files,
    contextEvidence: contextEvidence(base, options.request),
    checks,
  };
  if (subject) data.subject = subject;
  if (convergence?.receipt) {
    data.convergence = convergence.convergence;
    data.band = convergence.band;
    data.receipt = convergence.receipt;
  }
  if (validationExecution?.evidence) data.validationEvidence = validationExecution.evidence;
  data.tokenEstimate = { fullJson: estimateTokens(data) };
  return data;
}

/**
 * Optionally make the deterministic convergence score load-bearing. The check
 * is opt-in so existing gates retain their current behaviour until a task owner
 * supplies a threshold and/or receipt.
 *
 * @param {string} root
 * @param {string | null} base
 * @param {string | undefined} request
 * @param {number | string | undefined} minConvergence
 * @param {string | undefined} receipt
 * @param {{ staged?: boolean, subject?: Record<string, unknown> | null, subjectError?: string, diffFiles?: string[], expectedHead?: string, requireClean?: boolean }} [options]
 * @returns {Check | null}
 */
export function convergenceCheck(root, base, request, minConvergence, receipt, options = {}) {
  const hasThreshold = minConvergence !== undefined && minConvergence !== null && String(minConvergence).trim() !== "";
  const receiptValue = typeof receipt === "string" ? receipt.trim() : "";
  if (!hasThreshold && !receiptValue) return null;

  const task = String(request ?? "").trim();
  if (!task) {
    return { name: "Convergence", status: STATUS.fail, summary: "A task request is required when convergence enforcement is enabled." };
  }
  if (!base) {
    return { name: "Convergence", status: STATUS.fail, summary: "A locally available base ref is required to verify convergence." };
  }
  if (options.subjectError) {
    return { name: "Convergence", status: STATUS.fail, summary: `Could not identify the exact change subject: ${options.subjectError}` };
  }

  const checkoutMismatch = exactCheckoutFailure(root, options.expectedHead, options.requireClean);
  if (checkoutMismatch) return checkoutMismatch;

  const threshold = hasThreshold ? Number(minConvergence) : undefined;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 100)) {
    return { name: "Convergence", status: STATUS.fail, summary: "Minimum convergence must be a number from 0 to 100." };
  }

  let data;
  try {
    data = generateConvergence(task, {
      path: root,
      base,
      staged: options.staged,
      subject: options.subject ?? undefined,
      diffFiles: options.diffFiles,
    });
  } catch (/** @type {any} */ error) {
    return { name: "Convergence", status: STATUS.fail, summary: `Could not compute convergence: ${error.message ?? String(error)}` };
  }

  // A request that predicted no owner file has no score to hold against the
  // minimum. That is reported as its own outcome below, not as a failed score:
  // the same request scores the same whether the change is right or wrong. A
  // minimum of 0 asks for no score, so only a positive one goes unenforced.
  const inconclusive = data.band === INCONCLUSIVE_BAND;
  const unenforced = inconclusive && threshold !== undefined && threshold > 0;
  const failures = [];
  if (threshold !== undefined && !inconclusive && data.convergence < threshold) {
    failures.push(`score ${data.convergence}/100 is below the required minimum of ${threshold}`);
  }
  if (receiptValue) {
    const { value: supplied, subject: suppliedSubject } = readReceiptValue(root, receiptValue);
    const exactSubjectReceipt = data.receipt.receiptVersion === 2;
    const matches =
      supplied && (exactSubjectReceipt ? supplied === data.receipt.inputsHash : supplied === data.receipt.id || supplied === data.receipt.inputsHash);
    if (!matches) {
      failures.push(
        exactSubjectReceipt && supplied === data.receipt.id
          ? "exact-subject receipt enforcement requires the full inputs hash, not the abbreviated display ID"
          : suppliedSubject && !sameSubjectMode(suppliedSubject, data.subject)
            ? `supplied receipt is bound to ${describeSubject(suppliedSubject)} but the gate measured ${data.subject ? describeSubject(data.subject) : "the working tree"}; ${rerunHint(suppliedSubject)}`
            : "supplied receipt does not match the recomputed receipt for this task, base, and exact change subject",
      );
    }
  }

  const details = [inconclusive ? "Score: not measured (inconclusive)" : `Score: ${data.convergence}/100 (${data.band})`, `Receipt handle: ${data.receipt.id}`];
  if (data.receipt.receiptVersion === 2) details.push(`Inputs hash: ${data.receipt.inputsHash}`);
  if (data.subject?.treeSha) details.push(`Subject tree: ${data.subject.treeSha}`);
  if (data.subject?.baseSha) details.push(`Base commit: ${data.subject.baseSha}`);
  if (data.subject?.parentSha) details.push(`Parent commit: ${data.subject.parentSha}`);
  if (data.subject?.headSha) details.push(`Head commit: ${data.subject.headSha}`);
  if (threshold !== undefined) details.push(`Minimum: ${threshold}`);
  if (receiptValue) details.push(`Supplied receipt: ${receiptValue}`);
  const evidence = { convergence: data.convergence, band: data.band, receipt: data.receipt, subject: data.subject };
  if (failures.length > 0) {
    return { name: "Convergence", status: STATUS.fail, summary: `Convergence enforcement failed: ${failures.join("; ")}.`, details, ...evidence };
  }
  if (unenforced) {
    return {
      name: "Convergence",
      status: STATUS.warn,
      summary: `Convergence is inconclusive: the request did not ground to any predicted owner file, so there is no score to hold against the minimum of ${threshold}. Rephrase it to name the files, symbols or feature it changes, or run \`solumbe impact\` to check grounding.`,
      details,
      ...evidence,
    };
  }
  return { name: "Convergence", status: STATUS.pass, summary: "Task and diff satisfy the convergence requirement.", details, ...evidence };
}

/**
 * Whether two exact subjects describe the same kind of change and, for a
 * commit or PR, the same head. A receipt for another mode or head cannot
 * match, so the gate says which mode to rerun in instead of reporting a
 * bare hash mismatch.
 * @param {Record<string, any>} supplied
 * @param {Record<string, any> | undefined} measured
 * @returns {boolean}
 */
function sameSubjectMode(supplied, measured) {
  if (!measured || supplied.kind !== measured.kind) return false;
  if (supplied.kind === "git-index") return true;
  return String(supplied.headSha ?? "").toLowerCase() === String(measured.headSha ?? "").toLowerCase();
}

/** @param {Record<string, any>} subject @returns {string} */
function describeSubject(subject) {
  if (subject.kind === "git-index") return "a staged Git index tree";
  if (subject.kind === "git-commit") return `head commit ${subject.headSha}`;
  if (subject.kind === "github-pr") return `GitHub PR ${subject.repository ?? ""}#${subject.number ?? "?"} at ${subject.headSha}`;
  return `a ${String(subject.kind ?? "unknown")} subject`;
}

/** @param {Record<string, any>} subject @returns {string} */
function rerunHint(subject) {
  if (subject.kind === "git-index") return "rerun the gate with --staged";
  if (subject.kind === "git-commit") return `rerun the gate with --head ${subject.headSha} and the receipt's base`;
  if (subject.kind === "github-pr") return `rerun the gate with --pr ${subject.number ?? "<number>"}`;
  return "rerun the gate in the mode that produced the receipt";
}

/**
 * @param {"staged" | "commit"} scope
 * @param {Record<string, any> | null} subject
 * @param {string} error
 * @returns {Check}
 */
function changeSubjectCheck(scope, subject, error) {
  const commit = scope === "commit";
  const name = commit ? "Commit snapshot" : "Staged snapshot";
  if (!subject) {
    return {
      name,
      status: STATUS.fail,
      summary: `Could not identify the exact ${commit ? "head commit" : "staged Git tree"}: ${error || "unknown error"}`,
    };
  }
  return {
    name,
    status: STATUS.pass,
    summary: `Changed-file scope and convergence evidence are captured from the exact ${commit ? "head commit tree" : "staged Git tree"}.`,
    details: [
      `Tree: ${subject.treeSha}`,
      commit ? `Head: ${subject.headSha}` : `Parent: ${subject.parentSha}`,
      `Base: ${subject.baseSha}`,
      "Validation-command and optional analyzer checks still inspect the working tree and are not bound by this convergence receipt.",
    ],
  };
}

/**
 * PR convergence uses local analysis, so refuse to mix GitHub evidence with a
 * different or dirty checkout.
 * @param {string} root
 * @param {string | undefined} expectedHead
 * @param {boolean | undefined} requireClean
 * @returns {Check | null}
 */
function exactCheckoutFailure(root, expectedHead, requireClean) {
  const expected = String(expectedHead ?? "").trim();
  if (expected) {
    const head = runCommand("git", ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"], { cwd: root });
    const actual = head.ok ? head.stdout.trim() : "";
    if (!actual || actual !== expected) {
      return {
        name: "Convergence",
        status: STATUS.fail,
        summary: "Local convergence cannot run because the checkout is not the exact GitHub PR head.",
        details: [`Expected head: ${expected}`, `Local HEAD: ${actual || "unavailable"}`],
      };
    }
  }
  if (requireClean) {
    const status = runCommand("git", ["--no-replace-objects", "status", "--porcelain"], { cwd: root });
    if (!status.ok) {
      return { name: "Convergence", status: STATUS.fail, summary: "Could not verify that the PR checkout is clean." };
    }
    if (status.stdout.trim()) {
      return {
        name: "Convergence",
        status: STATUS.fail,
        summary: "Local convergence cannot run against a dirty PR checkout.",
        details: status.stdout.trim().split("\n").slice(0, 20),
      };
    }
  }
  return null;
}

/**
 * Accept a receipt id/hash directly, a JSON receipt object, or a path to a JSON
 * artifact produced from `solumbe converge --json`. A JSON receipt also yields
 * the exact subject it was bound to, when it has one.
 * @param {string} root
 * @param {string} value
 * @returns {{ value: string | null, subject: Record<string, any> | null }}
 */
function readReceiptValue(root, value) {
  let raw = value;
  const candidate = path.resolve(root, value);
  if (exists(candidate)) {
    try {
      raw = fs.readFileSync(candidate, "utf8").trim();
    } catch {
      return { value: null, subject: null };
    }
  }
  try {
    const parsed = JSON.parse(raw);
    const receipt = parsed?.receipt ?? parsed;
    const hash = typeof receipt?.inputsHash === "string" ? receipt.inputsHash : typeof receipt?.id === "string" ? receipt.id : null;
    const subject = receipt?.subject && typeof receipt.subject === "object" ? receipt.subject : null;
    return { value: hash, subject };
  } catch {
    return { value: raw || null, subject: null };
  }
}

/**
 * @param {string} root
 * @param {string} base
 * @param {{ staged?: boolean }} [options]
 * @returns {string[]}
 */
export function changedFiles(root, base, options = {}) {
  if (options.staged) {
    return runGit(root, ["diff", "--cached", "--name-only", "--relative", base, "--"]);
  }
  const tracked = runGit(root, ["diff", "--name-only", "--relative", base, "--"]);
  const staged = runGit(root, ["diff", "--cached", "--name-only", "--relative", "--"]);
  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard"]);
  const seen = new Set();
  for (const list of [tracked, staged, untracked]) {
    for (const file of list) if (file) seen.add(file);
  }
  return [...seen].sort();
}

/**
 * @param {string} repoPath
 * @returns {string}
 */
export function gitRoot(repoPath) {
  const lines = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
  if (lines.length === 0) throw new Error("not a git repository");
  return lines[0];
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string[]}
 */
function runGit(cwd, args) {
  const result = runCommand("git", args, { cwd });
  if (!result.ok) {
    const text = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")}: ${text || "command failed"}`);
  }
  return result.stdout
    .split("\n")
    .map((/** @type {string} */ line) => line.trim())
    .filter(Boolean);
}

// Content of `file` at the `base` ref, or null when the ref or path is absent.
// Non-throwing so release discipline can fall back to head-only inspection.
/**
 * @param {string} cwd
 * @param {string} base
 * @param {string} file
 * @returns {string | null}
 */
export function gitShowContent(cwd, base, file) {
  const result = runCommand("git", ["show", `${base}:${file}`], { cwd });
  return result.ok ? result.stdout : null;
}

/**
 * The checked-out branch, or undefined when HEAD is detached or unreadable.
 * @param {string} root
 * @returns {string | undefined}
 */
function currentBranch(root) {
  const result = runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  const name = result.ok ? result.stdout.trim() : "";
  return name || undefined;
}

/** @param {string} root */
function defaultBase(root) {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const probe = runCommand("git", ["rev-parse", "--verify", candidate], { cwd: root });
    if (probe.ok) return candidate;
  }
  return "HEAD";
}

/**
 * @param {string[]} files
 * @returns {Check}
 */
function changedFilesCheck(files) {
  if (files.length === 0) {
    return { name: "Changed files", status: STATUS.warn, summary: "No changed files found against the selected base." };
  }
  return {
    name: "Changed files",
    status: STATUS.pass,
    summary: `${files.length} changed file${files.length === 1 ? "" : "s"} found.`,
    details: files.slice(0, 20),
  };
}

/**
 * Secret safety has two independent halves: a credential-shaped *path* and a
 * credential-shaped *value*. The path half alone let a live key pasted into
 * ordinary source through, so the content half scans the exact changed blob.
 *
 * @param {string[]} files
 * @param {(file: string) => string | null} readContent
 * @returns {Check}
 */
export function secretCheck(files, readContent) {
  const matches = matchSecretPaths(files);
  const { findings, skipped, scanned } = scanChangedFilesForSecrets(files, readContent);
  const content = summarizeSecretFindings(findings);
  // A PR gate without the head commit fetched locally, or a tree read that
  // failed outright, yields no content at all. Reporting that as a clean scan
  // would be the same false assurance the path-only check used to give, so the
  // check says which half of it actually ran.
  const contentUnavailable = scanned === 0 && (files ?? []).length > 0;

  /** @type {string[]} */
  const details = [];
  if (matches.length) details.push(...matches.slice(0, 20));
  if (content.details.length) details.push(...content.details.slice(0, 20));
  if (skipped.length) details.push(`Not scanned (too large): ${skipped.slice(0, 5).join(", ")}`);

  if (matches.length || content.severity === "fail") {
    const reasons = [];
    if (matches.length) reasons.push("secret or environment file changed");
    if (content.severity === "fail") reasons.push("credential value found in changed content");
    return { name: "Secret safety", status: STATUS.fail, summary: `Potential ${reasons.join(" and ")}.`, details };
  }
  if (content.severity === "warn") {
    return {
      name: "Secret safety",
      status: STATUS.warn,
      summary: "A changed line assigns a high-entropy literal to a credential-shaped name.",
      details,
    };
  }
  if (contentUnavailable) {
    return {
      name: "Secret safety",
      status: STATUS.pass,
      summary: "No secret file paths found. Changed content was not available to scan for credential values.",
      details: details.length ? details : undefined,
    };
  }
  return {
    name: "Secret safety",
    status: STATUS.pass,
    summary: "No secret file paths and no credential values found in the changed content.",
    details: details.length ? details : undefined,
  };
}

/**
 * @param {string[]} files
 * @param {(file: string) => string | null} readContent
 * @returns {{ findings: import("./secret-scan.js").SecretFinding[], skipped: string[], scanned: number }}
 */
function scanChangedFilesForSecrets(files, readContent) {
  /** @type {import("./secret-scan.js").SecretFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const skipped = [];
  let scanned = 0;
  if (typeof readContent !== "function") return { findings, skipped, scanned };
  for (const file of files ?? []) {
    let text;
    try {
      text = readContent(file);
    } catch {
      text = null;
    }
    // A deleted file has no content in the subject tree; nothing to scan and
    // nothing to report.
    if (text === null || text === undefined) continue;
    if (text === OVERSIZED || text.length > MAX_SCAN_BYTES) {
      skipped.push(file);
      continue;
    }
    scanned += 1;
    findings.push(...scanSecretContent(text, { file }));
    if (findings.length >= MAX_FINDINGS) break;
  }
  return { findings, skipped, scanned };
}

/**
 * Read many blobs from one tree with a single `git cat-file --batch` process.
 *
 * One `git show` per changed file turned a 0.45s gate into a 10s gate on an
 * 800-file change; the cost is process spawns, not I/O. This reads every
 * changed blob in one pass and returns a plain lookup, so the scan stays
 * proportional to the diff rather than to the number of spawns.
 *
 * @param {string} root
 * @param {string} treeSha
 * @param {string[]} files
 * @returns {(file: string) => string | null}
 */
function treeContentReader(root, treeSha, files) {
  /** @type {Map<string, string>} */
  const blobs = new Map();
  const wanted = (files ?? []).filter((file) => typeof file === "string" && file.trim());
  if (wanted.length === 0) return () => null;

  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: wanted.map((file) => `${treeSha}:${file}`).join("\n") + "\n",
    maxBuffer: MAX_BATCH_BYTES,
    timeout: 120000,
  });
  // On any batch failure the caller sees "unreadable" for every file, which the
  // check reports as unscanned rather than as a clean scan.
  if (result.status !== 0 || !result.stdout) return () => null;

  const out = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout));
  let offset = 0;
  for (const file of wanted) {
    const newline = out.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = out.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    // `<oid> missing` / `<oid> <type> <size>` — a deleted path is simply absent.
    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (parts[1] !== "blob" || !Number.isFinite(size)) continue;
    if (size <= MAX_SCAN_BYTES) blobs.set(file, out.subarray(offset, offset + size).toString("utf8"));
    else blobs.set(file, OVERSIZED);
    // Git writes a trailing newline after each object's content.
    offset += size + 1;
  }
  return (file) => blobs.get(file) ?? null;
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string | null}
 */
function readWorkingTreeFile(root, file) {
  try {
    const resolved = path.resolve(root, file);
    // Never follow a changed path out of the repository root.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    // Read a bounded prefix only. Returning one byte over the cap is what tells
    // the caller to report the file as skipped rather than silently unscanned,
    // without ever pulling a large blob into memory.
    const limit = MAX_SCAN_BYTES + 1;
    if (stat.size > limit) {
      const handle = fs.openSync(resolved, "r");
      try {
        const buffer = Buffer.alloc(limit);
        const read = fs.readSync(handle, buffer, 0, limit, 0);
        return buffer.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(handle);
      }
    }
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
}

// Statements that change or remove data already in the database. A schema
// diff shows a migration exists; only its body shows that it resets every
// verified profile or drops a column of personal data.
const DATA_MUTATIONS = [
  { pattern: /\bUPDATE\s+("?[\w.]+"?)\s+SET\b/i, describe: (/** @type {string} */ table) => `rewrites existing rows in ${table}` },
  { pattern: /\bDELETE\s+FROM\s+("?[\w.]+"?)/i, describe: (/** @type {string} */ table) => `deletes rows from ${table}` },
  { pattern: /\bTRUNCATE\s+(?:TABLE\s+)?("?[\w.]+"?)/i, describe: (/** @type {string} */ table) => `empties ${table}` },
  { pattern: /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/i, describe: (/** @type {string} */ table) => `drops table ${table} and its data` },
  {
    pattern: /\bALTER\s+TABLE\s+("?[\w.]+"?)[\s\S]*?\bDROP\s+COLUMN\b/i,
    describe: (/** @type {string} */ table) => `drops columns of ${table} and their data`,
  },
];

/**
 * Warn when a changed SQL migration rewrites, deletes or drops existing data,
 * so a reviewer reads the migration body, not only its file name. Returns no
 * check when the change carries no SQL migration.
 * @param {string[]} files
 * @param {(file: string) => string | null} readContent
 * @returns {Check[]}
 */
export function migrationCheck(files, readContent) {
  const migrations = (files ?? []).filter((file) => /\.sql$/i.test(file) && /(^|\/)migrations?\//i.test(file));
  if (migrations.length === 0) return [];
  /** @type {string[]} */
  const details = [];
  for (const file of migrations) {
    const text = readContent(file);
    if (text == null) continue;
    const statements = text
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";");
    for (const statement of statements) {
      for (const { pattern, describe } of DATA_MUTATIONS) {
        const match = pattern.exec(statement);
        if (match)
          details.push(
            `${file}: ${describe(match[1])}${/\bUPDATE\b|\bDELETE\b/i.test(match[0]) && !/\bWHERE\b/i.test(statement) ? " (every row: no WHERE)" : ""}`,
          );
      }
    }
  }
  if (details.length === 0) {
    return [{ name: "Migration safety", status: STATUS.pass, summary: "Changed migrations add or alter schema without rewriting or dropping existing data." }];
  }
  return [
    {
      name: "Migration safety",
      status: STATUS.warn,
      summary: "A migration rewrites or drops existing data; review its effect on production rows and how it is rolled back.",
      details: details.slice(0, 20),
    },
  ];
}

/**
 * @param {string[]} files
 * @param {"staged" | "commit" | "working-tree"} [scope]
 * @returns {Check}
 */
function riskCheck(files, scope = "working-tree") {
  // Gate mode: ignore test files and documentation. A `checkout.spec.ts` test
  // or a `git-checkout-guide.md` doc is risk-adjacent for ranking purposes but
  // must not, on its own, force an explicit-review warning at merge time.
  const matches = matchRiskPaths(files, { gate: true });
  if (matches.length > 0) {
    // Unstaging only applies to the index; a committed range or working tree
    // has nothing staged, so the advice there is the review itself.
    const staged = scope === "staged";
    const productionConfig = matches.filter(isProductionConfigurationPath);
    const actions = productionConfig.map((file) =>
      staged
        ? `Maintainer action: explicitly approve the production configuration scope for ${file}, or remove it from this staged change: git restore --staged -- ${shellQuote(file)}`
        : `Maintainer action: explicitly approve the production configuration scope for ${file} before merge.`,
    );
    if (actions.length === 0) {
      actions.push(
        staged
          ? `Maintainer action: record explicit review of this risk-sensitive scope, or remove unintended staged files: ${matches.map((file) => `git restore --staged -- ${shellQuote(file)}`).join(" ; ")}`
          : "Maintainer action: record explicit review of this risk-sensitive scope before merge.",
      );
    }
    return {
      name: "Risk review",
      status: STATUS.warn,
      summary: "Risk-sensitive files changed; maintainer review should be explicit.",
      details: [...matches.slice(0, 20), ...actions],
    };
  }
  return { name: "Risk review", status: STATUS.pass, summary: "No obvious risk-sensitive file paths changed." };
}

/**
 * @param {string} root
 * @returns {Check}
 */
function validationCommandsCheck(root) {
  const commands = inferValidationCommands(root);
  if (commands.length === 0) {
    return { name: "Validation commands", status: STATUS.warn, summary: "No obvious validation command found; define tests before relying on this gate." };
  }
  return { name: "Validation commands", status: STATUS.pass, summary: "Validation commands are available.", details: commands };
}

/**
 * @param {string} root
 * @returns {Check | null}
 */
function dependencyAuditCheck(root) {
  if (!exists(path.join(root, "package.json"))) return null;
  const commands = dependencyAuditCommands(root);
  if (!hasPackageLockfile(root)) {
    return {
      name: "Dependency audit",
      status: STATUS.warn,
      summary: "Package manifest found without a supported lockfile; audit results may not be reproducible.",
      details: commands,
    };
  }
  return { name: "Dependency audit", status: STATUS.pass, summary: "Dependency audit commands are available.", details: commands };
}

/** @param {{ staged: boolean }} options @returns {Check} */
function localReviewCheck(options) {
  if (options.staged) {
    return {
      name: "Review state",
      status: STATUS.pass,
      summary: "Staged changes are ready for a local commit; GitHub review controls are verified after a PR exists.",
    };
  }
  // Not evaluated is not the same as unsafe: a local run has no PR, so there is
  // nothing to approve yet. Warning here made every clean local change WARN.
  return {
    name: "Review state",
    status: STATUS.skipped,
    summary: "Not checked locally: approvals, CODEOWNERS, status checks, and unresolved conversations are verified once a PR exists.",
  };
}

/** The npm package tieline is published as; there is no @bashbop/tieline. */
const TIELINE_PACKAGE = "@nugehs/tieline";

// Optional FE↔BE contract-drift gate, powered by tieline
// (https://github.com/nugehs/tieline). Runs only when a tieline config is
// discoverable AND the binary resolves; otherwise it skips silently so the gate
// never hard-depends on tieline being installed.
/**
 * @param {string} root
 * @returns {Check | null}
 */
function contractDriftCheck(root) {
  const cfg = findTielineConfig(root);
  if (!cfg) return null;
  const cwd = path.dirname(cfg);
  const bin = resolveToolBin("tieline", cwd, root);
  if (!bin) {
    return {
      name: "Contract drift",
      status: STATUS.warn,
      summary: `tieline config found but the tieline binary could not be resolved — install ${TIELINE_PACKAGE} to enable this gate.`,
      details: [cfg, `Repair command: npm install --save-dev ${TIELINE_PACKAGE}`],
    };
  }
  const res = runCommand(bin, ["check", "--json", "--no-fail", "--config", cfg], { cwd, timeout: 60000 });
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return null; // tieline unavailable or output unparseable — skip, never break the gate
  }
  const drift = parsed?.totals?.drift ?? 0;
  if (drift === 0) {
    return { name: "Contract drift", status: STATUS.pass, summary: "No frontend↔backend contract drift (tieline)." };
  }
  const details = (parsed.drift ?? [])
    .slice(0, 10)
    .map(
      (/** @type {{ method: string, path: string, name: string, hint?: string }} */ d) =>
        `${d.method} ${d.path} (${d.name}) — ${d.hint ?? "no matching backend route"}`,
    );
  return {
    name: "Contract drift",
    status: STATUS.warn,
    summary: `${drift} frontend call(s) hit a backend route that does not exist (tieline).`,
    details,
  };
}

/** The npm package bouncer is published as; there is no @bashbop/bouncer. */
const BOUNCER_PACKAGE = "@nugehs/bouncer";

/**
 * Optional compliance-controls gate, powered by bouncer. A config explicitly
 * opts a repository into the applicable regulation packs.
 * @param {string} root
 * @returns {Check | null}
 */
function complianceControlsCheck(root) {
  const cfg = findToolConfig(root, "bouncer.config.json", "SOLUMBE_BOUNCER_CONFIG");
  if (!cfg) return null;
  const cwd = path.dirname(cfg);
  const bin = resolveToolBin("bouncer", cwd, root);
  if (!bin) {
    const repair = `Repair command: npm install --save-dev ${BOUNCER_PACKAGE}`;
    // A repository may run bouncer only in CI (npx, no devDependency). Say where
    // instead of reporting a broken install. The gate reads the workflow and
    // never runs npx, so it has no evidence for this change either way: that is
    // SKIPPED, not a warning, and CI remains the control that decides.
    const ci = findWorkflowReference(root, BOUNCER_PACKAGE);
    if (ci) {
      return {
        name: "Compliance controls",
        status: STATUS.skipped,
        summary: `Not checked locally: bouncer runs in CI (${ci.file}), and the gate does not run npx or install packages.`,
        details: [cfg, `CI workflow: ${ci.file}:${ci.line} · ${ci.text}`, repair],
      };
    }
    return {
      name: "Compliance controls",
      status: STATUS.warn,
      summary: `bouncer config found but the bouncer binary could not be resolved — install ${BOUNCER_PACKAGE} to enable this gate.`,
      details: [cfg, repair],
    };
  }
  const result = runCommand(bin, ["check", "--json", "--no-fail", "--config", cfg], { cwd, timeout: 60000 });
  const parsed = parseToolJson(result.stdout);
  if (!parsed) {
    return {
      name: "Compliance controls",
      status: STATUS.warn,
      summary: "bouncer did not return readable evidence.",
      details: [result.stderr.trim(), `Recheck command: ${shellQuote(bin)} check --json --no-fail --config ${shellQuote(cfg)}`].filter(Boolean),
    };
  }
  const failed = Number(parsed?.totals?.fail ?? 0);
  const unknown = Number(parsed?.totals?.unknown ?? 0);
  const passed = Number(parsed?.totals?.pass ?? 0);
  const details = (parsed?.findings ?? [])
    .filter((/** @type {{ status?: string }} */ finding) => finding.status !== "pass")
    .slice(0, 10)
    .map((/** @type {{ ruleId?: string, status?: string, fix?: string, repairCommand?: string, fixCommand?: string }} */ finding) => {
      const ruleId = finding.ruleId ?? "control";
      const declaredRepair = String(finding.repairCommand ?? finding.fixCommand ?? "").trim();
      const action = finding.fix ? ` · Repair action: ${finding.fix}` : "";
      const command = declaredRepair
        ? ` · Repair command: ${declaredRepair}`
        : ` · Recheck command: ${shellQuote(bin)} check --json --no-fail --config ${shellQuote(cfg)}`;
      return `${ruleId}: ${finding.status ?? "unknown"}${action}${command}`;
    });
  if (failed > 0) {
    return {
      name: "Compliance controls",
      status: STATUS.fail,
      summary: `${failed} required control${failed === 1 ? " is" : "s are"} missing (bouncer).`,
      details,
    };
  }
  if (unknown > 0) {
    return {
      name: "Compliance controls",
      status: STATUS.warn,
      summary: `${unknown} control${unknown === 1 ? " could" : "s could"} not be determined (bouncer).`,
      details,
    };
  }
  return { name: "Compliance controls", status: STATUS.pass, summary: `${passed} configured compliance control${passed === 1 ? "" : "s"} found (bouncer).` };
}

/**
 * Optional AI-governance gate, powered by aiglare. When the binary is bundled,
 * it checks every JS/TS repository and stays green when no AI surfaces exist.
 * @param {string} root
 * @returns {Check | null}
 */
function aiGovernanceCheck(root) {
  if (process.env.SOLUMBE_AIGLARE !== "1") return null;
  const bin = resolveToolBin("aiglare", root, root);
  if (!bin) return null;
  const result = runCommand(bin, [root, "--json", "--ci"], { cwd: root, timeout: 60000 });
  const parsed = parseToolJson(result.stdout);
  if (!parsed) {
    return {
      name: "AI governance",
      status: STATUS.warn,
      summary: "aiglare did not return readable evidence.",
      details: [result.stderr.trim()].filter(Boolean),
    };
  }
  const blocking = Number(parsed?.gate?.blocking ?? 0);
  const surfaces = Number(parsed?.surfaceCount ?? 0);
  const details = (parsed?.surfaces ?? [])
    .filter((/** @type {{ severity?: string }} */ surface) => surface.severity === "red")
    .slice(0, 10)
    .map((/** @type {{ file?: string, sink?: string }} */ surface) => `${surface.file ?? "AI surface"}: ${surface.sink ?? "unclassified sink"}`);
  if (blocking > 0 || parsed?.gate?.passed === false) {
    return {
      name: "AI governance",
      status: STATUS.fail,
      summary: `${blocking} irreversible AI surface${blocking === 1 ? " lacks" : "s lack"} required guardrails (aiglare).`,
      details,
    };
  }
  return {
    name: "AI governance",
    status: STATUS.pass,
    summary: `${surfaces} AI surface${surfaces === 1 ? "" : "s"} inspected with no blocking governance gap (aiglare).`,
  };
}

/**
 * @param {string} root
 * @returns {string | null}
 */
function findTielineConfig(root) {
  return findToolConfig(root, "tieline.config.json", "SOLUMBE_TIELINE_CONFIG");
}

/**
 * @param {string} root
 * @param {string} fileName
 * @param {string} environmentVariable
 * @returns {string | null}
 */
function findToolConfig(root, fileName, environmentVariable) {
  const configured = process.env[environmentVariable];
  if (configured && exists(configured)) return path.resolve(configured);
  let dir = root;
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(dir, fileName);
    if (exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * First non-comment line of a GitHub Actions workflow that references a
 * package, so a gate can say where a tool it could not resolve locally runs.
 * The workflow is only read, never executed.
 * @param {string} root
 * @param {string} packageName
 * @returns {{ file: string, line: number, text: string } | null}
 */
function findWorkflowReference(root, packageName) {
  const dir = path.join(root, ".github", "workflows");
  try {
    const names = fs.readdirSync(dir).filter((entry) => /\.ya?ml$/.test(entry));
    for (const name of names.sort()) {
      const lines = fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/);
      const index = lines.findIndex((line) => !line.trimStart().startsWith("#") && line.includes(packageName));
      if (index !== -1) return { file: `.github/workflows/${name}`, line: index + 1, text: lines[index].trim() };
    }
  } catch {
    // No readable workflows: fall back to the install hint.
  }
  return null;
}

/**
 * Resolve a configured, workspace-local, solumbe-local, IDE-bundled, or PATH
 * tool binary without invoking a shell.
 * @param {string} name
 * @param {string} cwd
 * @param {string} root
 * @returns {string | null}
 */
function resolveToolBin(name, cwd, root) {
  const environmentVariable = `SOLUMBE_${name.toUpperCase()}_BIN`;
  const configured = process.env[environmentVariable];
  if (configured && exists(configured)) return path.resolve(configured);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const candidates = [
    path.join(cwd, "node_modules", ".bin", name),
    path.join(root, "node_modules", ".bin", name),
    path.join(packageRoot, "node_modules", ".bin", name),
    path.resolve(packageRoot, "../..", ".bin", name),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  const probe = runCommand(name, ["--help"], { cwd, timeout: 10000 });
  if (probe.ok || new RegExp(name, "i").test(`${probe.stdout}${probe.stderr}`)) return name;
  return null;
}

/** @param {string} value */
function parseToolJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function dependencyAuditCommands(root) {
  switch (packageRunner(root)) {
    case "yarn":
      return ["yarn npm audit --environment production --recursive --severity critical", "yarn npm audit --environment production --recursive"];
    case "pnpm":
      return ["pnpm audit --prod --audit-level critical", "pnpm audit --prod"];
    default:
      return ["npm audit --omit=dev --audit-level=critical", "npm audit --omit=dev"];
  }
}

/** @param {string} root */
function hasPackageLockfile(root) {
  return ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"].some((name) => exists(path.join(root, name)));
}

/** @param {string} file */
function isProductionConfigurationPath(file) {
  const normalized = String(file).toLowerCase();
  return /(^|\/)(production|prod)(?:\.[^/]+)?\.(json|ya?ml)$/.test(normalized) && /(?:config|flag|env)/.test(normalized);
}

/** Shell-safe display only; the gate never executes this generated command. @param {string} value */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function inferValidationCommands(root) {
  if (exists(path.join(root, "package.json"))) {
    const commands = packageValidationCommands(root);
    if (commands.length > 0) return commands;
  }
  if (exists(path.join(root, "go.mod"))) return ["go test ./..."];
  if (exists(path.join(root, "pyproject.toml")) && isDir(path.join(root, "tests"))) return ["PYTHONPATH=src python3 -m unittest discover -s tests"];
  if (isDir(path.join(root, "tests"))) return ["python3 -m unittest discover -s tests"];
  return [];
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function packageValidationCommands(root) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const runner = packageRunner(root);
  const preferred = ["ci", "quality", "test", "lint", "typecheck", "check:type", "tsc:check", "type-check"];
  const scripts = parsed?.scripts ?? {};
  const commands = [];
  for (const name of preferred) {
    if (scripts[name]) commands.push(packageScriptCommand(runner, name));
  }
  const deps = { ...(parsed?.dependencies ?? {}), ...(parsed?.devDependencies ?? {}) };
  if (exists(path.join(root, "tsconfig.json")) && deps.typescript && !preferred.some((name) => name !== "test" && name !== "lint" && scripts[name])) {
    commands.push(typeScriptFallback(runner));
  }
  return commands;
}

/**
 * @param {string} root
 * @returns {"pnpm" | "yarn" | "npm"}
 */
function packageRunner(root) {
  if (exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (exists(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * @param {string} runner
 * @param {string} name
 * @returns {string}
 */
function packageScriptCommand(runner, name) {
  if (runner === "yarn") return `yarn ${name}`;
  if (runner === "pnpm") return name === "test" ? "pnpm test" : `pnpm run ${name}`;
  return name === "test" ? "npm test" : `npm run ${name}`;
}

/**
 * @param {string} runner
 * @returns {string}
 */
function typeScriptFallback(runner) {
  if (runner === "yarn") return "yarn tsc --noEmit";
  if (runner === "pnpm") return "pnpm exec tsc --noEmit";
  return "npm exec --package typescript -- tsc --noEmit";
}

/**
 * @param {string} base
 * @param {string} [request]
 * @returns {string[]}
 */
function contextEvidence(base, request) {
  const quoted = JSON.stringify(request && request.trim() ? request : "review this change");
  return [`solumbe impact . ${quoted} --json`, `solumbe pr . --base ${base} --out .solumbe/pr-review.md`];
}

/** @param {string} filePath */
function exists(filePath) {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} filePath */
function isDir(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

// Fancy + markdown renderers live next to the engine because they share the
// check shape and glyph mapping.

const STATUS_TO_RENDER = {
  PASS: "pass",
  WARN: "warn",
  FAIL: "fail",
  SKIPPED: "info",
};

/**
 * @typedef {Object} PassData
 * @property {Verdict} verdict
 * @property {{ root: string, name: string }} repo
 * @property {string} base
 * @property {"staged" | "commit" | "working-tree"} scope
 * @property {string} [head]
 * @property {string} policy
 * @property {string} governance
 * @property {string[]} changedFiles
 * @property {string[]} contextEvidence
 * @property {Check[]} checks
 * @property {{ kind?: string, baseSha?: string, parentSha?: string, headSha?: string, treeSha?: string }} [subject]
 * @property {Record<string, any>} [receipt]
 */

/**
 * @param {PassData} data
 * @param {(options: object) => any} rendererFactory
 * @returns {string}
 */
export function formatPassTerminal(data, rendererFactory) {
  const renderer = rendererFactory({});
  const lines = [];
  const sub = [
    { text: data.repo.root, glyph: "📂" },
    {
      text: `${data.scope} · ${data.base} · ${data.changedFiles.length} changed file${data.changedFiles.length === 1 ? "" : "s"} · policy: ${data.policy}`,
      glyph: "🔀",
    },
  ];
  if (data.subject?.kind === "git-commit" && data.subject.headSha) {
    sub.push({ text: `head commit: ${data.subject.headSha.slice(0, 12)}`, glyph: "🧾" });
  } else if (data.subject?.treeSha) {
    sub.push({ text: `staged tree: ${data.subject.treeSha.slice(0, 12)}`, glyph: "🧾" });
  }
  lines.push(renderer.header({ text: "solumbe pass · merge readiness", glyph: "📋" }, sub));
  lines.push("");

  for (const check of data.checks) {
    const status = STATUS_TO_RENDER[check.status] ?? "info";
    const details = (check.details ?? []).slice(0, 10).map((detail) => decorateDetail(detail, renderer));
    lines.push(renderer.statusLine(status, check.name, check.summary, details));
    for (const excerpt of check.excerpts ?? []) {
      lines.push(`     ${renderer.glyphs.box.arrow} ${excerptHeading(excerpt)}:`);
      for (const line of excerpt.lines) lines.push(`        ${renderer.paint(renderer.glyphs.tree.pipe, "dim")}${line ? ` ${line}` : ""}`);
    }
  }

  lines.push("");
  const blocked = data.checks.find((entry) => entry.status === STATUS.fail);
  const warning = data.checks.find((entry) => entry.status === STATUS.warn);
  lines.push(
    renderer.verdict({
      verdict: data.verdict,
      blockedBy: blocked ? blocked.name : undefined,
      nextStep: nextStepFor(data, blocked, warning),
    }),
  );

  lines.push("");
  lines.push(`  ${renderer.glyphs.tip}  Context evidence:`);
  for (const command of data.contextEvidence) lines.push(`     ${renderer.paint(renderer.glyphs.item, "dim")} ${command}`);

  return lines.join("\n");
}

/**
 * One line naming the verdict and the check that decided it, for callers that
 * write the report to a file and would otherwise print only its path.
 * @param {PassData} data
 * @returns {string}
 */
export function formatPassOutcome(data) {
  const deciding = data.verdict === "FAIL" ? STATUS.fail : data.verdict === "WARN" ? STATUS.warn : null;
  const [first, ...rest] = deciding ? data.checks.filter((check) => check.status === deciding) : [];
  if (!first) return data.verdict;
  const also = rest.length ? ` (also ${data.verdict === "FAIL" ? "failing" : "warning"}: ${rest.map((check) => check.name).join(", ")})` : "";
  return `${data.verdict} — ${data.verdict === "FAIL" ? "blocked by " : ""}${first.name}: ${first.summary}${also}`;
}

/**
 * @param {import("./validation-attestation.js").OutputExcerpt} excerpt
 * @returns {string}
 */
function excerptHeading(excerpt) {
  const range = excerpt.firstLine === excerpt.lastLine ? `line ${excerpt.firstLine}` : `lines ${excerpt.firstLine}-${excerpt.lastLine}`;
  return `${excerpt.id} ${excerpt.stream}, ${range} of ${excerpt.totalLines} (${excerpt.from === "failure" ? "from the first failure" : "tail"})`;
}

/**
 * Prefix a changed path with its risk emoji; only the emoji set shows it.
 * @param {string} detail
 * @param {ReturnType<typeof import("./render/fancy.js").createRenderer>} renderer
 * @returns {string}
 */
function decorateDetail(detail, renderer) {
  const flags = classifyPath(detail);
  const glyph = flags.length ? glyphFor(flags[0]) : "";
  return renderer.pick({ emoji: glyph ? `${glyph}  ${detail}` : detail, ascii: detail });
}

/**
 * @param {PassData} data
 * @param {Check | undefined} blocked
 * @param {Check | undefined} warning
 * @returns {string}
 */
function nextStepFor(data, blocked, warning) {
  if (blocked) {
    if (blocked.name === "Secret safety") return "remove or rotate the affected file before merge";
    if (blocked.name === "Release discipline") return "fix version metadata before bumping";
    if (blocked.name === "Policy profile") return "satisfy the missing policy controls";
    return "address the blocking check";
  }
  if (warning) {
    if (warning.name === "Risk review") return "record the maintainer decision before merge";
    // This engine no longer warns here (local mode reports SKIPPED), but reports
    // saved by an earlier version still carry the warning.
    if (warning.name === "Review state") return "verify the missing review evidence";
    return "review the warning before merge";
  }
  if (data.changedFiles.length === 0) return data.scope === "staged" ? "stage changes before committing" : "no changes vs base";
  if (data.scope === "staged") return "ready to commit";
  // A clean local run proves the local checks, not the PR controls it skipped.
  return data.checks.some((entry) => entry.status === STATUS.skipped) ? "ready for a PR; skipped checks run there" : "ready to merge";
}

/**
 * @param {PassData} data
 * @returns {string}
 */
export function formatPassMarkdown(data) {
  const lines = [
    `# solumbe pass: ${data.repo.name}`,
    "",
    `Verdict: **${data.verdict}**`,
    `Repository: \`${data.repo.root}\``,
    `Base: \`${data.base}\``,
    `Scope: \`${data.scope}\``,
    `Policy: \`${data.policy}\``,
    `Governance: \`${data.governance}\``,
    ...(data.subject?.kind === "git-commit"
      ? [`Head commit: \`${data.subject.headSha ?? ""}\``, `Head tree: \`${data.subject.treeSha ?? ""}\``]
      : data.subject?.treeSha
        ? [`Staged tree: \`${data.subject.treeSha}\``, `Parent commit: \`${data.subject.parentSha ?? ""}\``]
        : []),
    "",
    "## Context Evidence",
    "",
    ...data.contextEvidence.map((command) => `- \`${command}\``),
    "",
    "## Changed Files",
    "",
    ...(data.changedFiles.length ? data.changedFiles.map((file) => `- \`${file}\``) : ["- (no changes vs base)"]),
    "",
    "## Checks",
    "",
  ];
  for (const check of data.checks) {
    lines.push(`### ${check.status}  ·  ${check.name}`);
    lines.push("");
    lines.push(check.summary);
    if (check.details && check.details.length) {
      lines.push("");
      for (const detail of check.details) lines.push(`- ${detail}`);
    }
    for (const excerpt of check.excerpts ?? []) {
      const longestRun = Math.max(0, ...excerpt.lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      lines.push("", `${excerptHeading(excerpt)}:`, "", `${fence}text`, ...excerpt.lines, fence);
    }
    lines.push("");
  }
  return lines.join("\n");
}
