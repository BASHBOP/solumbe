// solumbe review = the composite engine that runs Phases 2-4 together:
// impact (blast radius) → pr-review (rich diff context) → pass (verdict).
// Returns one structured report an agent or reviewer can consume in a
// single call, with a derived confidence score the agent can use to
// decide whether to escalate to a human.

import { generateImpact } from "./impact.js";
import { generatePrReview } from "./pr-review.js";
import { evaluateLocal } from "./pass-local.js";
import { evaluatePR } from "./pass-pr.js";
import { estimateTokens } from "./tokens.js";

const reviewEngineVersion = 1;

/**
 * Version of the verdict JSON shape. Attestation records and any store that
 * receives them read this to know which fields to expect. Bump it when a
 * field is added, removed or changes meaning.
 * 2: `impactSummary.companions`, leads in the companion repositories, present
 *    only when the repository's .solumberc.json lists any and a request is given.
 */
export const VERDICT_SCHEMA_VERSION = 2;

/** @typedef {import('./pass-pr.js').Runner} Runner */

/**
 * @typedef {Object} ReviewOptions
 * @property {string} [request]
 * @property {string} [prSelector]
 * @property {boolean} [pr]
 * @property {number} [impactTop]
 * @property {string} [base]
 * @property {string} [head]
 * @property {string} [policy]
 * @property {string} [governance]
 * @property {number | string} [minConvergence]
 * @property {string} [receipt]
 * @property {Runner} [runner]
 */

/**
 * @param {string} repoPath
 * @param {ReviewOptions} [options]
 */
export async function generateReview(repoPath, options = {}) {
  const asked = String(options.request ?? "").trim();
  const request = asked || "review this change";
  const wantsPr = Boolean(options.prSelector || options.pr);
  const head = String(options.head ?? "").trim();

  /** @type {any} */
  let passReport;
  if (!wantsPr) {
    passReport = evaluateLocal(repoPath, {
      base: options.base,
      head: head || undefined,
      policy: options.policy,
      governance: options.governance,
      request,
      minConvergence: options.minConvergence,
      receipt: options.receipt,
    });
  }

  // With a head, impact scores the gate's exact base..head file set, so the
  // working tree's uncommitted and untracked files play no part, as in the gate.
  // The placeholder request ranks nothing in particular, so companions are
  // read only for a request the caller actually gave.
  const exactFiles = passReport?.scope === "commit" ? passReport.changedFiles : undefined;
  /** @type {any} */
  const impact = generateImpact(request, {
    path: repoPath,
    top: options.impactTop ?? 8,
    diffBase: exactFiles ? passReport.base : options.base,
    diffFiles: exactFiles,
    companions: Boolean(asked),
  }).data;
  const prReview = generatePrReview(repoPath, { base: options.base, head: head || undefined, number: options.prSelector, github: wantsPr });
  /** @type {any} */
  const prData = prReview.data;

  if (wantsPr) {
    passReport = await evaluatePR(repoPath, options.prSelector ?? "", {
      policy: options.policy,
      governance: options.governance,
      request,
      minConvergence: options.minConvergence,
      receipt: options.receipt,
      runner: options.runner,
    });
  }

  const confidence = computeConfidence({ impact, passReport, prReview: prData });

  /** @type {Record<string, unknown> & { tokenEstimate?: { fullJson: number } }} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    schemaVersion: VERDICT_SCHEMA_VERSION,
    reviewEngineVersion,
    request,
    verdict: passReport.verdict,
    confidence,
    repo: { root: passReport.repo.root, name: passReport.repo.name },
    impactSummary: {
      concepts: impact.concepts,
      topFiles: impact.topFiles.slice(0, 5).map((/** @type {any} */ file) => ({ path: file.path, score: file.score, riskFlags: file.riskFlags })),
      risks: impact.risks,
      ...(impact.companions ? { companions: impact.companions } : {}),
    },
    prReviewSummary: {
      changedFiles: prData.changedFiles.length,
      additions: prData.comparison?.insertions ?? 0,
      deletions: prData.comparison?.deletions ?? 0,
      riskLevel: prData.risk?.level,
      riskFlags: prData.risk?.flags ?? [],
      reviewTargetsCount: prData.reviewTargets?.routes?.length ?? 0,
    },
    pass: {
      verdict: passReport.verdict,
      policy: passReport.policy,
      governance: passReport.governance,
      checks: passReport.checks.map((/** @type {any} */ check) => ({ name: check.name, status: check.status, summary: check.summary })),
    },
  };
  data.tokenEstimate = { fullJson: estimateTokens(data) };
  return { data, fullReports: { impact, prReview: prData, pass: passReport } };
}

// Confidence score blends three signals: pass verdict, impact concept
// coverage, and PR review risk level. The score is a 0-100 integer so the
// terminal renderer can paint it as a bar.
/**
 * @param {{ impact: any, passReport: any, prReview: any }} params
 * @returns {number}
 */
function computeConfidence({ impact, passReport, prReview }) {
  let score = 70;
  if (passReport.verdict === "PASS") score += 15;
  if (passReport.verdict === "FAIL") score -= 35;
  if (impact.concepts.length > 0) score += 5;
  if (impact.topFiles.length === 0) score -= 10;
  const riskLevel = prReview.risk?.level;
  if (riskLevel === "high") score -= 15;
  else if (riskLevel === "medium") score -= 5;
  return Math.max(0, Math.min(100, score));
}

/**
 * @typedef {Object} ReviewData
 * @property {string} request
 * @property {string} verdict
 * @property {number} confidence
 * @property {{ root: string, name: string }} repo
 * @property {{ concepts: string[], topFiles: { path: string, score: number, riskFlags: string[] }[], risks: string[], companions?: import('./impact.js').CompanionLead[] }} impactSummary
 * @property {{ changedFiles: number, additions: number, deletions: number, riskLevel?: string, riskFlags: string[], reviewTargetsCount: number }} prReviewSummary
 * @property {{ verdict: string, policy: string, governance: string, checks: { name: string, status: string, summary: string }[] }} pass
 */

/**
 * @param {ReviewData} data
 * @param {(options: object) => any} rendererFactory
 * @returns {string}
 */
export function formatReviewTerminal(data, rendererFactory) {
  const renderer = rendererFactory({});
  /** @type {string[]} */
  const lines = [];
  const sub = [
    { text: `"${data.request}"`, glyph: "💬" },
    { text: `${data.repo.root}`, glyph: "📂" },
    { text: `verdict ${data.verdict} · confidence ${data.confidence}%`, glyph: "🚦" },
  ];
  lines.push(renderer.header({ text: "solumbe review · composite verdict", glyph: "🔬" }, sub));
  lines.push("");

  lines.push(
    `  ${renderer.pick({ emoji: "🎯", ascii: ">" })}  Impact   ${bar(data.impactSummary.topFiles.length, 8, renderer)}   ${data.impactSummary.topFiles.length} owner file(s) · ${data.impactSummary.concepts.length} concept(s)`,
  );
  lines.push(
    `  ${renderer.pick({ emoji: "📋", ascii: ">" })}  Context  ${bar(data.prReviewSummary.changedFiles, 20, renderer)}   ${data.prReviewSummary.changedFiles} changed file(s) · risk ${data.prReviewSummary.riskLevel ?? "?"}`,
  );
  lines.push(
    `  ${renderer.pick({ emoji: "🚦", ascii: ">" })}  Pass     ${statusGlyph(renderer, data.verdict)}  ${data.verdict}        policy ${data.pass.policy} · governance ${data.pass.governance}`,
  );
  lines.push(`  ${renderer.pick({ emoji: "🎓", ascii: ">" })}  Confidence  ${bar(data.confidence, 100, renderer)}   ${data.confidence}%`);
  lines.push("");

  if (data.impactSummary.topFiles.length) {
    lines.push(`  ${renderer.pick({ emoji: "🥇", ascii: ">" })}  Owner files`);
    for (const file of data.impactSummary.topFiles) {
      lines.push(`     ${renderer.glyphs.box.arrow} ${file.path} (score ${file.score})`);
    }
    lines.push("");
  }
  if (data.impactSummary.companions?.length) {
    lines.push(`  ${renderer.pick({ emoji: "🔗", ascii: ">" })}  Companion repository leads`);
    for (const companion of data.impactSummary.companions) {
      const files = companion.topFiles.map((file) => `${file.path} (score ${file.score})`).join(", ") || "no matching files";
      lines.push(`     ${renderer.glyphs.box.arrow} ${companion.repo}: ${files}`);
    }
    lines.push("");
  }
  const failing = data.pass.checks.filter((c) => c.status === "FAIL");
  const warning = data.pass.checks.filter((c) => c.status === "WARN");
  const skipped = data.pass.checks.filter((c) => c.status === "SKIPPED");
  if (failing.length) {
    lines.push(`  ${renderer.glyphs.status.fail}  Blocking checks`);
    for (const check of failing) lines.push(`     ${renderer.glyphs.box.arrow} ${check.name}: ${check.summary}`);
    lines.push("");
  }
  if (warning.length) {
    lines.push(`  ${renderer.glyphs.status.warn} Warnings`);
    for (const check of warning) lines.push(`     ${renderer.glyphs.box.arrow} ${check.name}: ${check.summary}`);
    lines.push("");
  }
  if (skipped.length) {
    lines.push(`  ${renderer.glyphs.status.info} Not checked here`);
    for (const check of skipped) lines.push(`     ${renderer.glyphs.box.arrow} ${check.name}: ${check.summary}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** @typedef {ReturnType<typeof import("./render/fancy.js").createRenderer>} Renderer */

/**
 * @param {number} value
 * @param {number} max
 * @param {Renderer} renderer
 * @returns {string}
 */
function bar(value, max, renderer) {
  const cells = 10;
  const filled = Math.max(0, Math.min(cells, Math.round((value / max) * cells)));
  const track = `${renderer.pick({ emoji: "▰", ascii: "#", unicode: "▰" }).repeat(filled)}${renderer.pick({ emoji: "▱", ascii: ".", unicode: "▱" }).repeat(cells - filled)}`;
  return renderer.pick({ emoji: track, ascii: `[${track}]`, unicode: track });
}

/**
 * @param {Renderer} renderer
 * @param {string} verdict
 * @returns {string}
 */
function statusGlyph(renderer, verdict) {
  return renderer.glyphs.verdict[verdict] ?? `[${verdict}]`;
}

/**
 * Mermaid flowchart: request → impact summary → gate checks → verdict.
 * @param {ReviewData} data
 * @returns {string}
 */
export function formatReviewMermaid(data) {
  const lines = ["flowchart TD"];
  const req = (data.request ?? "review").slice(0, 50).replace(/"/g, "'");
  lines.push(`    Q["💬 ${req}"]`);

  const concepts = ((data.impactSummary?.concepts ?? []).slice(0, 4).join(", ") || "—").replace(/"/g, "'");
  const fileCount = data.impactSummary?.topFiles?.length ?? 0;
  const riskLevel = String(data.prReviewSummary?.riskLevel ?? "?").replace(/"/g, "'");
  // Mermaid renders <br/> as a line break; a literal \n is shown as text.
  lines.push(`    I["Impact: ${fileCount} file(s)<br/>concepts: ${concepts}<br/>risk: ${riskLevel}"]`);
  lines.push(`    Q --> I`);

  const checks = data.pass?.checks ?? [];
  for (const [ci, check] of checks.entries()) {
    const glyph = check.status === "PASS" ? "✅" : check.status === "WARN" ? "⚠️" : check.status === "SKIPPED" ? "➖" : "❌";
    const label = `${glyph} ${String(check.name).slice(0, 40)}`.replace(/"/g, "'");
    lines.push(`    G${ci}["${label}"]`);
    lines.push(`    I --> G${ci}`);
  }

  const vGlyph = data.verdict === "PASS" ? "✅" : data.verdict === "WARN" ? "⚠️" : "❌";
  lines.push(`    V["🚦 ${vGlyph} VERDICT: ${data.verdict ?? "?"}"]`);
  for (let ci = 0; ci < checks.length; ci++) lines.push(`    G${ci} --> V`);
  if (checks.length === 0) lines.push(`    I --> V`);

  return lines.join("\n");
}
