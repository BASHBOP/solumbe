// Grades the gate's verdict and the convergence band against the repository's
// own history.
//
// `solumbe calibrate` grades the risk flags, which are one input to the gate.
// Nothing graded what the gate says with them: whether a WARN or FAIL change is
// repaired more often than a PASS one, which check's warnings carry that
// signal, and whether a `drift` change is repaired more often than an
// `aligned` one. This module supplies that comparison the way `solumbe regret`
// does for the router: replay history, run the real local gate and the real
// convergence score on each commit as it was, and join to the same `repaired`
// outcome.
//
// What comes out is discrimination, not effect. A verdict that separates
// repaired changes from the rest is worth showing; whether showing it prevents
// anything is a question only a trial with a control arm answers.
//
// Everything here is a function of repository state, recorded in a receipt.
// Nothing here reaches the gate.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers";

import { DEFAULT_MIN_SAMPLE, DEFAULT_WINDOW_DAYS, FIX_COMMIT_RULE, FIX_SUBJECT, joinRepairs, readHistory } from "./calibrate.js";
import { gatePolicy } from "./config.js";
import { convergenceEngineVersion, generateConvergence } from "./converge.js";
import { evaluateLocal } from "./pass-local.js";
import { normalizeGovernance, normalizeProfile, STATUS } from "./policy.js";
import { addWorktree, checkout, isolateGit, RELEASE_SUBJECT, removeWorktree, wilson } from "./regret.js";
import { inspectRepo } from "./repo.js";
import { isDocPath } from "./risk-paths.js";

export const gateCalibrationEngineVersion = "0.1.0";

const DAY_SECONDS = 86400;
const VERDICTS = /** @type {const} */ ([STATUS.pass, STATUS.warn, STATUS.fail]);
// Best first, so the ordering check reads the way the level and tier checks do.
// `inconclusive` (the request predicted no owner file) is graded beside the
// three scored bands and stays last: the ordering claims below read the first
// three by position.
const BANDS = /** @type {const} */ (["aligned", "partial", "drift", "inconclusive"]);

/**
 * @typedef {object} GateCalibrationOptions
 * @property {number|string} [window] outcome window in days
 * @property {number|string} [minSample] refuse to publish a rate below this n
 * @property {string} [since] only consider commits after this date
 * @property {number|string} [max] cap the number of commits replayed, newest gradable first
 * @property {string} [policy] policy profile the gate is replayed under
 * @property {string} [governance] governance the gate is replayed under
 * @property {(progress: { done: number, total: number, sha: string, worktree: string }) => void} [onProgress]
 */

/**
 * @param {string} [repoPath]
 * @param {GateCalibrationOptions} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function generateGateCalibration(repoPath = ".", options = {}) {
  // Same isolation as the regret replay: the caller's git redirections are
  // removed and hooks, filters and fsmonitor are off, so checking out a
  // historical tree runs nothing.
  const restore = isolateGit(repoPath);
  try {
    return await replay(repoPath, options);
  } finally {
    restore();
  }
}

/**
 * @param {string} repoPath
 * @param {GateCalibrationOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function replay(repoPath, options) {
  const repo = inspectRepo(repoPath);
  if (!repo.git.available) {
    throw new Error(`gate calibration requires a git repository: ${repo.root}`);
  }
  const root = repo.git.root ?? repo.root;
  const windowDays = positiveInt(options.window, DEFAULT_WINDOW_DAYS);
  const minSample = positiveInt(options.minSample, DEFAULT_MIN_SAMPLE);
  const max = options.max === undefined ? Infinity : positiveInt(options.max, Infinity);
  const configured = gatePolicy(root, { policy: options.policy, governance: options.governance });
  const policy = normalizeProfile(configured.policy);
  const governance = normalizeGovernance(configured.governance);

  const commits = readHistory(root, options.since);
  if (!commits.length) {
    throw new Error("gate calibration found no non-merge commits to replay");
  }

  // The same horizon and corpus rules as regret. A commit younger than the
  // window has not had its chance to be repaired, so it is censored. Fix
  // commits are the outcome and release commits are written by tooling.
  // Docs-only commits are left out, as calibrate leaves them out: the gate
  // passes nearly all of them and almost none is repaired, so grading them
  // would make PASS look cleaner than it is among changes to code.
  const horizon = commits.reduce((latest, commit) => Math.max(latest, commit.time), 0);
  const gradable = (/** @type {{ time: number }} */ commit) => horizon - commit.time >= windowDays * DAY_SECONDS;
  const requests = commits.filter((commit) => !FIX_SUBJECT.test(commit.subject) && commit.parents.length === 1 && commit.subject.trim());
  const releases = requests.filter((commit) => RELEASE_SUBJECT.test(commit.subject)).length;
  const changes = requests.filter((commit) => !RELEASE_SUBJECT.test(commit.subject));
  const docsOnly = changes.filter((commit) => !commit.files.some((file) => !isDocPath(file.path))).length;
  const candidates = changes.filter((commit) => commit.files.some((file) => !isDocPath(file.path)));
  const censored = candidates.filter((commit) => !gradable(commit)).length;
  const scoreable = candidates.filter(gradable).slice(0, max === Infinity ? undefined : max);
  const fixes = commits.filter((commit) => FIX_SUBJECT.test(commit.subject) && commit.parents.length === 1);
  if (!candidates.length) {
    throw new Error("gate calibration found no non-fix commit that changes code to grade");
  }
  if (!scoreable.length) {
    throw new Error(`gate calibration found no commit old enough to grade: all ${censored} candidates are younger than the ${windowDays}-day window`);
  }
  const { repairedAfter, joinedFixes } = joinRepairs(root, scoreable, fixes);

  /** @type {Record<string, any>[]} */
  const graded = [];
  // As in regret: a signal mid-replay is recorded, the loop yields once per
  // commit so it can arrive, and `finally` removes the worktree.
  /** @type {NodeJS.Signals|null} */
  let interrupted = null;
  const onInterrupt = (/** @type {NodeJS.Signals} */ signal) => {
    interrupted = signal;
  };
  const yieldForSignals = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted) throw Object.assign(new Error(`gate calibration interrupted by ${interrupted}`), { signal: interrupted });
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-calibrate-"));
  try {
    addWorktree(root, scoreable[0].sha, worktree, "gate calibration");
    let done = 0;
    for (const commit of scoreable) {
      await yieldForSignals();
      // The gate reads release metadata, validation commands and the lockfile
      // from the working tree, so the tree is the commit's own, not today's.
      checkout(root, worktree, commit.sha, "gate calibration");
      graded.push({
        sha: commit.sha,
        subject: commit.subject,
        time: commit.time,
        repairedAfter: repairedAfter.get(commit.sha) ?? null,
        ...gateAt(worktree, commit, policy, governance),
        ...convergenceAt(worktree, commit),
      });
      done += 1;
      options.onProgress?.({ done, total: scoreable.length, sha: commit.sha, worktree });
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    removeWorktree(root, worktree);
  }

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    gateCalibrationEngineVersion,
    convergenceEngineVersion,
    repo: { root, name: path.basename(root), head: repo.git.commit ?? null },
    method: {
      join: "line-overlap",
      outcome: "repaired",
      fixCommitRule: FIX_COMMIT_RULE,
      releaseCommitRule: "subject is marked [skip ci], is a bare version, or is a chore/build/ci/release subject that names a version",
      gate: "the local gate on exactly parent..commit, with the commit checked out into a temporary worktree",
      requestProxy: "commit subject",
      horizon: "the newest commit in history; a commit younger than the window is censored, not graded",
      alarm: "a WARN or FAIL verdict",
      interval: "Wilson 95%",
      policy,
      governance,
      windowDays,
      minSample,
    },
    range: {
      since: options.since ?? null,
      max: max === Infinity ? null : max,
      commits: commits.length,
      candidates: candidates.length,
      censored,
      releaseCommits: releases,
      docsOnly,
      replayed: graded.length,
      gateErrors: graded.filter((row) => row.gateError).length,
      convergenceErrors: graded.filter((row) => row.convergenceError).length,
      fixCommits: fixes.length,
      fixCommitsJoined: joinedFixes,
    },
    ...gradeRows(graded, windowDays, minSample),
    commits: graded,
    caveats: [
      "This grades whether the verdict separates changes that were later repaired from the rest. It does not show that running the gate prevents a repair; only a trial with a control arm does.",
      "`repaired` is a proxy inherited from calibrate: blame attributes a line to its last toucher, and an unlabelled fix is invisible.",
      "The gate is replayed on the commit as it landed. A warning that made its author change the diff before committing left no trace here, so a check that works is graded on the changes it failed to stop.",
      "The convergence request is the commit subject, written after the change, not the task that started the work, so a commit tends to score closer to its own subject than a diff does to its request.",
      "Review state is not replayed: the local gate cannot see approvals, and reports that check as skipped. The optional analyzers (contract drift, compliance controls, AI governance) are not run against historical trees.",
      "The policy profile and governance are today's settings, applied to every commit.",
      `Rates over fewer than ${minSample} commits are withheld rather than published. A published rate carries a 95% interval; two rates whose intervals overlap are not shown to differ.`,
      "One repository is not a representative sample of repositories.",
    ],
  };
  return { ...data, receipt: makeGateCalibrationReceipt(data) };
}

/**
 * The gate's verdict on one commit, with the checks that decided it.
 * @param {string} worktree
 * @param {{ sha: string, parents: string[] }} commit
 * @param {string} policy
 * @param {string} governance
 */
function gateAt(worktree, commit, policy, governance) {
  try {
    const result = /** @type {{ verdict: string, checks: import("./pass-local.js").Check[] }} */ (
      /** @type {unknown} */ (evaluateLocal(worktree, { base: commit.parents[0], head: commit.sha, policy, governance, analyzers: false }))
    );
    const named = (/** @type {string} */ status) => result.checks.filter((check) => check.status === status).map((check) => check.name);
    return { verdict: result.verdict, warned: named(STATUS.warn), failed: named(STATUS.fail), skipped: named(STATUS.skipped) };
  } catch (error) {
    return { verdict: null, warned: [], failed: [], skipped: [], gateError: errorText(error) };
  }
}

/**
 * The convergence score of one commit against its own subject.
 * @param {string} worktree
 * @param {{ sha: string, parents: string[], subject: string }} commit
 */
function convergenceAt(worktree, commit) {
  try {
    const result = generateConvergence(commit.subject, { path: worktree, base: commit.parents[0], head: commit.sha });
    return { convergence: result.convergence, band: result.band };
  } catch (error) {
    return { convergence: null, band: null, convergenceError: errorText(error) };
  }
}

/** @param {unknown} error */
function errorText(error) {
  return String(/** @type {any} */ (error)?.message ?? error).slice(0, 160);
}

/**
 * Every table over a set of replayed rows.
 * @param {Record<string, any>[]} graded
 * @param {number} windowDays
 * @param {number} minSample
 */
function gradeRows(graded, windowDays, minSample) {
  const within = (/** @type {any} */ row) => row.repairedAfter !== null && row.repairedAfter <= windowDays * DAY_SECONDS;
  const summarize = (/** @type {string} */ name, /** @type {Record<string, any>[]} */ rows, /** @type {number|null} */ baseRate) =>
    summarizeRows(name, rows, minSample, within, baseRate);

  const gated = graded.filter((row) => row.verdict);
  const base = summarize("base", gated, null);
  const verdicts = VERDICTS.map((verdict) =>
    summarize(
      verdict,
      gated.filter((row) => row.verdict === verdict),
      base.rate,
    ),
  );
  const alarmed = summarize(
    "alarmed",
    gated.filter((row) => row.verdict !== STATUS.pass),
    base.rate,
  );
  const passed = verdicts[0];
  const repaired = gated.filter(within);
  const caught = repaired.filter((row) => row.verdict !== STATUS.pass).length;

  const checkNames = [...new Set(gated.flatMap((row) => [...row.warned, ...row.failed]))].sort();
  const checks = checkNames
    .map((name) =>
      summarize(
        name,
        gated.filter((row) => row.warned.includes(name) || row.failed.includes(name)),
        base.rate,
      ),
    )
    .sort((a, b) => (b.lift ?? -1) - (a.lift ?? -1) || b.n - a.n);

  const scored = graded.filter((row) => row.band);
  const convergenceBase = summarize("base", scored, null);
  const bands = BANDS.map((band) =>
    summarize(
      band,
      scored.filter((row) => row.band === band),
      convergenceBase.rate,
    ),
  );
  const bandRates = bands.slice(0, 3).map((row) => row.rate);

  return {
    base,
    gate: {
      n: gated.length,
      verdicts,
      // How often the gate raises its hand at all. Near 1 it cannot separate
      // anything, whatever the rates beside it say.
      alarmRate: proportion(alarmed.n, gated.length, minSample),
      alarmed,
      // An alarm on a change nothing later repaired.
      falseAlarms: proportion(alarmed.n - alarmed.repaired, alarmed.n, minSample),
      // The repaired changes the gate had raised an alarm on.
      caught: proportion(caught, repaired.length, minSample),
      separates: separates(passed, alarmed),
      checks,
    },
    convergence: {
      n: scored.length,
      base: convergenceBase,
      bands,
      // Aligned should be repaired least and drift most if the band orders
      // changes by how far they strayed. Claimed only when every band cleared
      // the minimum sample.
      monotonic: bandRates.every((rate) => rate !== null) ? bandRates[0] < bandRates[1] && bandRates[1] < bandRates[2] : null,
      separates: separates(bands[0], bands[2]),
    },
  };
}

/**
 * Whether the worse group is repaired more often than the better one by more
 * than the intervals allow for. Null when either fell below the minimum sample.
 * @param {{ ci95: [number, number]|null }} better
 * @param {{ ci95: [number, number]|null }} worse
 * @returns {boolean|null}
 */
function separates(better, worse) {
  if (!better.ci95 || !worse.ci95) return null;
  return worse.ci95[0] > better.ci95[1];
}

/**
 * Counts always; rate, interval and lift only above the minimum sample.
 * @param {string} name
 * @param {Record<string, any>[]} matching
 * @param {number} minSample
 * @param {(row: any) => boolean} within
 * @param {number|null} baseRate
 */
function summarizeRows(name, matching, minSample, within, baseRate) {
  const repaired = matching.filter(within).length;
  const share = proportion(repaired, matching.length, minSample);
  return {
    name,
    n: matching.length,
    repaired,
    rate: share.rate,
    ci95: share.ci95,
    lift: share.rate === null || !baseRate ? null : round(share.rate / baseRate),
    publishable: share.publishable,
  };
}

/**
 * @param {number} hits
 * @param {number} n
 * @param {number} minSample
 * @returns {{ hits: number, n: number, rate: number|null, ci95: [number, number]|null, publishable: boolean }}
 */
function proportion(hits, n, minSample) {
  const publishable = n >= minSample;
  return { hits, n, rate: publishable && n ? round(hits / n) : null, ci95: publishable && n ? wilson(hits, n) : null, publishable };
}

/**
 * Deterministic receipt over a canonical, timestamp-free payload.
 * @param {Record<string, any>} data
 */
export function makeGateCalibrationReceipt(data) {
  const canonical = {
    engine: "solumbe-gate-calibrate",
    gateCalibrationEngineVersion: data.gateCalibrationEngineVersion,
    convergenceEngineVersion: data.convergenceEngineVersion,
    method: data.method,
    commit: data.repo.head ?? null,
    range: data.range,
    commits: data.commits.map((/** @type {any} */ row) => [row.sha, row.verdict, row.warned, row.failed, row.convergence, row.band, row.repairedAfter]),
  };
  const inputsHash = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { id: `gatecal_${inputsHash.slice(0, 12)}`, algorithm: "sha256", commit: canonical.commit, inputsHash };
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatGateCalibrationMarkdown(data) {
  const pct = (/** @type {number|null} */ value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const interval = (/** @type {[number, number]|null} */ value) => (value ? `${pct(value[0])} to ${pct(value[1])}` : "—");
  const lift = (/** @type {number|null} */ value) => (value === null ? "—" : `${value.toFixed(2)}x`);
  const withheld = `_(n < ${data.method.minSample}, withheld)_`;
  const share = (/** @type {any} */ value) => (value.publishable ? `${pct(value.rate)} (${interval(value.ci95)})` : withheld);
  const row = (/** @type {any} */ entry) =>
    `| ${entry.name} | ${entry.n} | ${entry.publishable ? pct(entry.rate) : `${entry.repaired} ${withheld}`} | ${interval(entry.ci95)} | ${lift(entry.lift)} |`;
  const differ = (/** @type {boolean|null} */ value, /** @type {string} */ yes, /** @type {string} */ no) =>
    value === null ? "unknown (a group fell below the minimum sample)" : value ? yes : no;
  const gate = data.gate;
  const convergence = data.convergence;

  const lines = [
    `# Gate calibration — ${data.repo.name}`,
    "",
    `Join: ${data.method.join} · outcome: \`${data.method.outcome}\` · window: ${data.method.windowDays}d · minimum sample: ${data.method.minSample}`,
    `Gate: ${data.method.gate} · policy: ${data.method.policy} · governance: ${data.method.governance}`,
    `Corpus: ${data.range.replayed} commits replayed of ${data.range.candidates} candidates; ${data.range.censored} younger than the window, not graded; ${data.range.docsOnly} docs-only and ${data.range.releaseCommits} release commits, not graded; ${data.range.fixCommits} fix commits (${data.range.fixCommitsJoined} joined)`,
    `Base rate: ${data.base.publishable ? `${pct(data.base.rate)} (${interval(data.base.ci95)})` : withheld} (${data.base.repaired}/${data.base.n})`,
    "",
    "This grades whether a verdict separates repaired changes from the rest, not whether the gate prevents a repair. Two rates whose intervals overlap are not shown to differ.",
    "",
    "## Verdict",
    "",
    "| Verdict | n | repaired | 95% interval | lift |",
    "| --- | ---: | ---: | --- | ---: |",
    ...gate.verdicts.map(row),
    row(gate.alarmed),
    "",
    `Alarm rate (WARN or FAIL): ${share(gate.alarmRate)} — ${gate.alarmRate.hits} of ${gate.alarmRate.n}`,
    `False alarms (alarmed, not repaired): ${share(gate.falseAlarms)} — ${gate.falseAlarms.hits} of ${gate.falseAlarms.n}`,
    `Caught (repaired changes the gate had alarmed on): ${share(gate.caught)} — ${gate.caught.hits} of ${gate.caught.n}`,
    `Alarmed changes repaired more often than PASS: ${differ(gate.separates, "yes", "**no — the intervals overlap**")}`,
  ];
  if (gate.checks.length) {
    lines.push(
      "",
      "## Per check",
      "",
      "Changes on which the check warned or failed.",
      "",
      "| Check | n | repaired | 95% interval | lift |",
      "| --- | ---: | ---: | --- | ---: |",
    );
    lines.push(...gate.checks.map(row));
  }
  lines.push(
    "",
    "## Convergence band",
    "",
    `Base over these ${convergence.n} commits: ${convergence.base.publishable ? `${pct(convergence.base.rate)} (${interval(convergence.base.ci95)})` : withheld}`,
    "",
    "| Band | n | repaired | 95% interval | lift |",
    "| --- | ---: | ---: | --- | ---: |",
    ...convergence.bands.map(row),
    "",
    `Monotonic (aligned < partial < drift): ${convergence.monotonic === null ? "unknown (a band fell below the minimum sample)" : convergence.monotonic ? "yes" : "**no — the band does not order outcomes**"}`,
    `Drift repaired more often than aligned: ${differ(convergence.separates, "yes", "**no — the intervals overlap**")}`,
  );
  if (data.range.gateErrors || data.range.convergenceErrors) {
    lines.push(
      "",
      `Not scored: ${data.range.gateErrors} commit(s) the gate could not evaluate, ${data.range.convergenceErrors} the convergence score could not.`,
    );
  }
  lines.push("", "## Caveats", "");
  for (const caveat of data.caveats) lines.push(`- ${caveat}`);
  lines.push("", `Receipt: \`${data.receipt.id}\` (${data.receipt.algorithm}, inputs ${data.receipt.inputsHash.slice(0, 12)}…)`);
  return lines.join("\n");
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value * 1000) / 1000;
}
