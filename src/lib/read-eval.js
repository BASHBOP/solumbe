// Grade the request read against labelled requests.
//
// The read (jev.js, claude-read.js) answers three questions about a request:
// what kind of work it is, which solumbe tool answers it, and which candidate
// files it needs. Until now none of those answers had been compared to
// anything. This runs the `reads` suite of evals/corpus.json, one provider at
// a time, over the same offline context packs the retrieval eval builds:
//
//   - heuristic: solumbe's own action word, no call;
//   - jev:       TypeSafe's Jev (TYPESAFE_API_KEY);
//   - claude:    Claude through forced tool use (ANTHROPIC_API_KEY).
//
// It is a measurement, not a gate: it needs a network and a key, so it is not
// part of `npm run ci`, and it exits non-zero only when no case could be read.
// The stated confidences are graded too, because a confidence that is not
// calibrated makes CHOICE_FLOOR a guess (docs/17-calibration-thesis).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askRequestRead, readProvider } from "./claude-read.js";
import { generateContextPack } from "./context-engine.js";
import { readState } from "./context-read.js";
import { copyFixtureToTemp, resolveFixture } from "./eval.js";
import { CHOICE_FLOOR, DEMOTE_BELOW, interpretRead } from "./jev.js";

/**
 * solumbe's action words, in the read's vocabulary, so the heuristic is
 * graded on the same labels rather than marked wrong for saying "create".
 * Words with no single counterpart (migrate) stay as they are and miss.
 */
export const HEURISTIC_INTENT = /** @type {Record<string, string>} */ ({
  build: "add",
  create: "add",
  implement: "add",
  update: "change",
  remove: "change",
  rename: "refactor",
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultCorpusPath = path.join(repoRoot, "evals", "corpus.json");

/**
 * @typedef {object} ReadCase
 * @property {string} name
 * @property {string} query
 * @property {string} repoFixture
 * @property {string|string[]} expectedIntent one label, or every label a careful reader could defend
 * @property {string|string[]} [expectedCapability]
 * @property {string[]} [expectedFiles] files the work needs; a read that demotes one is wrong
 */

/**
 * @typedef {object} ScoredReadCase
 * @property {string} name
 * @property {string} query
 * @property {string} heuristic solumbe's own action word, mapped through HEURISTIC_INTENT
 * @property {boolean} heuristicCorrect
 * @property {{ choice: string|null, confidence: number|null, accepted: boolean, correct: boolean, applied: string, appliedCorrect: boolean }} intent
 * @property {{ choice: string|null, confidence: number|null, correct: boolean|null }|null} capability
 * @property {{ path: string, relevance: number|null, expected: boolean }[]} relevance
 * @property {{ tokens: number|null, costUsd: number|null, latencyMs: number|null, attempts: number|null, model: string|null }} call
 * @property {string} [error]
 */

/**
 * @param {{ provider?: string, corpusPath?: string, repoRoot?: string, fetchImpl?: typeof fetch, apiKey?: string, anthropicApiKey?: string, timeoutMs?: number }} [options]
 */
export async function runReadEval(options = {}) {
  const corpusPath = options.corpusPath ? path.resolve(options.corpusPath) : defaultCorpusPath;
  const root = options.repoRoot ? path.resolve(options.repoRoot) : repoRoot;
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const provider = options.provider === "heuristic" ? "heuristic" : readProvider(options);
  /** @type {ReadCase[]} */
  const reads = Array.isArray(corpus.reads) ? corpus.reads : [];
  if (reads.length === 0) throw new Error(`corpus has no reads[] suite: ${corpusPath}`);

  /** @type {ScoredReadCase[]} */
  const cases = [];
  for (const testCase of reads) {
    cases.push(await scoreReadCase(testCase, { root, fixtureRoots: corpus.fixtureRoots ?? {}, provider, options }));
  }
  const scoreboard = aggregateReads(cases);
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    evalKind: "reads",
    provider,
    corpusPath,
    floors: { choice: CHOICE_FLOOR, demoteBelow: DEMOTE_BELOW },
    scoreboard,
    exitCode: scoreboard.read === 0 ? 1 : 0,
    cases,
  };
  return { data, markdown: formatReadEvalMarkdown(data) };
}

/**
 * @param {ReadCase} testCase
 * @param {{ root: string, fixtureRoots: Record<string, string>, provider: string, options: Record<string, any> }} context
 * @returns {Promise<ScoredReadCase>}
 */
async function scoreReadCase(testCase, { root, fixtureRoots, provider, options }) {
  const intents = [testCase.expectedIntent].flat();
  const capabilities = testCase.expectedCapability === undefined ? null : [testCase.expectedCapability].flat();
  const expectedFiles = new Set(testCase.expectedFiles ?? []);
  const temp = copyFixtureToTemp(resolveFixture(root, fixtureRoots, testCase.repoFixture));
  /** @type {ScoredReadCase} */
  const scored = {
    name: testCase.name,
    query: testCase.query,
    heuristic: "unknown",
    heuristicCorrect: false,
    intent: { choice: null, confidence: null, accepted: false, correct: false, applied: "unknown", appliedCorrect: false },
    capability: null,
    relevance: [],
    call: { tokens: null, costUsd: null, latencyMs: null, attempts: null, model: null },
  };
  try {
    const { data } = generateContextPack(testCase.query, { paths: [temp.dir] });
    scored.heuristic = Object.hasOwn(HEURISTIC_INTENT, data.intent.action) ? HEURISTIC_INTENT[data.intent.action] : data.intent.action;
    scored.heuristicCorrect = intents.includes(scored.heuristic);
    if (provider === "heuristic") {
      const correct = intents.includes(scored.heuristic);
      scored.intent = { choice: scored.heuristic, confidence: null, accepted: true, correct, applied: scored.heuristic, appliedCorrect: correct };
      return scored;
    }
    const { files, labeled, state } = readState(data);
    const reply = await askRequestRead(state, { files: labeled, capability: true }, { ...options, provider });
    const read = interpretRead(reply.answers, files);
    scored.call = { tokens: reply.tokens, costUsd: reply.costUsd, latencyMs: reply.latencyMs, attempts: reply.attempts ?? 1, model: reply.model };
    const applied = read.intent?.accepted ? read.intent.choice : scored.heuristic;
    scored.intent = {
      choice: read.intent?.choice ?? null,
      confidence: read.intent?.confidence ?? null,
      accepted: Boolean(read.intent?.accepted),
      correct: read.intent ? intents.includes(read.intent.choice) : false,
      applied,
      appliedCorrect: intents.includes(applied),
    };
    if (capabilities) {
      scored.capability = {
        choice: read.capability?.choice ?? null,
        confidence: read.capability?.confidence ?? null,
        correct: read.capability ? capabilities.includes(read.capability.choice) : false,
      };
    }
    scored.relevance = read.relevance.map((entry) => ({ ...entry, expected: expectedFiles.has(entry.path) }));
  } catch (error) {
    scored.error = String(/** @type {any} */ (error)?.message ?? error);
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
  return scored;
}

/**
 * @param {ScoredReadCase[]} cases
 */
export function aggregateReads(cases) {
  const read = cases.filter((testCase) => !testCase.error);
  const rate = (/** @type {number} */ hits, /** @type {number} */ n) => (n === 0 ? null : round3(hits / n));
  const count = (/** @type {(c: ScoredReadCase) => boolean} */ test) => read.filter(test).length;

  const accepted = read.filter((testCase) => testCase.intent.accepted);
  const confident = read.filter((testCase) => typeof testCase.intent.confidence === "number");
  // Brier score of the stated confidence in the chosen intent: 0 is perfect,
  // 0.25 is what a constant 0.5 earns. Only a read that states a confidence
  // can be graded, so the heuristic has none.
  const errorSquared = (/** @type {ScoredReadCase} */ testCase) => ((testCase.intent.confidence ?? 0) - (testCase.intent.correct ? 1 : 0)) ** 2;
  const brier = confident.length ? round3(confident.reduce((sum, testCase) => sum + errorSquared(testCase), 0) / confident.length) : null;
  const bands = [
    { band: "< 0.5", low: 0, high: 0.5 },
    { band: "0.5 to 0.7", low: 0.5, high: 0.7 },
    { band: "0.7 to 0.9", low: 0.7, high: 0.9 },
    { band: ">= 0.9", low: 0.9, high: 1.01 },
  ].map(({ band, low, high }) => {
    const inBand = confident.filter(
      (testCase) => /** @type {number} */ (testCase.intent.confidence) >= low && /** @type {number} */ (testCase.intent.confidence) < high,
    );
    return {
      band,
      n: inBand.length,
      meanConfidence: inBand.length
        ? round3(inBand.reduce((sum, testCase) => sum + /** @type {number} */ (testCase.intent.confidence), 0) / inBand.length)
        : null,
      accuracy: rate(inBand.filter((testCase) => testCase.intent.correct).length, inBand.length),
    };
  });

  const graded = read.filter((testCase) => testCase.capability);
  const scores = read.flatMap((testCase) => testCase.relevance.filter((entry) => typeof entry.relevance === "number"));
  const expected = scores.filter((entry) => entry.expected);
  const others = scores.filter((entry) => !entry.expected);
  const mean = (/** @type {{ relevance: number|null }[]} */ list) =>
    list.length ? round3(list.reduce((sum, entry) => sum + /** @type {number} */ (entry.relevance), 0) / list.length) : null;
  const sum = (/** @type {(c: ScoredReadCase) => number|null} */ pick) => {
    const values = read.map(pick).filter((value) => typeof value === "number");
    return values.length ? values.reduce((total, value) => total + /** @type {number} */ (value), 0) : null;
  };
  const totalCost = sum((testCase) => testCase.call.costUsd);
  const totalLatency = sum((testCase) => testCase.call.latencyMs);

  return {
    cases: cases.length,
    read: read.length,
    errors: cases.length - read.length,
    intent: {
      accuracy: rate(
        count((testCase) => testCase.intent.correct),
        read.length,
      ),
      acceptedRate: rate(accepted.length, read.length),
      acceptedAccuracy: rate(accepted.filter((testCase) => testCase.intent.correct).length, accepted.length),
      appliedAccuracy: rate(
        count((testCase) => testCase.intent.appliedCorrect),
        read.length,
      ),
      heuristicAccuracy: rate(
        count((testCase) => testCase.heuristicCorrect),
        read.length,
      ),
      heuristicUnknown: count((testCase) => testCase.heuristic === "unknown"),
      brier,
      bands,
    },
    capability: { graded: graded.length, accuracy: rate(graded.filter((testCase) => testCase.capability?.correct).length, graded.length) },
    relevance: {
      expectedScored: expected.length,
      expectedDemoted: expected.filter((entry) => /** @type {number} */ (entry.relevance) < DEMOTE_BELOW).length,
      otherScored: others.length,
      otherDemoted: others.filter((entry) => /** @type {number} */ (entry.relevance) < DEMOTE_BELOW).length,
      meanExpected: mean(expected),
      meanOther: mean(others),
    },
    cost: {
      totalUsd: totalCost === null ? null : Number(totalCost.toFixed(6)),
      meanLatencyMs: totalLatency === null ? null : Math.round(totalLatency / read.length),
      retried: count((testCase) => (testCase.call.attempts ?? 1) > 1),
    },
  };
}

/**
 * @param {{ generatedAt: string, provider: string, corpusPath: string, scoreboard: ReturnType<typeof aggregateReads>, cases: ScoredReadCase[] }} data
 */
export function formatReadEvalMarkdown(data) {
  const s = data.scoreboard;
  const show = (/** @type {unknown} */ value) => (value === null || value === undefined ? "n/a" : String(value));
  const lines = [
    "# solumbe Read Eval",
    "",
    `Generated: ${data.generatedAt}`,
    `Provider: ${data.provider}`,
    `Corpus: ${data.corpusPath}`,
    `Cases: ${s.cases} (${s.read} read, ${s.errors} failed)`,
    "",
    "## Intent",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| accuracy (the read's own choice) | ${show(s.intent.accuracy)} |`,
    `| accepted (confidence >= ${CHOICE_FLOOR}) | ${show(s.intent.acceptedRate)} |`,
    `| accuracy when accepted | ${show(s.intent.acceptedAccuracy)} |`,
    `| accuracy of the intent a pack would carry | ${show(s.intent.appliedAccuracy)} |`,
    `| solumbe's own accuracy, same cases | ${show(s.intent.heuristicAccuracy)} |`,
    `| solumbe's own reading was unknown | ${s.intent.heuristicUnknown} |`,
    `| Brier score of the stated confidence | ${show(s.intent.brier)} |`,
    "",
    "| Confidence | n | mean confidence | accuracy |",
    "|---|---:|---:|---:|",
    ...s.intent.bands.map((band) => `| ${band.band} | ${band.n} | ${show(band.meanConfidence)} | ${show(band.accuracy)} |`),
    "",
    `Capability: ${show(s.capability.accuracy)} accuracy over ${s.capability.graded} graded case(s).`,
    `Relevance: expected files mean ${show(s.relevance.meanExpected)}, ${s.relevance.expectedDemoted} of ${s.relevance.expectedScored} demoted; other candidates mean ${show(s.relevance.meanOther)}, ${s.relevance.otherDemoted} of ${s.relevance.otherScored} demoted.`,
    `Cost: ${show(s.cost.totalUsd)} USD, mean latency ${show(s.cost.meanLatencyMs)} ms, ${s.cost.retried} case(s) retried.`,
    "",
    "## Cases",
    "",
    "| Case | solumbe | read | confidence | applied | correct |",
    "|---|---|---|---:|---|:---:|",
    ...data.cases.map((testCase) =>
      testCase.error
        ? `| ${testCase.name} | ${testCase.heuristic} | error: ${testCase.error.slice(0, 80)} | | | |`
        : `| ${testCase.name} | ${testCase.heuristic} | ${show(testCase.intent.choice)} | ${show(testCase.intent.confidence)} | ${testCase.intent.applied} | ${testCase.intent.appliedCorrect ? "yes" : "NO"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

const round3 = (/** @type {number} */ value) => Math.round(value * 1000) / 1000;
