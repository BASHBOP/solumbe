// Grades the router's tier against the repository's own history.
//
// `solumbe route` recommends cheap, mid or premium from two halves: solumbe's
// deterministic read of the repository (AX, containment, risk paths) and a
// model's read of the request. Neither half has been compared to an outcome.
// This module supplies the comparison the calibration thesis asks for: replay
// history, recompute the tier from the state as it was, and join to the same
// `repaired` outcome `solumbe calibrate` uses for risk flags.
//
// The metric is regret, not accuracy: a change routed cheap that was repaired
// within the window is a recommendation the outcome contradicted. It is never
// "spend avoided": solumbe cannot know whether a host switched models, so
// nothing here can claim a saving.
//
// Three variants are graded side by side so the model half can be read
// against the deterministic half rather than in isolation:
//   deterministic  the tier from AX, containment and bumps alone. Every model
//                  term is zero, so this is the cheapest tier the router can
//                  give a request; a model read can only move it toward premium.
//   offline        the shipped no-key heuristic
//   jev            the System One read, when a key is present
//
// With no key this is a pure function of repository state, recorded in a
// receipt. With a key, the model's answers are not replayable and the receipt
// says so. Nothing here reaches the gate.
//
// Because the model's answers are not replayable, each row keeps the exact
// signals and answers its tiers were scored from, and `rescoreRegret` applies
// the current arithmetic to a saved run without checking anything out or
// calling anything. Two versions of the arithmetic compared on one saved run
// differ only in the arithmetic; compared on two runs they also differ by
// however far the model drifted between them.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers";

import { generateAxScore } from "./ax.js";
import { generateCodeMap } from "./code-map.js";
import { DEFAULT_MIN_SAMPLE, DEFAULT_WINDOW_DAYS, FIX_COMMIT_RULE, FIX_SUBJECT, joinRepairs, readHistory } from "./calibrate.js";
import { generateImpact } from "./impact.js";
import { priceJevCall } from "./jev.js";
import { askJev, modelRouteEngineVersion, NEUTRAL_ANSWERS, offlineAnswers, scoreDecision, signalsFrom, TIERS } from "./model-route.js";
import { inspectRepo } from "./repo.js";
import { runCommand } from "./tools.js";

export const regretEngineVersion = "0.4.1";

/**
 * A commit written by release tooling rather than asked of anyone: a
 * semantic-release `chore(release): 2.26.5 [skip ci]`, a `chore: bump version
 * to 1.4.0`, a bare `1.2.0`, anything marked `[skip ci]`. No host would route
 * one, and the join almost never reads one as repaired: on bashbop-api they
 * were 463 of 1,214 gradable commits, repaired 0.9%, and 353 of the 474
 * commits in the deterministic cheap lane. Graded, they made that lane look
 * clean (10.1%) when the human commits in it were repaired 39.8% of the time,
 * and the keyless heuristic looked inverted for moving them out of it. A
 * subject that merely mentions a release (`release: issue (#277)`) is a
 * request like any other and stays: the rule needs a version number, or the
 * `[skip ci]` marker, beside a chore, build, ci or release type.
 */
export const RELEASE_SUBJECT =
  /\[skip ci\]|^v?\d+\.\d+(\.\d+)?\s*$|^(?=(chore|build|ci|release)\b)(?=.*\b(release|version|prepare|publish)\b)(?=.*\bv?\d+\.\d+)/i;

const DAY_SECONDS = 86400;
const Z95 = 1.96;

const RELEASE_CAVEAT =
  "Release and version-bump commits are not graded: tooling writes them, no model is asked for them, and the join almost never reads one as repaired, so grading them flatters whichever tier they land in.";

export const VARIANTS = /** @type {const} */ (["deterministic", "offline", "jev"]);

/**
 * @typedef {object} RegretOptions
 * @property {number|string} [window] outcome window in days
 * @property {number|string} [minSample] refuse to publish a rate below this n
 * @property {string} [since] only consider commits after this date
 * @property {number|string} [max] cap the number of commits replayed, newest gradable first
 * @property {number|string} [top] ranked files per impact pass
 * @property {boolean} [offline] never call a model, even with a key
 * @property {string} [apiKey]
 * @property {typeof fetch} [fetchImpl]
 * @property {(progress: { done: number, total: number, sha: string, worktree: string }) => void} [onProgress]
 */

/**
 * @param {string} [repoPath]
 * @param {RegretOptions} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function generateRegret(repoPath = ".", options = {}) {
  // Every git process this run starts, including the `git status` that
  // inspectRepo and the code map run inside the replay worktree, inherits an
  // environment with the caller's redirections removed and hooks, filters and
  // fsmonitor switched off. Restored exactly when the run ends.
  const restore = isolateGit(repoPath);
  try {
    return await replay(repoPath, options);
  } finally {
    restore();
  }
}

/**
 * @param {string} repoPath
 * @param {RegretOptions} options
 * @returns {Promise<Record<string, any>>}
 */
async function replay(repoPath, options) {
  const repo = inspectRepo(repoPath);
  if (!repo.git.available) {
    throw new Error(`regret requires a git repository: ${repo.root}`);
  }
  const root = repo.git.root ?? repo.root;
  const windowDays = positiveInt(options.window, DEFAULT_WINDOW_DAYS);
  const minSample = positiveInt(options.minSample, DEFAULT_MIN_SAMPLE);
  const max = options.max === undefined ? Infinity : positiveInt(options.max, Infinity);
  const top = positiveInt(options.top, 8);

  const commits = readHistory(root, options.since);
  if (!commits.length) {
    throw new Error("regret found no non-merge commits to replay");
  }

  // The observation horizon is the newest commit in history, not the clock,
  // so the run stays a function of repository state. A commit younger than
  // the window has not had its chance to be repaired yet; grading it as
  // unrepaired would flatter every tier it landed in, so it is censored.
  const horizon = commits.reduce((latest, commit) => Math.max(latest, commit.time), 0);
  const gradable = (/** @type {{ time: number }} */ commit) => horizon - commit.time >= windowDays * DAY_SECONDS;

  // Fix commits are the outcome, so they cannot also be inputs. Release
  // commits are neither: tooling wrote them, so no router saw a request.
  // Everything else with a parent and a subject is a request the router would
  // have seen, docs-only changes included: a typo fix is a request too.
  const requests = commits.filter((commit) => !FIX_SUBJECT.test(commit.subject) && commit.parents.length === 1 && commit.subject.trim());
  const releases = requests.filter((commit) => RELEASE_SUBJECT.test(commit.subject)).length;
  const candidates = requests.filter((commit) => !RELEASE_SUBJECT.test(commit.subject));
  const censored = candidates.filter((commit) => !gradable(commit)).length;
  const scoreable = candidates.filter(gradable).slice(0, max === Infinity ? undefined : max);
  const fixes = commits.filter((commit) => FIX_SUBJECT.test(commit.subject) && commit.parents.length === 1);
  if (!candidates.length) {
    throw new Error("regret found no non-fix commit with a parent to grade");
  }
  if (!scoreable.length) {
    throw new Error(`regret found no commit old enough to grade: all ${censored} candidates are younger than the ${windowDays}-day window`);
  }
  const { repairedAfter, joinedFixes } = joinRepairs(root, scoreable, fixes);

  const wantsModel = !options.offline && Boolean(options.apiKey ?? process.env.TYPESAFE_API_KEY);
  const model = {
    source: wantsModel ? "jev" : "offline estimate",
    name: /** @type {string|null} */ (null),
    calls: 0,
    failures: 0,
    billableTokens: 0,
    costUsd: 0,
  };

  /** @type {Record<string, any>[]} */
  const graded = [];
  // A Ctrl-C or a kill mid-replay must not leave a worktree registered in the
  // user's repository. The handler only records the signal; the loop yields
  // once per commit so it can arrive, then throws, and `finally` cleans up.
  // The directory and the handler exist before `git worktree add`, so a
  // signal during the first checkout is cleaned up too. The library never
  // exits the process; the CLI turns the error into exit 130 or 143.
  /** @type {NodeJS.Signals|null} */
  let interrupted = null;
  const onInterrupt = (/** @type {NodeJS.Signals} */ signal) => {
    interrupted = signal;
  };
  const yieldForSignals = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted) throw Object.assign(new Error(`regret interrupted by ${interrupted}`), { signal: interrupted });
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-regret-"));
  try {
    addWorktree(root, scoreable[0].parents[0], worktree);
    let done = 0;
    for (const commit of scoreable) {
      await yieldForSignals();
      checkout(root, worktree, commit.parents[0]);
      const request = commit.subject;
      // A fresh map per checkout, handed in directly: the per-user index
      // cache is keyed by root, and a temporary root would leave an orphan
      // entry behind on every run.
      const codeMap = generateCodeMap(worktree);
      const impact = generateImpact(request, { path: worktree, top, codeMap }).data;
      const ax = generateAxScore(request, { path: worktree, top, impact });
      const signals = signalsFrom(impact, ax);

      const deterministic = scoreDecision({ answers: NEUTRAL_ANSWERS, signals });
      const offline = offlineAnswers(request, signals);
      const offlineScore = scoreDecision({ answers: offline.answers, signals });

      /** @type {Record<string, any>} */
      const row = {
        sha: commit.sha,
        subject: commit.subject,
        time: commit.time,
        // Binary-only and empty commits have no text files; they are not docs.
        docsOnly: commit.files.length > 0 && commit.files.every((file) => isDocLike(file.path)),
        // Every signal scoreDecision reads, so a saved run can be rescored.
        ax: signals.ax,
        candidates: signals.candidates ?? 0,
        containment: signals.containment,
        riskPaths: signals.riskPaths ?? [],
        repairedAfter: repairedAfter.get(commit.sha) ?? null,
        tiers: { deterministic: deterministic.tier, offline: offlineScore.tier },
        routes: { deterministic: deterministic.route, offline: offlineScore.route },
        answers: { offline: fractionsOf(offline.answers) },
        // The answers exactly as scored. `answers` above is rounded for the
        // spread table, which is close enough to read and not to rescore: a
        // route one rounding away from a band edge would change tier.
        inputs: { offline: exactAnswers(offline.answers) },
      };

      if (wantsModel) {
        try {
          const jev = await askJev(request, signals, { apiKey: options.apiKey, fetchImpl: options.fetchImpl });
          const scored = scoreDecision({ answers: jev.answers, signals });
          model.calls += 1;
          model.name = model.name ?? jev.model;
          model.billableTokens += jev.billableTokens ?? 0;
          row.tiers.jev = scored.tier;
          row.routes.jev = scored.route;
          row.answers.jev = fractionsOf(jev.answers);
          row.inputs.jev = exactAnswers(jev.answers);
        } catch (error) {
          model.failures += 1;
          row.jevError = String(/** @type {any} */ (error)?.message ?? error).slice(0, 120);
        }
      }

      graded.push(row);
      done += 1;
      options.onProgress?.({ done, total: scoreable.length, sha: commit.sha, worktree });
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    removeWorktree(root, worktree);
  }
  // Priced once from the total, with the same function every surface uses.
  model.costUsd = priceJevCall(model.billableTokens) ?? 0;

  const { base, variants, questions } = gradeRows(graded, windowDays, minSample);

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    regretEngineVersion,
    modelRouteEngineVersion,
    repo: { root, name: path.basename(root), head: repo.git.commit ?? null },
    method: {
      join: "line-overlap",
      outcome: "repaired",
      fixCommitRule: FIX_COMMIT_RULE,
      releaseCommitRule: "subject is marked [skip ci], is a bare version, or is a chore/build/ci/release subject that names a version",
      requestProxy: "commit subject",
      stateAt: "first parent, checked out into a temporary worktree",
      horizon: "the newest commit in history; a commit younger than the window is censored, not graded",
      regret: "a commit routed cheap that was repaired within the window",
      interval: "Wilson 95%",
      windowDays,
      minSample,
      top,
    },
    range: {
      since: options.since ?? null,
      max: max === Infinity ? null : max,
      commits: commits.length,
      candidates: candidates.length,
      censored,
      releaseCommits: releases,
      replayed: graded.length,
      docsOnly: graded.filter((row) => row.docsOnly).length,
      fixCommits: fixes.length,
      fixCommitsJoined: joinedFixes,
    },
    base,
    model: {
      ...model,
      name: model.name ?? (wantsModel ? null : "offline estimate"),
      replayable: !wantsModel,
    },
    variants,
    questions,
    commits: graded,
    caveats: [
      "The request is the commit subject, written after the change, not the prompt that started the work. Whether it reads as more or less specific than the real request is unmeasured.",
      "The state is the first parent's tree. Work in progress, untracked files and the developer's local index are not replayed.",
      "`repaired` is a proxy inherited from calibrate: blame attributes a line to its last toucher, and an unlabelled fix is invisible.",
      "Fix commits are outcomes here, so requests that were themselves fixes are not graded. The router serves them in production.",
      RELEASE_CAVEAT,
      "The tier that was actually used, if any, is unknown; this grades what the router would have said, not what happened.",
      `Rates over fewer than ${minSample} commits are withheld rather than published, the base rate included. A published rate carries a 95% interval; two rates whose intervals overlap are not shown to differ.`,
      ...(wantsModel ? ["The model's answers are not replayable; the receipt covers this run's inputs and outputs, not a recomputation."] : []),
    ],
  };
  return { ...data, receipt: makeRegretReceipt(data) };
}

/**
 * Apply the router's arithmetic to a saved `solumbe regret --json` run and grade
 * it again. Nothing is checked out and no model is called: each row carries
 * the signals and the exact answers it was first scored from, so the only
 * thing that can differ from the saved run is the arithmetic. That is what
 * makes a change to the arithmetic gradable against model answers that cannot
 * be asked for again.
 *
 * `score` defaults to the shipped `scoreDecision`; passing another lets a
 * candidate be graded before it replaces it.
 * @param {Record<string, any>} saved
 * @param {{ score?: typeof scoreDecision }} [options]
 * @returns {Record<string, any>}
 */
export function rescoreRegret(saved, options = {}) {
  const score = options.score ?? scoreDecision;
  const rows = Array.isArray(saved?.commits) ? saved.commits : null;
  if (!rows?.length || !saved.method) {
    throw new Error("rescore needs the JSON of a `solumbe regret --json` run");
  }
  if (rows.some((row) => typeof row.containment !== "number" || !row.inputs?.offline)) {
    throw new Error(
      `this run was saved by regret ${saved.regretEngineVersion ?? "(unknown)"}, which did not keep the signals and answers a rescore needs; replay the repository again`,
    );
  }
  const windowDays = saved.method.windowDays;
  const minSample = saved.method.minSample;

  // A run saved before the corpus rule graded release commits; they leave
  // here, so a rescore grades the same corpus a fresh replay would. The same
  // for a commit the current fix rule reads as a repair: it is an outcome, not
  // a request. Its own repairs cannot be joined without a replay, and the
  // caveat says so.
  const kept = rows.filter((row) => !RELEASE_SUBJECT.test(String(row.subject ?? "")) && !FIX_SUBJECT.test(String(row.subject ?? "")));
  const droppedFixes = rows.filter((row) => FIX_SUBJECT.test(String(row.subject ?? ""))).length;
  const dropped = rows.length - kept.length - droppedFixes;
  if (!kept.length) {
    throw new Error("every commit in this run is a release or fix commit; there is nothing to grade");
  }

  const commits = kept.map((row) => {
    const signals = { ax: row.ax, containment: row.containment, candidates: row.candidates, riskPaths: row.riskPaths };
    const deterministic = score({ answers: NEUTRAL_ANSWERS, signals });
    const offline = score({ answers: row.inputs.offline, signals });
    const tiers = { deterministic: deterministic.tier, offline: offline.tier };
    const routes = { deterministic: deterministic.route, offline: offline.route };
    if (row.inputs.jev) {
      const jev = score({ answers: row.inputs.jev, signals });
      Object.assign(tiers, { jev: jev.tier });
      Object.assign(routes, { jev: jev.route });
    }
    return { ...row, tiers, routes };
  });

  const { base, variants, questions } = gradeRows(commits, windowDays, minSample);
  const rescoredFrom = saved.receipt?.id ?? null;
  /** @type {Record<string, any>} */
  const data = {
    ...saved,
    generatedAt: new Date().toISOString(),
    regretEngineVersion,
    modelRouteEngineVersion,
    method: {
      ...saved.method,
      fixCommitRule: FIX_COMMIT_RULE,
      releaseCommitRule: saved.method.releaseCommitRule ?? "applied at rescore: " + RELEASE_SUBJECT.source,
      rescoredFrom,
    },
    range: {
      ...saved.range,
      replayed: commits.length,
      releaseCommits: (saved.range?.releaseCommits ?? 0) + dropped,
      fixCommits: (saved.range?.fixCommits ?? 0) + droppedFixes,
    },
    base,
    variants,
    questions,
    commits,
    caveats: [
      // A rescore of a rescore names only the run it read, not the whole chain.
      ...saved.caveats.filter((/** @type {string} */ caveat) => !caveat.startsWith("Rescored from") && !caveat.startsWith("Dropped ")),
      ...(saved.caveats.includes(RELEASE_CAVEAT) ? [] : [RELEASE_CAVEAT]),
      ...(dropped
        ? [
            `Dropped ${dropped} release commit${dropped === 1 ? "" : "s"} the saved run had graded; this version's corpus rule leaves them out, so the base rate and every tier are over ${commits.length} commits, not ${rows.length}.`,
          ]
        : []),
      ...(droppedFixes
        ? [
            `Dropped ${droppedFixes} fix commit${droppedFixes === 1 ? "" : "s"} the saved run had graded as requests; this version's fix rule reads them as repairs. The lines they repaired are not joined here, so a replay would count a few more repairs than this rescore does.`,
          ]
        : []),
      `Rescored from ${rescoredFrom ?? "a saved run"}: no commit was replayed and no model was called. The tiers are this version's arithmetic applied to the signals and answers that run recorded.`,
    ],
  };
  delete data.receipt;
  return { ...data, receipt: makeRegretReceipt(data) };
}

/**
 * The base rate, every variant's grade and the question spread over a set of
 * scored rows. Shared by a replay and a rescore so both grade identically.
 * @param {Record<string, any>[]} graded
 * @param {number} windowDays
 * @param {number} minSample
 */
function gradeRows(graded, windowDays, minSample) {
  const within = (/** @type {any} */ row, /** @type {number} */ days) => row.repairedAfter !== null && row.repairedAfter <= days * DAY_SECONDS;
  const base = summarizeRows("base", graded, windowDays, minSample, within, null);

  /** @type {Record<string, any>} */
  const variants = {};
  for (const variant of VARIANTS) {
    const rows = graded.filter((row) => row.tiers[variant] !== undefined);
    if (!rows.length) continue;
    variants[variant] = gradeVariant(variant, rows, windowDays, minSample, within);
  }

  /** @type {Record<string, any>} */
  const questions = {};
  for (const variant of ["offline", "jev"]) {
    const rows = graded.filter((row) => row.answers[variant]);
    if (!rows.length) continue;
    questions[variant] = ["specificity", "blast_radius", "novelty"].map((name) =>
      spread(
        name,
        rows.map((row) => row.answers[variant][name]),
      ),
    );
  }

  return { base: { rate: base.rate, ci95: base.ci95, repaired: base.repaired, n: base.n, publishable: base.publishable }, variants, questions };
}

/**
 * Per-tier repair rate and lift for one variant against that variant's own
 * rows, the ordering check, and the regret count.
 * @param {string} variant
 * @param {Record<string, any>[]} rows
 * @param {number} windowDays
 * @param {number} minSample
 * @param {(row: any, days: number) => boolean} within
 */
function gradeVariant(variant, rows, windowDays, minSample, within) {
  // The model variant grades only the commits it answered, so its base rate
  // is over those rows, not the whole corpus.
  const base = summarizeRows("base", rows, windowDays, minSample, within, null);
  const tiers = TIERS.map((tier) =>
    summarizeRows(
      tier,
      rows.filter((row) => row.tiers[variant] === tier),
      windowDays,
      minSample,
      within,
      base.rate,
    ),
  );
  const rates = tiers.map((row) => row.rate);
  const measured = rates.every((rate) => rate !== null);
  const cheap = summarizeRows(
    "cheap",
    rows.filter((row) => row.tiers[variant] === "cheap"),
    windowDays,
    minSample,
    within,
    null,
  );
  return {
    n: rows.length,
    base: { rate: base.rate, ci95: base.ci95, repaired: base.repaired, n: base.n, publishable: base.publishable },
    tiers,
    // Cheap should be repaired least and premium most if the tier orders
    // changes by how much care they needed. Claimed only when every band
    // cleared the minimum sample.
    monotonic: measured ? rates[0] < rates[1] && rates[1] < rates[2] : null,
    contradicted: { n: cheap.repaired, ofCheap: cheap.n, rate: cheap.rate, ci95: cheap.ci95, publishable: cheap.publishable },
  };
}

/**
 * Counts always; rate, interval and lift only above the minimum sample.
 * @param {string} name
 * @param {Record<string, any>[]} matching
 * @param {number} windowDays
 * @param {number} minSample
 * @param {(row: any, days: number) => boolean} within
 * @param {number|null} baseRate
 */
function summarizeRows(name, matching, windowDays, minSample, within, baseRate) {
  const n = matching.length;
  const repaired = matching.filter((row) => within(row, windowDays)).length;
  const publishable = n >= minSample;
  const rate = publishable && n ? repaired / n : null;
  return {
    name,
    n,
    repaired,
    rate: rate === null ? null : round(rate),
    ci95: rate === null ? null : wilson(repaired, n),
    lift: rate === null || !baseRate ? null : round(rate / baseRate),
    publishable,
  };
}

/**
 * Wilson score interval: honest at small n and at rates near zero, which is
 * where these tables live.
 * @param {number} successes
 * @param {number} n
 * @returns {[number, number]}
 */
export function wilson(successes, n) {
  if (!n) return [0, 0];
  const p = successes / n;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [round(Math.max(0, centre - half)), round(Math.min(1, centre + half))];
}

/**
 * The model's answers as the fractions the arithmetic uses, so a question that
 * cannot separate its inputs shows as a flat distribution here.
 * @param {any} answers
 */
function fractionsOf(answers) {
  const num = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const specificity = num(answers?.specificity?.score);
  const blast = num(answers?.blast_radius?.score);
  const novelty = num(answers?.novelty?.noul);
  return {
    specificity: specificity === null ? null : round(specificity / 2),
    blast_radius: blast === null ? null : round(blast / 2),
    novelty: novelty === null ? null : round(novelty),
  };
}

/**
 * The fields of an answer set the arithmetic can read, unrounded: the Score
 * expectation, its confidence and level distribution, and the Noul
 * probability. Kept whole so an arithmetic that reads the distribution rather
 * than its expectation can be graded on the same saved run.
 * @param {any} answers
 */
function exactAnswers(answers) {
  const score = (/** @type {any} */ answer) => ({
    score: answer?.score ?? null,
    confidence: answer?.confidence ?? null,
    probabilities: answer?.probabilities ?? null,
  });
  return {
    specificity: score(answers?.specificity),
    blast_radius: score(answers?.blast_radius),
    novelty: { noul: answers?.novelty?.noul ?? null },
  };
}

/**
 * @param {string} name
 * @param {(number|null)[]} values
 */
function spread(name, values) {
  const nums = values.filter((value) => typeof value === "number");
  if (!nums.length) return { name, n: 0, mean: null, min: null, max: null, stdev: null };
  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const variance = nums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nums.length;
  return { name, n: nums.length, mean: round(mean), min: round(Math.min(...nums)), max: round(Math.max(...nums)), stdev: round(Math.sqrt(variance)) };
}

/** @param {string} filePath */
function isDocLike(filePath) {
  return /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(filePath) || /^docs?\//i.test(filePath);
}

const REDIRECTIONS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/;

/**
 * Put process.env into the state the replay needs and return a function that
 * puts it back exactly. Set on process.env rather than per call because git
 * also runs inside helpers this module does not own (inspectRepo, the code
 * map), and a `git status` there fires post-index-change hooks.
 *
 * - The caller's GIT_* redirections are removed, so a run started from a hook
 *   or wrapper reads and writes the repository it was asked about.
 * - Hooks are pointed at the null device, fsmonitor is off, and every
 *   configured smudge or process filter is emptied (LFS, git-crypt, custom),
 *   so checking out a historical tree runs nothing, decrypts nothing and
 *   fetches nothing. Settings go through GIT_CONFIG_COUNT (git 2.31+), after
 *   any the caller already set.
 * @param {string} repoPath
 * @returns {() => void}
 */
export function isolateGit(repoPath) {
  /** @type {Record<string, string|undefined>} */
  const saved = {};
  const set = (/** @type {string} */ key, /** @type {string|undefined} */ value) => {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  for (const key of Object.keys(process.env)) {
    if (REDIRECTIONS.test(key)) set(key, undefined);
  }
  set("GIT_LFS_SKIP_SMUDGE", "1");

  /** @type {[string, string][]} */
  const pairs = [
    ["core.hooksPath", os.devNull],
    ["core.fsmonitor", "false"],
    ["filter.lfs.smudge", ""],
    ["filter.lfs.process", ""],
    ["filter.lfs.required", "false"],
  ];
  const configured = runCommand("git", ["config", "--get-regexp", "^filter\\..*\\.(smudge|process)$"], { cwd: path.resolve(repoPath) });
  for (const line of configured.ok ? configured.stdout.split("\n") : []) {
    const match = /^filter\.(.+)\.(smudge|process)\s/.exec(line);
    if (!match || match[1] === "lfs") continue;
    pairs.push([`filter.${match[1]}.smudge`, ""], [`filter.${match[1]}.process`, ""], [`filter.${match[1]}.required`, "false"]);
  }
  const offset = Number(process.env.GIT_CONFIG_COUNT) || 0;
  pairs.forEach(([key, value], index) => {
    set(`GIT_CONFIG_KEY_${offset + index}`, key);
    set(`GIT_CONFIG_VALUE_${offset + index}`, value);
  });
  set("GIT_CONFIG_COUNT", String(offset + pairs.length));

  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  return runCommand("git", args, { cwd });
}

/**
 * Check `sha` out into `dir`, which the caller created with mkdtemp and will
 * remove; git accepts an existing empty directory. Shared with the gate
 * calibration replay, which names itself in `label`.
 * @param {string} root
 * @param {string} sha
 * @param {string} dir
 * @param {string} [label]
 */
export function addWorktree(root, sha, dir, label = "regret") {
  const result = git(root, ["worktree", "add", "--detach", "--quiet", dir, sha]);
  if (!result.ok) {
    throw new Error(`${label} could not check out ${sha.slice(0, 7)} into a worktree: ${result.stderr || result.stdout}`);
  }
}

/**
 * @param {string} root
 * @param {string} worktree
 * @param {string} sha
 * @param {string} [label]
 */
export function checkout(root, worktree, sha, label = "regret") {
  const result = git(worktree, ["checkout", "--quiet", "--detach", sha]);
  if (!result.ok) {
    throw new Error(`${label} could not check out ${sha.slice(0, 7)} in ${root}: ${result.stderr || result.stdout}`);
  }
}

/**
 * @param {string} root
 * @param {string} worktree
 */
export function removeWorktree(root, worktree) {
  // Only this run's worktree is touched. No `git worktree prune`: it would
  // also drop the user's own entries whose directories happen to be absent,
  // for instance a worktree on an unmounted drive.
  git(root, ["worktree", "remove", "--force", worktree]);
  if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
}

/**
 * Deterministic receipt over a canonical, timestamp-free payload.
 * @param {Record<string, any>} data
 */
export function makeRegretReceipt(data) {
  const canonical = {
    engine: "solumbe-regret",
    regretEngineVersion: data.regretEngineVersion,
    modelRouteEngineVersion: data.modelRouteEngineVersion,
    method: data.method,
    commit: data.repo.head ?? null,
    range: data.range,
    base: data.base,
    model: { source: data.model.source, name: data.model.name, calls: data.model.calls, failures: data.model.failures },
    variants: Object.fromEntries(
      Object.entries(data.variants).map(([name, variant]) => [
        name,
        {
          tiers: variant.tiers.map((/** @type {any} */ row) => [row.name, row.n, row.repaired, row.rate]),
          monotonic: variant.monotonic,
          contradicted: [variant.contradicted.n, variant.contradicted.ofCheap],
        },
      ]),
    ),
    commits: data.commits.map((/** @type {any} */ row) => [row.sha, row.tiers.deterministic, row.tiers.offline, row.tiers.jev ?? null, row.repairedAfter]),
  };
  const inputsHash = crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { id: `regret_${inputsHash.slice(0, 12)}`, algorithm: "sha256", commit: canonical.commit, inputsHash, replayable: data.model.replayable };
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatRegretMarkdown(data) {
  const pct = (/** @type {number|null} */ value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
  const ci = (/** @type {[number, number]|null} */ value) => (value ? ` (${pct(value[0])} to ${pct(value[1])})` : "");
  const lift = (/** @type {number|null} */ value) => (value === null ? "—" : `${value.toFixed(2)}x`);
  const withheld = ` _(n < ${data.method.minSample}, withheld)_`;
  const lines = [
    `# Route regret — ${data.repo.name}`,
    "",
    `Join: ${data.method.join} · outcome: \`${data.method.outcome}\` · window: ${data.method.windowDays}d · minimum sample: ${data.method.minSample}`,
    `Request: ${data.method.requestProxy} · state: ${data.method.stateAt}`,
    `Corpus: ${data.range.replayed} commits replayed (${data.range.docsOnly} docs-only) of ${data.range.candidates} candidates; ${data.range.censored} younger than the window, not graded; ${data.range.releaseCommits ?? 0} release commits, not graded; ${data.range.fixCommits} fix commits (${data.range.fixCommitsJoined} joined)`,
    `Base rate: ${data.base.publishable ? `${pct(data.base.rate)}${ci(data.base.ci95)}` : withheld.trim()} (${data.base.repaired}/${data.base.n})`,
    `Model: ${data.model.name ?? data.model.source}${data.model.calls ? `, ${data.model.calls} calls, ${data.model.failures} failed, $${data.model.costUsd.toFixed(4)}` : ""}`,
    ...(data.method.rescoredFrom === undefined
      ? []
      : [
          `Rescored from \`${data.method.rescoredFrom ?? "a saved run"}\`: saved signals and answers, route engine ${data.modelRouteEngineVersion}; nothing replayed, no model called`,
        ]),
    "",
    "Regret is a commit routed cheap that was repaired within the window. It is never a saving: solumbe does not know which model was used. Two rates whose intervals overlap are not shown to differ.",
  ];
  for (const [name, variant] of Object.entries(data.variants)) {
    lines.push(
      "",
      `## ${name}`,
      "",
      `Base over these ${variant.n} commits: ${variant.base.publishable ? `${pct(variant.base.rate)}${ci(variant.base.ci95)}` : withheld.trim()}`,
      "",
      "| Tier | n | repaired | 95% interval | lift |",
      "| --- | ---: | ---: | --- | ---: |",
    );
    for (const row of variant.tiers) {
      lines.push(
        `| ${row.name} | ${row.n} | ${row.publishable ? pct(row.rate) : `${row.repaired}${withheld}`} | ${row.ci95 ? `${pct(row.ci95[0])} to ${pct(row.ci95[1])}` : "—"} | ${lift(row.lift)} |`,
      );
    }
    const order =
      variant.monotonic === null ? "unknown (a tier fell below the minimum sample)" : variant.monotonic ? "yes" : "**no — the tier does not order outcomes**";
    lines.push("", `Monotonic (cheap < mid < premium): ${order}`);
    const c = variant.contradicted;
    lines.push(`Contradicted: ${c.n} of ${c.ofCheap} routed cheap were repaired${c.publishable ? ` (${pct(c.rate)}${ci(c.ci95)})` : withheld}`);
  }
  for (const [name, rows] of Object.entries(data.questions)) {
    lines.push("", `## Question spread (${name})`, "", "| Question | n | mean | min | max | stdev |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const row of rows) {
      const f = (/** @type {number|null} */ value) => (value === null ? "—" : value.toFixed(2));
      lines.push(`| ${row.name} | ${row.n} | ${f(row.mean)} | ${f(row.min)} | ${f(row.max)} | ${f(row.stdev)} |`);
    }
    lines.push("", "A question whose answers barely move across the corpus is not separating its inputs.");
  }
  lines.push("", "## Caveats", "");
  for (const caveat of data.caveats) lines.push(`- ${caveat}`);
  lines.push(
    "",
    `Receipt: \`${data.receipt.id}\` (${data.receipt.algorithm}, inputs ${data.receipt.inputsHash.slice(0, 12)}…${data.receipt.replayable ? "" : ", not replayable"})`,
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
