// Grades the gate's and the convergence score's alarms against what happened
// next in the usage log.
//
// A warning is worth raising when someone acts on it. The usage log already
// holds every gate verdict and convergence score with a timestamp, so the next
// run on the same repository says whether the warning was still there. Per
// check, that is an action rate: of the times it warned and the gate was run
// again, how often had it cleared.
//
// Read beside `solumbe calibrate --gate`: a check whose warnings do not predict
// a repair and are rarely cleared is a false alarm, and a candidate for
// removal. Neither number alone says that.
//
// The log is local and opt-in. Nothing here reads a repository or calls
// anything, and nothing here reaches the gate.

import crypto from "node:crypto";
import path from "node:path";

import { DEFAULT_MIN_SAMPLE } from "./calibrate.js";
import { STATUS } from "./policy.js";
import { wilson } from "./regret.js";
import { inspectRepo } from "./repo.js";
import { readTelemetryLog } from "./telemetry.js";

export const followThroughEngineVersion = "0.1.0";

// The window a follow-up run must land in, in minutes. The same default the
// route outcomes use for a follow-up prompt.
export const DEFAULT_FOLLOW_UP_MINUTES = 60;

// Every command and tool that records a gate verdict, and every one that
// records a convergence score. A review carries the gate's checks inside it.
const GATE_COMMANDS = new Set(["gate", "pass", "pass-pr", "review", "review_gate", "review_verdict"]);
const CONVERGENCE_COMMANDS = new Set(["converge", "convergence_score"]);
const ALARM = new Set([STATUS.warn, STATUS.fail]);

/**
 * The key the usage log groups a repository under: the same hash appendEvent
 * stamps on a record, and extractSignals on a gate result.
 * @param {string} root
 */
export function repoKey(root) {
  return crypto.createHash("sha256").update(String(root)).digest("hex").slice(0, 12);
}

/**
 * @typedef {object} FollowThroughOptions
 * @property {number|string} [windowMin] minutes a follow-up run must land in
 * @property {number|string} [minSample] refuse to publish a rate below this n
 * @property {boolean} [all] grade every repository in the log, not only this one
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * @param {string} [repoPath]
 * @param {FollowThroughOptions} [options]
 * @returns {Record<string, any>}
 */
export function generateFollowThrough(repoPath = ".", options = {}) {
  const log = readTelemetryLog({ env: options.env });
  /** @type {{ root: string, name: string } | null} */
  let repo = null;
  let events = log.events;
  if (!options.all) {
    const inspected = inspectRepo(repoPath);
    const root = inspected.git.root ?? inspected.root;
    repo = { root, name: path.basename(root) };
    const key = repoKey(root);
    events = events.filter((event) => (event?.signals?.repoId ?? event?.repo) === key);
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    followThroughEngineVersion,
    repo,
    log: { path: log.path, events: log.events.length, inScope: events.length, skipped: log.skipped },
    ...gradeFollowThrough(events, options),
  };
}

/**
 * Pair every alarm with the next run on the same repository and grade it.
 * Pure: the events are the whole input.
 * @param {Record<string, any>[]} events usage-log records
 * @param {{ windowMin?: number|string, minSample?: number|string }} [options]
 */
export function gradeFollowThrough(events, options = {}) {
  const windowMin = positiveInt(options.windowMin, DEFAULT_FOLLOW_UP_MINUTES);
  const minSample = positiveInt(options.minSample, DEFAULT_MIN_SAMPLE);
  const windowMs = windowMin * 60000;
  const usable = events.filter((event) => event && typeof event.ts === "number" && event.signals && event.outcome !== "error");
  const share = (/** @type {number} */ hits, /** @type {number} */ n) => proportion(hits, n, minSample);

  // A run is paired only with a run of the same kind: the local gate and the
  // pull request gate run different checks, so a check missing from the other
  // would read as cleared.
  const gateRuns = usable.filter((event) => GATE_COMMANDS.has(event.cmd) && typeof event.signals.verdict === "string");
  const gateGroups = groupBy(gateRuns, (event) => `${event.signals.repoId ?? event.repo}:${event.signals.gateMode ?? "unknown"}`);
  let alarms = 0;
  let followed = 0;
  let cleared = 0;
  let sameChange = 0;
  let comparable = 0;
  /** @type {Map<string, { alarms: number, followed: number, cleared: number, repeated: number, notRun: number }>} */
  const perCheck = new Map();
  for (const runs of gateGroups.values()) {
    runs.sort((a, b) => a.ts - b.ts);
    runs.forEach((run, index) => {
      if (!ALARM.has(run.signals.verdict)) return;
      alarms += 1;
      const next = runs[index + 1];
      const follows = Boolean(next) && next.ts - run.ts <= windowMs;
      if (follows) {
        followed += 1;
        if (next.signals.verdict === STATUS.pass) cleared += 1;
        if (run.signals.changeId && next.signals.changeId) {
          comparable += 1;
          if (run.signals.changeId === next.signals.changeId) sameChange += 1;
        }
      }
      for (const [name, status] of Object.entries(run.signals.checks ?? {})) {
        if (!ALARM.has(status)) continue;
        const row = perCheck.get(name) ?? { alarms: 0, followed: 0, cleared: 0, repeated: 0, notRun: 0 };
        row.alarms += 1;
        // A check the next run did not decide is neither cleared nor repeated:
        // it did not run there, or the log predates per-check records.
        const after = follows ? next.signals.checks?.[name] : undefined;
        if (after === STATUS.pass) {
          row.followed += 1;
          row.cleared += 1;
        } else if (ALARM.has(after)) {
          row.followed += 1;
          row.repeated += 1;
        } else if (follows) {
          row.notRun += 1;
        }
        perCheck.set(name, row);
      }
    });
  }

  const checks = [...perCheck.entries()]
    .map(([name, row]) => ({ name, alarms: row.alarms, repeated: row.repeated, notRun: row.notRun, cleared: share(row.cleared, row.followed) }))
    .sort((a, b) => b.alarms - a.alarms || a.name.localeCompare(b.name));

  // Convergence is scored against a task, so a follow-up is the next score of
  // the same task. Records from before the task was hashed pair on the
  // repository alone.
  const scoreRuns = usable.filter((event) => CONVERGENCE_COMMANDS.has(event.cmd) && typeof event.signals.convergence === "number");
  const scoreGroups = groupBy(scoreRuns, (event) => `${event.signals.repoId ?? event.repo}:${event.signals.requestId ?? ""}`);
  let low = 0;
  let rescored = 0;
  let improved = 0;
  let aligned = 0;
  for (const runs of scoreGroups.values()) {
    runs.sort((a, b) => a.ts - b.ts);
    runs.forEach((run, index) => {
      if (run.signals.band === "aligned") return;
      low += 1;
      const next = runs[index + 1];
      if (!next || next.ts - run.ts > windowMs) return;
      rescored += 1;
      if (next.signals.convergence > run.signals.convergence) improved += 1;
      if (next.signals.band === "aligned") aligned += 1;
    });
  }

  return {
    method: {
      followUp: "the next run of the same kind on the same repository inside the window",
      cleared: "the check that warned or failed passes on the follow-up run",
      interval: "Wilson 95%",
      windowMin,
      minSample,
    },
    gate: {
      runs: gateRuns.length,
      perCheckRuns: gateRuns.filter((event) => event.signals.checks).length,
      alarms,
      followed: share(followed, alarms),
      cleared: share(cleared, followed),
      // Of the follow-ups whose change could be compared, the ones run on the
      // same change: a re-run, not a response.
      sameChange: share(sameChange, comparable),
      checks,
    },
    convergence: {
      runs: scoreRuns.length,
      withTask: scoreRuns.filter((event) => event.signals.requestId).length,
      low,
      rescored: share(rescored, low),
      improved: share(improved, rescored),
      aligned: share(aligned, rescored),
    },
    caveats: [
      "A follow-up is the next run on the same repository, not provably the same change. A new change that never tripped the check reads as the check clearing.",
      "A warning with no follow-up run is not graded as ignored: the change may have been committed as it stood, abandoned, or finished without running the gate again.",
      "In working-tree mode a change is identified by its changed files, so an edit inside the same files reads as the same change.",
      "Per-check results need records written by a version that logs each check's status, and task-level pairing needs the hashed task; older records are graded on the verdict and the repository alone.",
      `Rates over fewer than ${minSample} follow-ups are withheld rather than published. A published rate carries a 95% interval.`,
      "The log covers only this machine, and only while local telemetry was on.",
    ],
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
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
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatFollowThroughMarkdown(data) {
  const pct = (/** @type {number|null} */ value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const withheld = `_(n < ${data.method.minSample}, withheld)_`;
  const share = (/** @type {any} */ value) =>
    `${value.hits} of ${value.n}${value.publishable ? ` · ${pct(value.rate)} (${pct(value.ci95[0])} to ${pct(value.ci95[1])})` : value.n ? ` ${withheld}` : ""}`;
  const gate = data.gate;
  const convergence = data.convergence;
  const lines = [
    `# Follow-through — ${data.repo ? data.repo.name : "every repository in the log"}`,
    "",
    `Log: ${data.log.path} · ${data.log.inScope} of ${data.log.events} events in scope`,
    `Follow-up: ${data.method.followUp} (${data.method.windowMin} minutes) · minimum sample: ${data.method.minSample}`,
    "",
    "## Gate",
    "",
    `Runs: ${gate.runs} (${gate.perCheckRuns} with per-check records) · alarms (WARN or FAIL): ${gate.alarms}`,
    `Followed by another run: ${share(gate.followed)}`,
    `Verdict cleared to PASS on the follow-up: ${share(gate.cleared)}`,
    `Follow-up ran on the same change: ${share(gate.sameChange)}`,
  ];
  if (gate.checks.length) {
    lines.push("", "| Check | alarms | cleared on the follow-up | still alarming | not run again |", "| --- | ---: | --- | ---: | ---: |");
    for (const check of gate.checks) lines.push(`| ${check.name} | ${check.alarms} | ${share(check.cleared)} | ${check.repeated} | ${check.notRun} |`);
  } else {
    lines.push("", "No per-check records yet: the log holds verdicts only until a gate runs on a version that records each check.");
  }
  lines.push(
    "",
    "## Convergence",
    "",
    `Scores: ${convergence.runs} (${convergence.withTask} with a hashed task) · below aligned: ${convergence.low}`,
    `Scored again: ${share(convergence.rescored)}`,
    `Score rose on the follow-up: ${share(convergence.improved)}`,
    `Reached aligned on the follow-up: ${share(convergence.aligned)}`,
    "",
    "## Caveats",
    "",
    ...data.caveats.map((/** @type {string} */ caveat) => `- ${caveat}`),
  );
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
