// Terminal and markdown rendering for `solumbe route`.
//
// Kept apart from the scoring in `src/lib/model-route.js` so the arithmetic
// stays readable on its own and the presentation can change without touching
// it. Takes solumbe's renderer, so `--color`, `--no-color`, `--theme`, NO_COLOR
// and a piped stdout behave exactly as they do in every other command.

import { DEMOTE_BELOW } from "../jev.js";
import { CONFIDENCE_FLOOR } from "../model-route.js";

const ESC = String.fromCharCode(27);
/** @type {Record<string, string>} */
const TIER_COLOR = { cheap: "32", mid: "33", premium: "31" };
const BAR_WIDTH = 26;

/**
 * @param {any} data route payload from generateRoute
 * @param {any} renderer createRenderer() result
 * @returns {string}
 */
export function formatRouteTerminal(data, renderer) {
  const scoring = data.scoring;
  const answers = data.model.answers;
  const signals = data.signals;

  const paint = (/** @type {string} */ text, /** @type {string} */ code) => (renderer.color && code ? `${ESC}[${code}m${text}${ESC}[0m` : text);
  const dim = (/** @type {string} */ text) => paint(text, "2");
  const bold = (/** @type {string} */ text) => paint(text, "1");

  const cell = renderer.pick({ emoji: "█", ascii: "#", unicode: "█" });
  const empty = renderer.pick({ emoji: "░", ascii: ".", unicode: "░" });

  const bar = (/** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ code) => {
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.max(0, Math.max(from, to));
    const start = Math.round((lo / 100) * BAR_WIDTH);
    const length = Math.max(1, Math.round(((hi - lo) / 100) * BAR_WIDTH));
    return dim(empty.repeat(start)) + paint(cell.repeat(Math.min(length, BAR_WIDTH - start)), code);
  };

  const mini = (/** @type {number} */ value) => {
    const filled = Math.max(0, Math.min(12, Math.round(value * 12)));
    return paint(cell.repeat(filled), "36") + dim(empty.repeat(12 - filled));
  };

  const topLevel = (/** @type {any} */ answer) => {
    const best = Object.entries(answer.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
    const level = best ? dim(`${best[0]} ${(best[1] * 100).toFixed(0)}%`) : "";
    if (typeof answer.confidence !== "number") return level;
    const code = answer.confidence < CONFIDENCE_FLOOR ? "31" : answer.confidence < 0.8 ? "33" : "32";
    return `${level}  ${dim("conf")} ${paint(answer.confidence.toFixed(2), code)}`;
  };

  const out = [];
  out.push(renderer.header({ text: `MODEL ROUTE   ${data.repo.name ?? ""}`, glyph: "\u{1F6A6}" }, [dim(`"${data.request}"`)]));
  out.push("");
  // No evidence means no recommendation. The tier still fails safe to premium
  // for a caller that reads only `tier`, but the headline must not present a
  // read of an empty set as a decision.
  if (scoring.evidence?.sufficient === false) {
    out.push(`  ${bold("TIER")}  ${paint("NO RECOMMENDATION", "1;33")}` + dim(`   fails safe to ${scoring.tier}`));
  } else {
    out.push(`  ${bold("TIER")}  ${paint(scoring.tier.toUpperCase(), `1;${TIER_COLOR[scoring.tier]}`)}` + (data.hostModel ? dim(`   ${data.hostModel}`) : ""));
    if (data.enforce) {
      out.push(
        data.enforce.arm === "delegate" && data.enforce.agentModel
          ? `  ${bold("ENFORCE")}  delegate arm: do the work in a subagent on ${data.enforce.agentModel}`
          : dim(`  ENFORCE  ${data.enforce.arm} arm: advisory only`),
      );
    }
  }
  out.push(
    `  ${dim(scoring.tierSource === "model" ? "comparison score" : "route")} ${bold(String(scoring.route).padStart(3))} ${dim("/ 100")}   ` +
      (scoring.tier === scoring.baseTier ? dim("no bump") : paint(`bumped from ${scoring.baseTier}`, "33")),
  );
  out.push(`  ${dim("advisory: a recommendation, not a model selection")}`);
  out.push("");

  if (scoring.tierSource === "model") out.push(`  ${dim("Model recommendation")} ${scoring.baseTier}`);
  out.push(renderer.section(scoring.tierSource === "model" ? "comparison arithmetic" : "arithmetic", ""));
  for (const step of scoring.steps) {
    const code = step.delta == null ? "36" : step.delta < 0 ? "31" : "32";
    const value = step.delta == null ? String(step.to) : `${step.delta > 0 ? "+" : "-"}${Math.abs(step.delta).toFixed(1)}`;
    const track = bar(step.delta == null ? 0 : step.from, step.to, code);
    out.push(`    ${dim(step.label.padEnd(16))}${track}  ${value.padStart(6)}`);
  }
  out.push(
    `    ${bold((scoring.tierSource === "model" ? "comparison score" : "route score").padEnd(16))}${bar(0, scoring.route, TIER_COLOR[scoring.tier])}  ` +
      bold(String(scoring.route).padStart(6)),
  );
  out.push(" ".repeat(20 + Math.round(0.45 * BAR_WIDTH)) + dim("^ 45") + " ".repeat(Math.max(1, Math.round(0.3 * BAR_WIDTH) - 4)) + dim("^ 75"));
  out.push("");

  const provenance = data.model.source === "offline" ? paint("[offline estimate, not calibrated]", "33") : paint(`[${data.model.model}]`, "36");
  out.push(renderer.section(`request signals  ${provenance}`, ""));
  out.push(
    `    ${dim("specificity".padEnd(16))}${mini(answers.specificity.score / 2)}  ` +
      `${answers.specificity.score.toFixed(2)}  ${topLevel(answers.specificity)}`,
  );
  out.push(
    `    ${dim("blast_radius".padEnd(16))}${mini(answers.blast_radius.score / 2)}  ` +
      `${answers.blast_radius.score.toFixed(2)}  ${topLevel(answers.blast_radius)}`,
  );
  out.push(`    ${dim("novelty".padEnd(16))}${mini(answers.novelty.noul)}  ${answers.novelty.noul.toFixed(2)}`);
  if (scoring.confidence === null) {
    out.push(`    ${dim("confidence".padEnd(16))}${dim("not measured")}`);
  } else {
    const confidenceCode = scoring.confidence < CONFIDENCE_FLOOR ? "31" : scoring.confidence < 0.8 ? "33" : "32";
    out.push(`    ${dim("confidence".padEnd(16))}${mini(scoring.confidence)}  ` + paint(scoring.confidence.toFixed(2), confidenceCode));
  }
  out.push("");

  // The request read rides the same call and is reported, never scored: the
  // tier above was computed without it.
  const read = data.model.read;
  if (read) {
    out.push(renderer.section(`request read  ${dim("(reported, never scored)")}`, ""));
    for (const [label, answer] of /** @type {[string, any][]} */ ([
      ["intent", read.intent],
      ["solumbe tool", read.capability],
    ])) {
      if (!answer) {
        out.push(`    ${dim(label.padEnd(16))}${dim("no answer")}`);
        continue;
      }
      const confidence = answer.confidence === null ? dim("not measured") : paint(answer.confidence.toFixed(2), answer.accepted ? "32" : "33");
      out.push(`    ${dim(label.padEnd(16))}${bold(answer.choice)}  ${confidence}${answer.accepted ? "" : dim("  under the floor")}`);
    }
    for (const file of read.relevance) {
      const weak = file.relevance !== null && file.relevance < DEMOTE_BELOW;
      const value = file.relevance === null ? dim("  -  ") : paint(file.relevance.toFixed(2), weak ? "31" : "0");
      out.push(`    ${dim("needs".padEnd(16))}${mini(file.relevance ?? 0)}  ${value}  ${weak ? dim(file.path) : file.path}`);
    }
    out.push("");
  }

  out.push(renderer.section("repository signals  (deterministic, local)", ""));
  const risk = signals.riskPaths.length ? paint(signals.riskPaths.join(", "), "31") : dim("none");
  out.push(
    `    ${dim("AX")} ${signals.ax}   ${dim("containment")} ${signals.containment}   ` +
      `${dim("owners")} ${signals.owners}   ${dim("areas")} ${signals.moduleSpread}   ${dim("risk")} ${risk}`,
  );
  out.push("");

  out.push(renderer.section("fail-safe bumps", ""));
  for (const bump of scoring.bumps) {
    const mark = bump.ceiling ? paint("^", "33") : bump.fired ? paint("x", "31") : dim(".");
    const name = bump.fired ? bold(bump.name.padEnd(16)) : dim(bump.name.padEnd(16));
    out.push(`    ${mark} ${name}${dim(bump.note)}${bump.ceiling ? dim(" (already premium)") : ""}`);
  }

  // Gated on the token count, not on the cost: a call whose tokens were counted
  // but could not be priced still happened, and its count and latency are worth
  // printing. Where the price does not cover what was counted, the line says so
  // instead of showing a number the rate does not support.
  if (data.model.tokens != null) {
    const kind = data.model.tokenKind === "total" ? "total " : "";
    const cost = data.costUsd != null ? `$${data.costUsd.toFixed(6)}` : "not priced (rate covers input tokens only)";
    out.push("");
    out.push(dim(`    route call: ${data.model.tokens} ${kind}tokens, ${cost}, ${data.model.latencyMs} ms`));
  }
  if (data.model.fallbackReason) {
    out.push(dim(`    model call failed, fell back offline: ${data.model.fallbackReason}`));
  }
  return out.join("\n");
}

/**
 * @param {any} data
 * @returns {string}
 */
export function formatRouteMarkdown(data) {
  const scoring = data.scoring;
  const answers = data.model.answers;
  const noEvidence = scoring.evidence?.sufficient === false;
  const conf = (/** @type {any} */ answer) => (typeof answer.confidence === "number" ? ` (confidence ${answer.confidence.toFixed(2)})` : "");
  return [
    `# Model route: ${noEvidence ? "no recommendation" : scoring.tier}`,
    "",
    `> ${data.request}`,
    "",
    noEvidence
      ? `- **Tier**: no recommendation, solumbe matched no files (fails safe to ${scoring.tier})`
      : `- **Tier**: ${scoring.tier}${scoring.tier === scoring.baseTier ? "" : ` (bumped from ${scoring.baseTier})`}`,
    `- **${scoring.tierSource === "model" ? "Comparison score" : "Route score"}**: ${scoring.route} / 100`,
    `- **Source**: ${data.model.source === "jev" ? data.model.model : "offline estimate, not calibrated"}`,
    "- **Advisory**: a recommendation, not a model selection",
    "",
    "| Term | Value |",
    "| --- | ---: |",
    `| specificity | ${answers.specificity.score.toFixed(2)}${conf(answers.specificity)} |`,
    `| blast_radius | ${answers.blast_radius.score.toFixed(2)}${conf(answers.blast_radius)} |`,
    `| novelty | ${answers.novelty.noul.toFixed(2)} |`,
    `| confidence | ${scoring.confidence === null ? "not measured" : scoring.confidence.toFixed(2)} |`,
    `| AX | ${data.signals.ax} |`,
    `| containment | ${data.signals.containment} |`,
    `| risk paths | ${data.signals.riskPaths.join(", ") || "none"} |`,
    "",
    ...formatReadMarkdown(data.model.read),
  ].join("\n");
}

/**
 * @param {any} read
 * @returns {string[]}
 */
function formatReadMarkdown(read) {
  if (!read) return [];
  const choice = (/** @type {any} */ answer) =>
    answer ? `${answer.choice} (confidence ${answer.confidence ?? "not measured"}${answer.accepted ? "" : ", under the floor"})` : "no answer";
  const files = read.relevance
    .filter((/** @type {any} */ file) => file.relevance !== null)
    .map((/** @type {any} */ file) => `\`${file.path}\` ${file.relevance.toFixed(2)}`)
    .join(", ");
  return [
    "Request read, reported and never scored:",
    "",
    `- **Intent**: ${choice(read.intent)}`,
    `- **solumbe tool**: ${choice(read.capability)}`,
    `- **Files the request needs**: ${files || "no answer"}`,
    "",
  ];
}
