// Model routing: score a coding task before spending tokens on it.
//
// Two halves that must not be confused. solumbe answers the REPOSITORY half
// deterministically (AX, containment, canonical risk flags). A System One model
// answers the REQUEST half with calibrated probabilities. Combining them is
// arithmetic you can read, in code, here.
//
// The router runs before work starts and decides how much model to spend. It is
// not the gate and must never become one: a failed, unreachable, or unkeyed
// model call costs a tier, never a verdict. See docs/18-model-routing.
//
// A valid hosted tier sets the base recommendation. The weighted score is a
// local fallback and comparison point. Neither has been graded against actual
// task outcomes. See docs/17-calibration-thesis.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateAxScore } from "./ax.js";
import { generateImpact } from "./impact.js";
import { classifyPath, isProseFile, isTestDataPath, RISK_SCORE_WEIGHTS } from "./risk-paths.js";
import { askSystemOne, interpretRead, pickAnswers, priceJevCall, readQuestions } from "./jev.js";

export const modelRouteEngineVersion = "0.2.0";

export const TIERS = /** @type {const} */ (["cheap", "mid", "premium"]);
export const BAND_CHEAP = 75;
export const BAND_MID = 45;
/**
 * Display threshold only: below this a rendered confidence reads as weak.
 *
 * Deliberately not a routing input. Confidence used to drive a tier bump off
 * `Math.min` of both Score answers, which let one unsure question discard a
 * confident one: a rename that named its own file and symbol scored specificity
 * 1.00 at confidence 1.00, and still routed premium because `blast_radius` was
 * a hundredth under the floor at 0.54. It also double-counted, because `score`
 * is the expectation over that question's own level distribution, so a spread
 * answer already pays through its own term. Measured on this repository it
 * escalated 67% of requests. See docs/18-model-routing.
 */
export const CONFIDENCE_FLOOR = 0.55;

/**
 * A risk flag escalates a tier only when solumbe already weights it at top
 * severity. Reading RISK_SCORE_WEIGHTS keeps one source of truth instead of a
 * second hand-written list of scary paths.
 */
export const BUMP_WEIGHT = 3;

export const BLAST_LEVELS = ["one file", "one module", "cross-cutting"];
export const SPECIFICITY_LEVELS = ["names the target", "names an area", "names a symptom"];

/** Each term takes a share of AX, never a flat number of points. */
export const SHARES = [
  { label: "specificity", weight: 0.25 },
  { label: "blast radius", weight: 0.2 },
  { label: "novelty", weight: 0.15 },
];
export const CONTAINMENT_BONUS = 0.1;
export const CONTAINMENT_THRESHOLD = 40;

/**
 * The deterministic half on its own: every model term at zero, so the route
 * is AX plus containment plus the bumps. `solumbe regret` grades it as a variant
 * and `solumbe route` reports it beside the scored tier.
 */
export const NEUTRAL_ANSWERS = {
  specificity: { score: 0, confidence: null },
  blast_radius: { score: 0, confidence: null },
  novelty: { noul: 0 },
};

/**
 * Only claude-code ships filled in, because those are the ids this repository
 * can verify. Add others in `.solumbe/model-route.json` (repo) or
 * `~/.solumbe/model-route.json` (user); the repo file wins.
 */
export const BUILTIN_HOSTS = {
  "claude-code": {
    cheap: "claude-haiku-4-5-20251001",
    mid: "claude-sonnet-5",
    premium: "claude-opus-5-5",
  },
};

const TIER_QUESTION = {
  type: "choice",
  instructions: "Recommend the least capable model tier likely to complete this coding task successfully. Consider the request and repository evidence.",
  criteria: {
    cheap: "A clear, localized change that follows an existing pattern.",
    mid: "A moderately ambiguous change, or one requiring some reasoning across related files.",
    premium: "A difficult investigation, novel design, or cross-cutting change that needs sustained reasoning.",
  },
};

export const QUESTIONS = {
  // `specificity` began as a Noul asking whether the request was ambiguous
  // enough that a wrong reading would produce the wrong change. Measured over a
  // real corpus it answered 0.57 to 0.81 for every request, including a typo
  // fix: correct answers to a question that cannot separate its inputs. A Score
  // over levels you can point at in the text discriminates instead.
  specificity: {
    type: "score",
    instructions: "How precisely does this request name the thing that has to change?",
    criteria: [
      "The request names the exact file, symbol, flag or user-visible string to change.",
      "The request names a feature or area, but not which code in it changes.",
      "The request names only a symptom or a desired outcome; what to change must be found first.",
    ],
  },
  blast_radius: {
    type: "score",
    instructions: "How far do the edits this request implies reach across the codebase?",
    criteria: [
      "The change is contained to a single file.",
      "The change touches several files inside one module or feature area.",
      "The change reaches across module boundaries or shared contracts.",
    ],
  },
  novelty: {
    type: "noul",
    instructions: "Does this request require designing something new, rather than applying a pattern the codebase already uses?",
  },
};

/**
 * Read host model maps, built-ins first, then user config, then repo config.
 * @param {string} [repo]
 * @returns {Record<string, Record<string, string>>}
 */
export function loadHosts(repo = ".") {
  /** @type {Record<string, Record<string, string>>} */
  const hosts = { ...BUILTIN_HOSTS };
  const files = [path.join(os.homedir(), ".solumbe", "model-route.json"), path.join(path.resolve(repo), ".solumbe", "model-route.json")];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [host, map] of Object.entries(parsed.hosts ?? {})) {
        hosts[host] = { ...(hosts[host] ?? {}), ...map };
      }
    } catch {
      // An absent or unreadable config is not an error; built-ins still apply.
    }
  }
  return hosts;
}

/**
 * The model id a host calls a tier. The CLI and the MCP tool both resolve a
 * host this way, so an unknown host fails with the same remedy on each.
 * @param {string} repo
 * @param {string} host
 * @param {string} tier
 * @returns {string}
 */
export function hostModelFor(repo, host, tier) {
  const hosts = loadHosts(repo);
  const map = hosts[host];
  if (!map) {
    throw new Error(`no model map for host "${host}". Known: ${Object.keys(hosts).join(", ")}. ` + "Add one in .solumbe/model-route.json, or use --tier-only.");
  }
  return map[tier];
}

/**
 * Derive the deterministic half from an impact pass and an AX score that the
 * caller already computed. Taking both as arguments is what lets `solumbe route`
 * run one impact pass instead of the two a naive composition would run.
 * @param {any} impact
 * @param {any} ax
 */
export function signalsFrom(impact, ax) {
  // Which files to classify is a real trade-off, settled by measurement:
  // classify everything and an unrelated billing component turns a copy change
  // into a money-flow change; classify only the owner and supporting buckets
  // and a file ranked FIRST for an auth request sits in the advisory bucket
  // while the auth/security bump never fires. Rank is evidence, the bucket is
  // a label, so the top ranked predictions are classified whatever bucket they
  // landed in.
  const owners = impact.classifications?.requiredOwners ?? [];
  const candidates = [...owners, ...(impact.classifications?.supportingFiles ?? [])];
  for (const file of (impact.topFiles ?? []).slice(0, 3).map((/** @type {any} */ f) => f.path)) {
    if (!candidates.includes(file)) candidates.push(file);
  }

  // The ranked files carry the code map's `kind`, which is the only place the
  // risk filter below can learn that a path is prose. Owner and supporting
  // buckets are bare paths, so a candidate the ranking did not reach falls
  // back to the path-shape test inside `isProseFile`.
  /** @type {Map<string, string>} */
  const kindByPath = new Map((impact.topFiles ?? []).map((/** @type {any} */ f) => [f.path, f.kind]));

  // Fixture corpora and tests still count toward reach, but they never carry a
  // risk flag: routing this repository read its own shop-api eval fixture as
  // money-flow code and escalated a request that touched nothing shipped.
  // The evals run solumbe inside those fixture directories, where the paths
  // are fixture-relative, so a fixture's own risk is still visible to the run
  // it is a fixture for.
  //
  // Documentation is excluded for the same reason and one of its own: the risk
  // bump escalates because a change *touches* a risky area, and prose about an
  // area touches none of it. Since #175 indexed markdown, a README typo in a
  // repository that happens to ship `docs/AUTH_TOKEN_VALIDATION.md` classified
  // as auth/security and forced `premium` off that single file.
  //
  // Excluded outright, not merely when it is the sole evidence for a flag. A
  // doc is never evidence that a change is risky: where real code carries the
  // flag the doc adds nothing to the decision, and where it does not, listing
  // the doc as "risk evidence" asserts something untrue. This is the rule
  // `isGateRiskPath` already applies to the merge gates.
  //
  // Note this reads `kind` only to recognise prose. Feeding it to
  // `classifyPath` would also switch on the kind-matched patterns (a `schema`
  // file would newly flag data model, weight 3, and bump), which is a separate
  // change that needs its own measurement.
  /** @type {Map<string, string[]>} */
  const flagged = new Map();
  for (const file of candidates) {
    if (isTestDataPath(file)) continue;
    if (isProseFile(file, kindByPath.get(file))) continue;
    for (const flag of classifyPath(file)) {
      if (!flagged.has(flag)) flagged.set(flag, []);
      /** @type {string[]} */ (flagged.get(flag)).push(file);
    }
  }

  // How many distinct top-level areas the candidates span. Containment is
  // already inside AX at weight 0.30, so reading it again to describe reach
  // would count the same signal twice.
  const areas = new Set(candidates.map((f) => String(f).split("/")[0]));

  return {
    repoName: impact.repo?.name ?? null,
    ax: ax.ax,
    containment: ax.subScores.containment,
    owners: owners.length,
    candidates: candidates.length,
    moduleSpread: areas.size,
    riskPaths: [...flagged.keys()],
    riskEvidence: Object.fromEntries(flagged),
    topFile: impact.topFiles?.[0]?.path ?? null,
    // Ranked evidence, so the model grades the request against this codebase
    // rather than in the abstract. Sending the prompt and a few numbers alone
    // produced uniformly high uncertainty, correctly: nothing in that state
    // said what the request referred to.
    evidence: (impact.topFiles ?? []).slice(0, 6).map((/** @type {any} */ f) => ({
      path: f.path,
      kind: f.kind,
      why: (f.reasons ?? []).slice(0, 3),
    })),
  };
}

/**
 * Normalise a Score distribution onto level NAMES, whichever way the API keys
 * it, so nothing downstream branches on provider formatting.
 * @param {any} answer
 * @param {string[]} levels
 */
function nameProbabilities(answer, levels) {
  if (!answer?.probabilities) return;
  const raw = answer.probabilities;
  /** @type {Record<string, number>} */
  const named = {};
  if (Array.isArray(raw)) {
    raw.forEach((value, index) => {
      named[levels[index] ?? `level ${index}`] = value;
    });
  } else {
    for (const [key, value] of Object.entries(raw)) {
      const asIndex = Number(key);
      named[Number.isInteger(asIndex) && levels[asIndex] ? levels[asIndex] : key] = /** @type {number} */ (value);
    }
  }
  answer.probabilities = named;
}

/**
 * Ask the System One model the route questions, and the request-read questions
 * alongside them, in one call.
 *
 * Folding the read into the route call is TypeSafe's speculative fan-out: the
 * questions are evaluated independently against one state, so asking what kind
 * of work this is, which solumbe tool answers it, and whether each ranked file
 * matters costs input tokens and no extra round trip. The read is REPORTED in
 * `read`; `scoreDecision` never sees it, so it cannot move a tier.
 *
 * @param {string} request
 * @param {ReturnType<typeof signalsFrom>} signals
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function askJev(request, signals, options = {}) {
  const state = {
    request,
    repository: {
      name: signals.repoName,
      agent_experience: signals.ax,
      containment: signals.containment,
    },
    likely_files: signals.evidence,
    risk_flags: signals.riskPaths,
  };
  const read = readQuestions({ files: signals.evidence ?? [] });

  const routingQuestions = { ...QUESTIONS, recommended_tier: TIER_QUESTION };
  const reply = await askSystemOne(state, { ...routingQuestions, ...read }, options);
  const answers = pickAnswers(reply.answers, routingQuestions);
  if (typeof answers.specificity?.score !== "number" || typeof answers.blast_radius?.score !== "number" || typeof answers.novelty?.noul !== "number") {
    throw new Error("TypeSafe reply omitted routing diagnostics");
  }
  nameProbabilities(answers.blast_radius, BLAST_LEVELS);
  nameProbabilities(answers.specificity, SPECIFICITY_LEVELS);

  return {
    ...reply,
    answers,
    read: interpretRead(reply.answers, signals.evidence ?? []),
  };
}

const clamp01 = (/** @type {number} */ value) => Math.max(0, Math.min(1, value));

/**
 * A deterministic stand-in so the router runs with no key and no network. These
 * are heuristics, NOT calibrated probabilities, and every surface that prints
 * them says so.
 * @param {string} request
 * @param {ReturnType<typeof signalsFrom>} signals
 */
export function offlineAnswers(request, signals) {
  const text = String(request).toLowerCase();
  const has = (/** @type {string[]} */ ...words) => words.some((word) => text.includes(word));

  let specificity = 0.6;
  if (has("figure out", "find out", "investigate", "somewhere", "something", "not sure")) specificity += 0.8;
  if (has("why", "broken", "wrong", "failing")) specificity += 0.4;
  if (has("typo", "rename", "bump", "flag", "copy", "wording", "string")) specificity -= 0.45;
  specificity = Math.max(0, Math.min(2, specificity));

  let novelty = 0.1;
  if (has("design", "introduce", "add support", "migrate", "rework", "rearchitect")) novelty += 0.4;
  if (has("typo", "bump", "rename", "copy", "wording")) novelty -= 0.06;

  // Reach reads the request and the candidate spread, never containment, which
  // AX already counts.
  let spread = (signals.owners > 1 ? (signals.owners - 1) * 0.5 : 0) + Math.max(0, signals.moduleSpread - 1) * 0.4;
  if (has("typo", "copy", "wording", "label", "rename", "comment")) spread = Math.min(spread, 0.2);
  if (has("across", "everywhere", "refactor", "rework", "migrate")) spread += 0.6;
  spread = Math.max(0, Math.min(2, spread));

  const blast = distribute(spread);
  const spec = distribute(specificity);

  // The distributions above are the shape of `distribute`, not a measurement:
  // a request the keyword lists do not recognise sits at the 0.6 baseline,
  // whose peak is 0.40, so reading it as confidence bumped every unknown
  // request one tier. An estimate with no confidence says so with null and
  // leaves the low-confidence bump to answers that measured one.

  return /** @type {{ source: string, model: string, tokens: number|null, billableTokens: number|null, tokenKind: string|null, latencyMs: number, answers: any, read: import("./jev.js").RequestRead|null, fallbackReason?: string }} */ ({
    source: "offline",
    model: "offline-heuristic",
    tokens: null,
    billableTokens: null,
    tokenKind: null,
    latencyMs: 0,
    // A keyword heuristic has no read of the request to offer, and says so.
    read: null,
    answers: {
      specificity: {
        type: "score",
        score: round2(specificity),
        confidence: null,
        probabilities: named(spec, SPECIFICITY_LEVELS),
      },
      blast_radius: {
        type: "score",
        score: round2(spread),
        confidence: null,
        probabilities: named(blast, BLAST_LEVELS),
      },
      novelty: { type: "noul", noul: round2(clamp01(novelty)) },
    },
  });
}

/**
 * Spread a 0..2 position across three ordered levels.
 * @param {number} position
 * @returns {number[]}
 */
function distribute(position) {
  const dist = [0, 0, 0];
  dist[0] = Math.max(0.03, 1 - position);
  dist[2] = Math.max(0.03, position / 2);
  dist[1] = Math.max(0.03, 1 - dist[0] - dist[2]);
  const total = dist.reduce((a, b) => a + b, 0);
  return dist.map((value) => value / total);
}
const named = (/** @type {number[]} */ dist, /** @type {string[]} */ levels) => Object.fromEntries(levels.map((k, i) => [k, Number(dist[i].toFixed(3))]));
const round2 = (/** @type {number} */ value) => Number(Number(value).toFixed(2));

/**
 * The arithmetic. Every term is visible so a tier can be traced to its inputs.
 * `signals` names only the fields read here: `solumbe regret` saves exactly these
 * per row so a saved run can be rescored, and reading a new one must fail the
 * type check there rather than rescore on a field the run never kept.
 * @param {{ answers: any, signals: Pick<ReturnType<typeof signalsFrom>, "ax" | "containment" | "candidates" | "riskPaths"> }} input
 */
export function scoreDecision({ answers, signals }) {
  const ax = signals.ax;
  /** @type {{label: string, detail: string, delta: number|null, from: number, to: number}[]} */
  const steps = [];
  let running = ax;
  steps.push({ label: "AX", detail: "solumbe, deterministic", delta: null, from: 0, to: running });

  // `score` is the expectation over that question's own level distribution, so
  // a spread answer already pulls its own term toward the expensive end. That
  // is the whole of the uncertainty this term is entitled to charge for.
  /** @type {Record<string, number>} */
  const fractions = {
    specificity: answers.specificity.score / 2,
    "blast radius": answers.blast_radius.score / 2,
    novelty: answers.novelty.noul,
  };

  for (const { label, weight } of SHARES) {
    const delta = -ax * weight * fractions[label];
    const from = running;
    running = from + delta;
    steps.push({
      label,
      detail: `-${(weight * 100).toFixed(0)}% x ${fractions[label].toFixed(2)}`,
      delta: round2(delta),
      from,
      to: running,
    });
  }

  if (signals.containment >= CONTAINMENT_THRESHOLD) {
    const from = running;
    running = from + ax * CONTAINMENT_BONUS;
    steps.push({
      label: "containment",
      detail: `+${(CONTAINMENT_BONUS * 100).toFixed(0)}% of AX when >= ${CONTAINMENT_THRESHOLD}`,
      delta: round2(ax * CONTAINMENT_BONUS),
      from,
      to: running,
    });
  }

  const raw = running;
  const route = Math.max(0, Math.min(100, raw));
  const heuristicTier = route >= BAND_CHEAP ? "cheap" : route >= BAND_MID ? "mid" : "premium";
  const choice = answers.recommended_tier?.choice;
  const modelRecommended = choice === "cheap" || choice === "mid" || choice === "premium";
  const baseTier = modelRecommended ? choice : heuristicTier;
  let index = TIERS.indexOf(baseTier);

  const severe = (signals.riskPaths ?? []).filter((flag) => (RISK_SCORE_WEIGHTS[flag] ?? 0) >= BUMP_WEIGHT);
  // Reported for display, never routed on. The weakest of the two Score answers
  // is the honest summary of how well this read is supported, but it is NOT a
  // tier input: each answer's uncertainty is already priced into its own term
  // above. Bumping on the minimum as well let one unsure question throw away a
  // confident one and double-counted the same doubt. Measured on this repo, it
  // escalated 67% of requests, a one-file rename among them.
  const measured = [answers.blast_radius.confidence, answers.specificity.confidence].filter((/** @type {unknown} */ value) => typeof value === "number");
  const confidence = measured.length ? Math.min(...measured) : null;
  // Each question's own confidence, so a reader sees which answer is weak
  // instead of only the weaker of the two. Display only, like `confidence`.
  const confidences = {
    specificity: typeof answers.specificity.confidence === "number" ? answers.specificity.confidence : null,
    blast_radius: typeof answers.blast_radius.confidence === "number" ? answers.blast_radius.confidence : null,
  };

  // Zero candidates is ABSENCE, not containment. When solumbe matches nothing, AX
  // is describing an empty set and `containment` reads high for the same
  // reason there is nothing to spread across — so the arithmetic produces a
  // confident-looking cheap tier for the request the repository understood
  // least. Measured on this repo: "fix scanning multi date event ticket" asked
  // against a repository that has no such code scored containment 100 on zero
  // files and routed `cheap`.
  //
  // The invariant below applies at its limit: never round down on a bad read,
  // and no read is worse than no evidence at all.
  const candidates = signals.candidates ?? 0;
  const noEvidence = candidates === 0;

  /** @type {{ name: string, fired: boolean, note: string, ceiling?: boolean }[]} */
  const bumps = [
    {
      name: "no evidence",
      fired: noEvidence,
      note: noEvidence
        ? "solumbe matched no files; the score describes an empty set, not a contained change"
        : `${candidates} candidate file${candidates === 1 ? "" : "s"} matched`,
    },
    {
      name: "risk path",
      fired: severe.length > 0,
      note: severe.length ? `${severe.join(", ")}, one tier up` : "no top-severity risk flag",
    },
  ];

  // Every bump moves toward the more capable model and never away from it. A
  // router that can round down on a bad read ships bad changes cheaply.
  for (const bump of bumps) {
    if (!bump.fired) continue;
    // No evidence is not worth one tier, it invalidates the read. It goes
    // straight to the ceiling rather than stepping, so a high AX cannot leave
    // an unexplained request in a cheap lane.
    if (bump.name === "no evidence") {
      if (index === TIERS.length - 1) bump.ceiling = true;
      index = TIERS.length - 1;
      continue;
    }
    if (index === TIERS.length - 1) {
      bump.ceiling = true;
      continue;
    }
    index += 1;
  }

  return {
    steps,
    raw: round2(raw),
    route: Math.round(route),
    clamped: raw < 0 || raw > 100,
    baseTier,
    tierSource: modelRecommended ? "model" : "weighted-score",
    tier: TIERS[index],
    bumps,
    confidence,
    confidences,
    // Carried so a caller can say "no recommendation" rather than printing a
    // tier that rests on nothing. The tier itself stays a valid string, and
    // fails safe, so a caller that ignores this field still cannot route an
    // unexplained request cheaply.
    evidence: { candidates, sufficient: !noEvidence },
  };
}

/**
 * Score a request. Computes the impact pass ONCE and hands it to both AX and
 * the signal derivation.
 * @param {string} request
 * @param {{ path?: string, top?: number, offline?: boolean, apiKey?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function generateRoute(request, options = {}) {
  const normalized = String(request ?? "").trim();
  if (!normalized) {
    throw new Error('route requires a change request, e.g. `solumbe route . "add a --json flag"`');
  }
  const repoPath = options.path ?? ".";
  const top = options.top ?? 8;

  const impact = generateImpact(normalized, { path: repoPath, top }).data;
  // Hand the impact pass to AX so the expensive half runs once, not twice.
  const ax = generateAxScore(normalized, { path: repoPath, top, impact });
  const signals = signalsFrom(impact, ax);

  let jev;
  const wantsModel = !options.offline && (options.apiKey ?? process.env.TYPESAFE_API_KEY);
  if (wantsModel) {
    try {
      jev = await askJev(normalized, signals, options);
    } catch (error) {
      jev = offlineAnswers(normalized, signals);
      jev.fallbackReason = String(/** @type {any} */ (error)?.message ?? error);
    }
  } else {
    jev = offlineAnswers(normalized, signals);
  }

  const scoring = scoreDecision({ answers: jev.answers, signals });
  // The tier the repository alone would give, so a caller can see how far the
  // request read moved it, and a decision log can keep both halves.
  const neutral = scoreDecision({ answers: NEUTRAL_ANSWERS, signals });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    /** Filled in by a caller that resolved a host map. */
    hostModel: /** @type {string | undefined} */ (undefined),
    /** Enforce-mode arm, set by the CLI when SOLUMBE_ROUTE_MODE=delegate. */
    enforce: /** @type {{ mode: string, arm: string, share: number|null, agentModel: string|null } | undefined} */ (undefined),
    modelRouteEngineVersion,
    request: normalized,
    repo: { name: signals.repoName, root: impact.repo?.root ?? path.resolve(repoPath) },
    tier: scoring.tier,
    advisory: true,
    scoring,
    deterministic: { tier: neutral.tier, route: neutral.route },
    model: jev,
    signals,
    costUsd: priceJevCall(jev.billableTokens),
  };
}

/**
 * One advisory line for commands that already computed impact and AX. Offline
 * and pure: an ordinary solumbe command must not make a network call.
 * @param {string} request
 * @param {any} impact
 * @param {any} ax
 */
export function routeFooter(request, impact, ax) {
  const signals = signalsFrom(impact, ax);
  const answers = offlineAnswers(request, signals).answers;
  const scoring = scoreDecision({ answers, signals });
  return {
    tier: scoring.tier,
    route: scoring.route,
    bumped: scoring.tier !== scoring.baseTier,
    line: `model route: ${scoring.tier} (score ${scoring.route}${
      scoring.tier === scoring.baseTier ? "" : `, bumped from ${scoring.baseTier}`
    }) - offline estimate, advisory`,
  };
}
