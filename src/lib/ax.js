// Agent Experience (AX) score: a single 0-100 number answering "how cheap and
// safe is it for an agent to make a change here?". It remains a cost and
// guardrail diagnostic. The product lead is independent merge evidence, not a
// cheaper model. See docs/07-deterministic-verification/ax-score-spec.md and
// docs/07-deterministic-verification/README.md.
//
// AX is a composition layer, not new analysis: Changeability/Containment/Clarity
// come from generateImpact (token estimate + blast radius + concepts/risk), and
// Guardrails come from repo-level signals (tests, validation scripts, CODEOWNERS,
// CI workflow). Pure and deterministic for a given repo state.

import fs from "node:fs";
import path from "node:path";
import { generateImpact } from "./impact.js";
import { inspectRepo, listRepoFiles } from "./repo.js";
import { load as loadCodeowners } from "./codeowners.js";
import { estimateTokens } from "./tokens.js";

export const axEngineVersion = "0.1.0";

// Tunable constants. Defaults are placeholders calibrated for small/medium repos;
// see the spec's "open questions". Kept here as named constants so they are easy
// to move into config.js later without touching the formula.
const TOKEN_FLOOR = 1500; // a tight, ideal context pack → Changeability ~100
const TOKEN_CEIL = 40000; // a bloated context pack → Changeability ~0
const W_FILES = 5; // blast-radius penalty per touched file
const W_FANOUT = 8; // blast-radius penalty per unit of mean dependency fan-out

const WEIGHTS = { changeability: 0.35, containment: 0.3, guardrails: 0.25, clarity: 0.1 };

/**
 * @typedef {object} AxGuardrails
 * @property {boolean} tests
 * @property {boolean} validation
 * @property {boolean} owners
 * @property {boolean} ci
 */

/**
 * @param {string} query
 * @param {{ path?: string, top?: number, impact?: any }} [options] `impact` lets a caller that already
 *   ran the impact pass hand it in, so a composite command does not compute it twice.
 * @returns {Record<string, any>}
 */
export function generateAxScore(query, options = {}) {
  const repoPath = options.path ?? ".";
  const top = options.top ?? 8;
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error('ax requires a change request, e.g. `solumbe ax "add a new MCP tool" --path .`');
  }

  /** @type {any} */
  // An impact pass is the expensive half of this score. A caller that already
  // has one (for example `solumbe route`) hands it in rather than paying twice.
  const impact = options.impact ?? generateImpact(normalizedQuery, { path: repoPath, top }).data;
  /** @type {any} */
  const repo = inspectRepo(repoPath);
  const root = repo.root ?? path.resolve(repoPath);

  // Changeability — inverse token cost of the context an agent needs.
  const tokens = impact.tokenEstimate?.total ?? 0;
  const changeability = changeabilityFromTokens(tokens);

  // Containment — small, low-fan-out blast radius. `topFiles` length tracks the
  // requested `top` count, not the real blast radius, so we estimate the files
  // that actually own the change as those scoring within half of the top match
  // (a natural elbow). Fan-out is the mean number of dependents those files pull
  // in. Both come straight from the impact engine.
  const topFiles = Array.isArray(impact.topFiles) ? impact.topFiles : [];
  const maxScore = topFiles.length ? (topFiles[0].score ?? 0) : 0;
  const primaryFiles = topFiles.filter((/** @type {any} */ f) => (f.score ?? 0) >= maxScore * 0.5);
  const filesTouched = primaryFiles.length;
  const meanFanOut = filesTouched ? mean(primaryFiles.map((/** @type {any} */ f) => f.relatedFiles?.length ?? 0)) : 0;
  const containment = clamp(100 - (filesTouched * W_FILES + meanFanOut * W_FANOUT), 0, 100);

  // Guardrails — repo-level safety net (25 points each).
  const guardrails = evaluateGuardrails(repo, root);
  const guardrailScore = Object.values(guardrails).filter(Boolean).length * 25;

  // Clarity — task grounded in concepts, low risk-flag density.
  const concepts = Array.isArray(impact.concepts) ? impact.concepts : [];
  const flaggedFiles = topFiles.filter((/** @type {any} */ f) => (f.riskFlags?.length ?? 0) > 0).length;
  const riskFlagDensity = filesTouched ? flaggedFiles / filesTouched : 0;
  const clarity = clamp(100 - (concepts.length === 0 ? 40 : 0) - Math.min(40, Math.round(riskFlagDensity * 100)), 0, 100);

  const ax = Math.round(
    WEIGHTS.changeability * changeability + WEIGHTS.containment * containment + WEIGHTS.guardrails * guardrailScore + WEIGHTS.clarity * clarity,
  );

  /** @type {Record<string, any>} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    axEngineVersion,
    mode: "task",
    query: normalizedQuery,
    repo: { name: repo.package?.name ?? path.basename(root), root },
    ax,
    band: bandFor(ax),
    subScores: {
      changeability: Math.round(changeability),
      containment: Math.round(containment),
      guardrails: guardrailScore,
      clarity: Math.round(clarity),
    },
    drivers: {
      tokensToChange: tokens,
      filesTouched,
      meanFanOut: round1(meanFanOut),
      guardrails,
    },
    recommendations: buildRecommendations({ guardrails, tokens, meanFanOut, concepts }),
    weights: WEIGHTS,
  };
  data.tokenEstimate = { fullJson: estimateTokens(data) };
  return data;
}

/**
 * Log curve: tokens at or below the floor score ~100, at or above the ceiling
 * score ~0. A log keeps small differences near the good end from dominating.
 * @param {number} tokens
 * @returns {number}
 */
export function changeabilityFromTokens(tokens) {
  if (tokens <= TOKEN_FLOOR) return 100;
  if (tokens >= TOKEN_CEIL) return 0;
  const ratio = Math.log10(tokens / TOKEN_FLOOR) / Math.log10(TOKEN_CEIL / TOKEN_FLOOR);
  return clamp(100 - 100 * ratio, 0, 100);
}

/**
 * @param {any} repo
 * @param {string} root
 * @returns {AxGuardrails}
 */
function evaluateGuardrails(repo, root) {
  const scriptNames = repo.scriptNames ?? Object.keys(repo.scripts ?? {});
  const dirs = repo.importantDirectories ?? [];
  const hasScript = (/** @type {string} */ name) => scriptNames.includes(name);

  // A Go module needs no scripts: `go vet` and `go test` are the toolchain's
  // own validation, and its tests sit beside the code as `_test.go` files.
  const goModule = fs.existsSync(path.join(root, "go.mod"));
  const goTests = goModule && listRepoFiles(root).some((file) => file.endsWith("_test.go"));
  const tests = hasScript("test") || dirs.some((/** @type {string} */ d) => /(^|[/\\])tests?$/.test(d)) || goTests;
  const validation = ["lint", "typecheck", "test", "build"].some(hasScript) || goModule;
  const ownersLoad = safeCall(() => loadCodeowners(root));
  const owners = Boolean(ownersLoad?.ok && (ownersLoad.ruleset?.rules?.length ?? 0) > 0);
  const ci = hasCiWorkflow(root);

  return { tests, validation, owners, ci };
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function hasCiWorkflow(root) {
  try {
    return fs.readdirSync(path.join(root, ".github", "workflows")).some((f) => /\.ya?ml$/.test(f));
  } catch {
    return false;
  }
}

// Each guardrail is worth 25 of the guardrail sub-score, weighted 0.25 into AX,
// so flipping one on is worth ~6 AX points. Recommendations are emitted in a
// fixed order so output stays deterministic.
/**
 * @param {{ guardrails: AxGuardrails, tokens: number, meanFanOut: number, concepts: string[] }} input
 * @returns {string[]}
 */
function buildRecommendations({ guardrails, tokens, meanFanOut, concepts }) {
  /** @type {string[]} */
  const recs = [];
  if (!guardrails.tests) recs.push("Add tests (a `test` script, a tests/ directory, or `_test.go` files) so changes are verifiable before merge (+6 AX).");
  if (!guardrails.validation) recs.push("Add lint/typecheck/test/build scripts agents can run as guardrails (+6 AX).");
  if (!guardrails.owners) recs.push("Add a CODEOWNERS file so required reviewers resolve automatically (+6 AX).");
  if (!guardrails.ci) recs.push("Add a CI workflow under .github/workflows to gate merges — `solumbe init` scaffolds one (+6 AX).");
  if (tokens > TOKEN_FLOOR * 3) {
    recs.push(`Context pack is large (~${tokens} tokens); tighten module boundaries and docs so agents load less to make this change.`);
  }
  if (meanFanOut > 4) {
    recs.push(`High dependency fan-out (~${round1(meanFanOut)} avg); decoupling these modules shrinks the blast radius of changes.`);
  }
  if (concepts.length === 0) {
    recs.push("The change request did not resolve to known concepts; clearer naming/docs would help agents ground tasks.");
  }
  return recs;
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatAxMarkdown(data) {
  const g = data.drivers.guardrails;
  const mark = (/** @type {boolean} */ v) => (v ? "yes" : "no");
  const lines = [
    `# Agent Experience (AX): ${data.ax}/100 (${data.band})`,
    "",
    `Repo: ${data.repo.name}`,
    `Change: "${data.query}"`,
    "",
    "## Sub-scores",
    "",
    `- Changeability: ${data.subScores.changeability} (token cost to make the change)`,
    `- Containment:   ${data.subScores.containment} (blast radius)`,
    `- Guardrails:    ${data.subScores.guardrails} (safety net)`,
    `- Clarity:       ${data.subScores.clarity} (task groundedness)`,
    "",
    "## Drivers",
    "",
    `- Tokens to change: ${data.drivers.tokensToChange}`,
    `- Files touched: ${data.drivers.filesTouched}`,
    `- Mean fan-out: ${data.drivers.meanFanOut}`,
    `- Guardrails — tests: ${mark(g.tests)}, validation: ${mark(g.validation)}, owners: ${mark(g.owners)}, ci: ${mark(g.ci)}`,
  ];
  if (data.recommendations.length) {
    lines.push("", "## Recommendations", "");
    for (const rec of data.recommendations) lines.push(`- ${rec}`);
  }
  return lines.join("\n");
}

/**
 * @param {() => any} fn
 * @returns {any}
 */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {number} value
 * @returns {number}
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * @param {number} ax
 * @returns {string}
 */
export function bandFor(ax) {
  if (ax >= 80) return "excellent";
  if (ax >= 60) return "good";
  if (ax >= 40) return "fair";
  return "poor";
}
