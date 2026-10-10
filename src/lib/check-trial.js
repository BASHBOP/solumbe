// A trial with a control arm for the checks an agent runs before it commits.
//
// `solumbe calibrate --gate` says whether a verdict separates changes that were
// later repaired from the rest. It cannot say whether showing the verdict
// prevents a repair: every change it grades was made with the gate available.
// That question needs changes made without it, chosen at random.
//
// `SOLUMBE_CHECK_MODE=trial` runs that comparison on the MCP surface. Each
// change falls in one of two arms. In the shown arm `convergence_score` and the
// local `review_gate` answer as they always do. In the withheld arm the result
// is computed and recorded exactly the same, and the agent is told only that
// it was recorded. A blocking FAIL is shown in both arms: the gate's safety
// checks are not something to withhold for a measurement.
//
// Off by default. The command line, the pre-commit hook, CI and the pull
// request gate are never part of the trial.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MIN_SAMPLE, DEFAULT_WINDOW_DAYS, FIX_COMMIT_RULE, FIX_SUBJECT, joinRepairs, readHistory } from "./calibrate.js";
import { STATUS } from "./policy.js";
import { wilson } from "./regret.js";
import { inspectRepo } from "./repo.js";
import { runCommand } from "./tools.js";

export const checkTrialEngineVersion = "0.1.0";

/** The MCP tools the trial covers. */
export const TRIAL_TOOLS = new Set(["convergence_score", "review_gate"]);

const ARMS = /** @type {const} */ (["shown", "withheld"]);
const DAY_SECONDS = 86400;

/**
 * Which arm a change falls in. `SOLUMBE_CHECK_MODE=trial` turns the trial on;
 * `SOLUMBE_CHECK_SHOWN_SHARE` (0 to 1, default 0.5) is the share of changes in
 * the shown arm. The unit is the change being built on a commit: assignment is
 * by the repository root and its head, so every check run before the next
 * commit lands in the same arm, and that commit is the one graded.
 * @param {{ root: string, head: string }} change
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: "advisory"|"trial", arm: "advisory"|"shown"|"withheld", share: number|null }}
 */
export function checkArm(change, env = process.env) {
  if (!/^trial$/i.test(String(env.SOLUMBE_CHECK_MODE ?? "").trim())) return { mode: "advisory", arm: "advisory", share: null };
  const raw = Number(env.SOLUMBE_CHECK_SHOWN_SHARE);
  const share = Number.isFinite(raw) && env.SOLUMBE_CHECK_SHOWN_SHARE?.trim() ? Math.min(1, Math.max(0, raw)) : 0.5;
  const bucket = parseInt(crypto.createHash("sha256").update(`check-arm:${change.root}:${change.head}`).digest("hex").slice(0, 8), 16) / 0x100000000;
  return { mode: "trial", arm: bucket < share ? "shown" : "withheld", share };
}

/**
 * Where trial decisions are logged, or null when logging is off.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function checkLogPath(env = process.env) {
  const raw = env.SOLUMBE_CHECK_LOG;
  if (raw !== undefined && /^(off|0|false|none)$/i.test(raw.trim())) return null;
  return path.resolve(raw && raw.trim() ? raw.trim() : path.join(os.homedir(), ".solumbe", "check-decisions.jsonl"));
}

/** @param {unknown} text */
export function requestHash(text) {
  return crypto
    .createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Apply the trial to one MCP tool result. Returns the result the agent should
 * see and, in trial mode, the decision that was logged. Outside the trial, for
 * a tool it does not cover, for the pull request gate and for a repository
 * with no head commit, the result comes back untouched and nothing is logged.
 * Never throws: a trial must not be able to fail a tool call.
 * @param {string} tool canonical tool name
 * @param {Record<string, any>} args
 * @param {any} result what dispatch returned: the data, or a `{ data, markdown }` pair
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => Date }} [options]
 * @returns {{ result: any, decision: Record<string, any>|null }}
 */
export function applyCheckTrial(tool, args, result, options = {}) {
  try {
    const env = options.env ?? process.env;
    if (!TRIAL_TOOLS.has(tool)) return { result, decision: null };
    const data = result && typeof result === "object" && "markdown" in result ? result.data : result;
    if (!data || typeof data !== "object" || data.pr) return { result, decision: null };
    const root = typeof data.repo?.root === "string" ? data.repo.root : null;
    if (!root) return { result, decision: null };
    const state = gitStateAt(root);
    if (!state.head) return { result, decision: null };
    const arm = checkArm({ root, head: state.head }, env);
    if (arm.mode !== "trial") return { result, decision: null };

    const blocking = data.verdict === STATUS.fail;
    const withheld = arm.arm === "withheld" && !blocking;
    const request = String(args?.query ?? args?.request ?? "");
    const decision = {
      v: 1,
      ts: (options.now?.() ?? new Date()).toISOString(),
      tool,
      repo: data.repo?.name ?? path.basename(root),
      root,
      branch: state.branch,
      head: state.head,
      mode: arm.mode,
      arm: arm.arm,
      shownShare: arm.share,
      withheld,
      // Set when the withheld arm saw the result anyway, so a grader can count
      // how far the arm was from what it was assigned.
      shownBecause: arm.arm === "withheld" && blocking ? "blocking-fail" : null,
      requestHash: requestHash(request),
      requestChars: request.length,
      verdict: typeof data.verdict === "string" ? data.verdict : null,
      convergence: typeof data.convergence === "number" ? data.convergence : null,
      band: typeof data.band === "string" ? data.band : null,
      receiptId: typeof data.receipt?.id === "string" ? data.receipt.id : null,
      checkTrialEngineVersion,
    };
    appendDecision(decision, checkLogPath(env));
    return { result: withheld ? withheldResult(tool, result) : result, decision };
  } catch {
    return { result, decision: null };
  }
}

/**
 * What the withheld arm is told. It says the call worked and that nothing is
 * wrong, so an agent does not read it as a failure and go looking for the
 * result another way.
 * @param {string} tool
 * @param {any} result
 */
function withheldResult(tool, result) {
  const message =
    `solumbe check trial, withheld arm: ${tool} ran and its result was recorded, and it is not shown for this change. ` +
    "This is not an error and nothing was found that blocks the change; a blocking failure is always shown. " +
    "Carry on as you would without this result. Do not run it again for this change, through this tool or the command line.";
  const data = { ok: true, withheld: true, tool, trial: { mode: "trial", arm: "withheld" }, message };
  return result && typeof result === "object" && "markdown" in result ? { data, markdown: message } : data;
}

/**
 * The head and branch when the check ran. The head is what the commit join
 * keys on: the change is the next commit whose first parent is this head.
 * @param {string} root
 * @returns {{ head: string|null, branch: string|null }}
 */
function gitStateAt(root) {
  const read = (/** @type {string[]} */ args) => {
    const result = runCommand("git", args, { cwd: root });
    const out = result.ok ? result.stdout.trim() : "";
    return out || null;
  };
  return { head: read(["rev-parse", "HEAD"]), branch: read(["symbolic-ref", "--short", "-q", "HEAD"]) };
}

/**
 * @param {Record<string, any>} decision
 * @param {string|null} logPath
 */
function appendDecision(decision, logPath) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(decision)}\n`);
}

/**
 * Every well-formed decision in the log.
 * @param {string|null} logPath
 * @returns {Record<string, any>[]}
 */
export function readDecisions(logPath) {
  if (!logPath) return [];
  let raw;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const decisions = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.v === 1 && record.mode === "trial" && typeof record.head === "string") decisions.push(record);
    } catch {
      // a torn line is skipped, not fatal
    }
  }
  return decisions;
}

/**
 * @typedef {object} CheckTrialOptions
 * @property {number|string} [window] outcome window in days
 * @property {number|string} [minSample] refuse to publish a rate below this n
 * @property {string} [log] decision log to read instead of the default
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * Grade the two arms of the trial on what the repository's history says
 * happened to each change: the commit made on the head a check ran against,
 * joined to the same `repaired` outcome calibrate uses.
 * @param {string} [repoPath]
 * @param {CheckTrialOptions} [options]
 * @returns {Record<string, any>}
 */
export function generateCheckTrial(repoPath = ".", options = {}) {
  const repo = inspectRepo(repoPath);
  if (!repo.git.available) {
    throw new Error(`the check trial requires a git repository: ${repo.root}`);
  }
  const root = repo.git.root ?? repo.root;
  const windowDays = positiveInt(options.window, DEFAULT_WINDOW_DAYS);
  const minSample = positiveInt(options.minSample, DEFAULT_MIN_SAMPLE);
  const logPath = options.log ? path.resolve(options.log) : checkLogPath(options.env);
  if (!logPath) {
    throw new Error("no check decision log: SOLUMBE_CHECK_LOG is off; pass --log <file>");
  }
  const decisions = readDecisions(logPath).filter((record) => record.root === root);

  // One unit per head: every check run before the next commit is the same
  // change, and the arm is a function of the head, so they agree.
  /** @type {Map<string, { head: string, arm: string, checks: number, withheld: number, shownBecause: number }>} */
  const units = new Map();
  for (const record of decisions) {
    const unit = units.get(record.head) ?? { head: record.head, arm: record.arm, checks: 0, withheld: 0, shownBecause: 0 };
    unit.checks += 1;
    if (record.withheld) unit.withheld += 1;
    if (record.shownBecause) unit.shownBecause += 1;
    units.set(record.head, unit);
  }

  const commits = readHistory(root);
  const horizon = commits.reduce((latest, commit) => Math.max(latest, commit.time), 0);
  const fixes = commits.filter((commit) => FIX_SUBJECT.test(commit.subject) && commit.parents.length === 1);
  // The change is the earliest commit whose first parent is the head the
  // check ran against.
  /** @type {Map<string, typeof commits[number]>} */
  const childOf = new Map();
  for (const commit of commits) {
    const parent = commit.parents[0];
    if (!parent || commit.parents.length !== 1) continue;
    const known = childOf.get(parent);
    if (!known || commit.time < known.time) childOf.set(parent, commit);
  }

  const rows = [...units.values()].map((unit) => {
    const commit = childOf.get(unit.head) ?? null;
    return {
      ...unit,
      commit: commit?.sha ?? null,
      time: commit?.time ?? null,
      // A fix is an outcome under the join, so it cannot also be graded, and a
      // commit younger than the window has not had its chance to be repaired.
      isFix: commit ? FIX_SUBJECT.test(commit.subject) : false,
      gradable: Boolean(commit) && !FIX_SUBJECT.test(commit?.subject ?? "") && horizon - (commit?.time ?? horizon) >= windowDays * DAY_SECONDS,
      /** @type {number|null} */
      repairedAfter: null,
    };
  });
  const gradable = rows.filter((row) => row.gradable);
  const { repairedAfter, joinedFixes } = joinRepairs(
    root,
    gradable.map((row) => ({ sha: String(row.commit), time: Number(row.time) })),
    fixes,
  );
  for (const row of gradable) row.repairedAfter = repairedAfter.get(String(row.commit)) ?? null;

  const within = (/** @type {typeof rows[number]} */ row) => row.repairedAfter !== null && row.repairedAfter <= windowDays * DAY_SECONDS;
  const arms = ARMS.map((arm) => {
    const inArm = rows.filter((row) => row.arm === arm);
    const graded = inArm.filter((row) => row.gradable);
    return {
      name: arm,
      changes: inArm.length,
      checks: inArm.reduce((sum, row) => sum + row.checks, 0),
      committed: inArm.filter((row) => row.commit).length,
      fixCommits: inArm.filter((row) => row.isFix).length,
      censored: inArm.filter((row) => row.commit && !row.isFix && !row.gradable).length,
      shownBecauseBlocking: inArm.filter((row) => row.shownBecause).length,
      repaired: proportion(graded.filter(within).length, graded.length, minSample),
    };
  });
  const [shown, withheld] = arms;
  const measured = shown.repaired.ci95 && withheld.repaired.ci95;

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    checkTrialEngineVersion,
    repo: { root, name: path.basename(root), head: repo.git.commit ?? null },
    log: { path: logPath, decisions: decisions.length },
    method: {
      unit: "a change: every check run on one head, graded on the earliest commit whose first parent is that head",
      assignment: "by the hash of the repository root and the head, so a change stays in one arm",
      analysis: "by assigned arm, whether or not the result was shown",
      join: "line-overlap",
      outcome: "repaired",
      fixCommitRule: FIX_COMMIT_RULE,
      interval: "Wilson 95%",
      windowDays,
      minSample,
    },
    range: {
      changes: rows.length,
      committed: rows.filter((row) => row.commit).length,
      graded: gradable.length,
      fixCommits: fixes.length,
      fixCommitsJoined: joinedFixes,
    },
    arms,
    // Fewer repairs in the shown arm than the intervals allow for is the only
    // result that says showing the checks did something. Null until both arms
    // clear the minimum sample.
    fewerRepairsWhenShown: measured
      ? /** @type {[number, number]} */ (shown.repaired.ci95)[1] < /** @type {[number, number]} */ (withheld.repaired.ci95)[0]
      : null,
    changes: rows,
    caveats: [
      "Only the MCP tools are withheld. An agent in the withheld arm can still reach the same result through the command line, the pre-commit hook or CI, which moves the two arms closer together.",
      "A blocking FAIL is shown in both arms, so the trial measures warnings and convergence scores, not the gate's blocking checks.",
      "A change is graded on the first commit made on the head a check ran against. Work that was amended, rebased or squashed before it landed is not followed.",
      "`repaired` is a proxy inherited from calibrate: blame attributes a line to its last toucher, and an unlabelled fix is invisible.",
      `Rates over fewer than ${minSample} changes are withheld rather than published. Two rates whose intervals overlap are not shown to differ.`,
      "This grades one repository on one machine, for the hosts whose MCP server ran with the trial on.",
    ],
  };
  return { ...data, receipt: makeCheckTrialReceipt(data) };
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
export function makeCheckTrialReceipt(data) {
  const canonical = {
    engine: "solumbe-check-trial",
    checkTrialEngineVersion: data.checkTrialEngineVersion,
    method: data.method,
    commit: data.repo.head ?? null,
    range: data.range,
    changes: data.changes.map((/** @type {any} */ row) => [row.head, row.arm, row.checks, row.commit, row.gradable, row.repairedAfter]),
  };
  const inputsHash = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { id: `trial_${inputsHash.slice(0, 12)}`, algorithm: "sha256", commit: canonical.commit, inputsHash };
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatCheckTrialMarkdown(data) {
  const pct = (/** @type {number|null} */ value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const withheld = `_(n < ${data.method.minSample}, withheld)_`;
  const share = (/** @type {any} */ value) =>
    `${value.hits} of ${value.n}${value.publishable ? ` · ${pct(value.rate)} (${pct(value.ci95[0])} to ${pct(value.ci95[1])})` : ` ${withheld}`}`;
  const lines = [
    `# Check trial — ${data.repo.name}`,
    "",
    `Log: ${data.log.path} · ${data.log.decisions} decisions for this repository`,
    `Unit: ${data.method.unit}`,
    `Join: ${data.method.join} · outcome: \`${data.method.outcome}\` · window: ${data.method.windowDays}d · minimum sample: ${data.method.minSample}`,
    `Changes: ${data.range.changes} (${data.range.committed} committed, ${data.range.graded} old enough to grade)`,
    "",
    "| Arm | changes | checks | committed | repaired (of graded) | shown anyway (blocking FAIL) |",
    "| --- | ---: | ---: | ---: | --- | ---: |",
    ...data.arms.map(
      (/** @type {any} */ arm) => `| ${arm.name} | ${arm.changes} | ${arm.checks} | ${arm.committed} | ${share(arm.repaired)} | ${arm.shownBecauseBlocking} |`,
    ),
    "",
    `Fewer repairs when the checks were shown: ${
      data.fewerRepairsWhenShown === null
        ? "unknown (an arm fell below the minimum sample)"
        : data.fewerRepairsWhenShown
          ? "yes"
          : "**no — the intervals overlap**"
    }`,
    "",
    "## Caveats",
    "",
    ...data.caveats.map((/** @type {string} */ caveat) => `- ${caveat}`),
    "",
    `Receipt: \`${data.receipt.id}\` (${data.receipt.algorithm}, inputs ${data.receipt.inputsHash.slice(0, 12)}…)`,
  ];
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
