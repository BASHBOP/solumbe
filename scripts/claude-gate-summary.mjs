#!/usr/bin/env node
// Validate the summary a headless `claude -p --output-format json` run wrote
// about `solumbe gate`, and render it as the PR comment.
//
// The model's reading is never trusted on its own: the workflow runs the same
// gate itself, and the summary must name the gate's verdict and report every
// check it names with the gate's own status. Anything else exits 1, so a
// malformed or invented summary turns the job red instead of reaching the PR.
//
//   node scripts/claude-gate-summary.mjs --claude claude.json --gate gate.json --markdown summary.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMENT_MARKER = "<!-- solumbe-claude-gate -->";

const VERDICTS = ["PASS", "WARN", "FAIL"];
const STATUSES = ["PASS", "WARN", "FAIL", "SKIPPED"];

// The schema passed to `claude -p --json-schema`; validateSummary enforces the
// same shape, since the flag shapes the answer but proves nothing about it.
export const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "headline", "checks", "risks", "nextSteps"],
  properties: {
    verdict: { enum: VERDICTS },
    headline: { type: "string", minLength: 1 },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "status", "note"],
        properties: {
          name: { type: "string", minLength: 1 },
          status: { enum: STATUSES },
          note: { type: "string" },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
};

// Pull the summary out of the result envelope: `structured_output` when the
// run had --json-schema, else the JSON object in the final text (fences allowed).
export function parseEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || envelope.type !== "result") {
    throw new Error("Claude output is not a result envelope (expected --output-format json).");
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`Claude run did not succeed: subtype ${envelope.subtype ?? "missing"}${envelope.is_error ? ", is_error" : ""}.`);
  }
  if (envelope.structured_output && typeof envelope.structured_output === "object") return envelope.structured_output;
  const text = String(envelope.result ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Claude's final answer holds no JSON summary.");
  }
}

export function validateSummary(summary, gate) {
  const errors = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return ["The summary is not a JSON object."];

  const allowed = new Set(Object.keys(SUMMARY_SCHEMA.properties));
  for (const key of Object.keys(summary)) if (!allowed.has(key)) errors.push(`Unexpected field "${key}".`);
  if (!VERDICTS.includes(summary.verdict)) errors.push(`verdict must be one of ${VERDICTS.join(", ")}.`);
  if (typeof summary.headline !== "string" || !summary.headline.trim()) errors.push("headline must be a non-empty string.");
  for (const field of ["risks", "nextSteps"]) {
    if (!Array.isArray(summary[field]) || summary[field].some((item) => typeof item !== "string")) errors.push(`${field} must be an array of strings.`);
  }
  if (!Array.isArray(summary.checks)) {
    errors.push("checks must be an array.");
  } else {
    summary.checks.forEach((check, index) => {
      if (!check || typeof check.name !== "string" || !check.name.trim()) errors.push(`checks[${index}].name must be a non-empty string.`);
      if (!STATUSES.includes(check?.status)) errors.push(`checks[${index}].status must be one of ${STATUSES.join(", ")}.`);
      if (typeof check?.note !== "string") errors.push(`checks[${index}].note must be a string.`);
    });
  }
  if (errors.length || !gate) return errors;

  // Agreement with the gate the workflow ran itself.
  if (summary.verdict !== gate.verdict) errors.push(`verdict ${summary.verdict} disagrees with solumbe gate (${gate.verdict}).`);
  const gateChecks = new Map((gate.checks ?? []).map((check) => [check.name, check.status]));
  const reported = new Set();
  for (const check of summary.checks) {
    reported.add(check.name);
    if (!gateChecks.has(check.name)) errors.push(`check "${check.name}" is not one solumbe gate ran.`);
    else if (gateChecks.get(check.name) !== check.status)
      errors.push(`check "${check.name}" is ${check.status}, but solumbe gate says ${gateChecks.get(check.name)}.`);
  }
  for (const [name, status] of gateChecks) {
    if ((status === "WARN" || status === "FAIL") && !reported.has(name)) errors.push(`check "${name}" (${status}) is missing from the summary.`);
  }
  return errors;
}

const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderMarkdown(summary, envelope = {}) {
  const lines = [COMMENT_MARKER, `## Claude Code gate summary: ${summary.verdict}`, "", summary.headline, ""];
  if (summary.checks.length) {
    lines.push("| Check | Status | Note |", "| --- | --- | --- |");
    for (const check of summary.checks) lines.push(`| ${cell(check.name)} | ${check.status} | ${cell(check.note)} |`);
    lines.push("");
  }
  for (const [title, items] of [
    ["Risks", summary.risks],
    ["Next steps", summary.nextSteps],
  ]) {
    if (items.length) lines.push(`**${title}**`, "", ...items.map((item) => `- ${item}`), "");
  }
  const run = [
    envelope.num_turns != null ? `${envelope.num_turns} turns` : null,
    typeof envelope.total_cost_usd === "number" ? `$${envelope.total_cost_usd.toFixed(4)}` : null,
  ].filter(Boolean);
  lines.push(
    `<sub>Written by \`claude -p\` from \`solumbe gate\`, then checked against the same gate run by the workflow${run.length ? ` (${run.join(", ")})` : ""}. Advisory: not a required check.</sub>`,
    "",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--schema") args.schema = true;
    else if (["--claude", "--gate", "--markdown"].includes(flag)) args[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.schema) {
    process.stdout.write(`${JSON.stringify(SUMMARY_SCHEMA)}\n`);
    return 0;
  }
  if (!args.claude || !args.gate) throw new Error("Usage: claude-gate-summary.mjs --claude <file> --gate <file> [--markdown <file>] | --schema");
  const envelope = JSON.parse(fs.readFileSync(args.claude, "utf8"));
  const gate = JSON.parse(fs.readFileSync(args.gate, "utf8"));
  const summary = parseEnvelope(envelope);
  const errors = validateSummary(summary, gate);
  if (errors.length) {
    process.stderr.write(`Claude gate summary failed validation:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
    return 1;
  }
  if (args.markdown) fs.writeFileSync(args.markdown, renderMarkdown(summary, envelope));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
