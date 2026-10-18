import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMENT_MARKER, SUMMARY_SCHEMA, parseEnvelope, renderMarkdown, validateSummary } from "../scripts/claude-gate-summary.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "claude-gate-summary.mjs");

const gate = {
  verdict: "WARN",
  checks: [
    { name: "Changed files", status: "PASS", summary: "3 files." },
    { name: "Risk review", status: "WARN", summary: "CI workflow changed." },
    { name: "Review state", status: "SKIPPED", summary: "Local mode." },
  ],
};

const summary = {
  verdict: "WARN",
  headline: "A CI workflow changed, so the gate warns.",
  checks: [{ name: "Risk review", status: "WARN", note: "touches .github/workflows | needs a look" }],
  risks: ["A new workflow runs on every PR."],
  nextSteps: ["Read the workflow diff."],
};

const envelope = (fields) => ({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.0123, ...fields });

test("the summary comes from structured_output, or from JSON in the final text", () => {
  assert.deepEqual(parseEnvelope(envelope({ structured_output: summary, result: "" })), summary);
  assert.deepEqual(parseEnvelope(envelope({ result: `Here it is:\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`` })), summary);
  assert.deepEqual(parseEnvelope(envelope({ result: `Summary: ${JSON.stringify(summary)}` })), summary);
});

test("a failed or non-JSON run is refused before any validation", () => {
  assert.throws(() => parseEnvelope({ verdict: "PASS" }), /not a result envelope/);
  assert.throws(() => parseEnvelope(envelope({ subtype: "error_max_budget_usd", is_error: true })), /did not succeed: subtype error_max_budget_usd, is_error/);
  assert.throws(() => parseEnvelope(envelope({ result: "The gate passed." })), /holds no JSON summary/);
});

test("a summary that agrees with the gate validates", () => {
  assert.deepEqual(validateSummary(summary, gate), []);
  assert.deepEqual(SUMMARY_SCHEMA.required, ["verdict", "headline", "checks", "risks", "nextSteps"]);
});

test("the summary must match the gate's verdict, check names and statuses", () => {
  const errors = validateSummary(
    {
      ...summary,
      verdict: "PASS",
      checks: [
        { name: "Risk review", status: "PASS", note: "" },
        { name: "Vibes", status: "PASS", note: "" },
      ],
    },
    gate,
  );
  assert.deepEqual(errors, [
    "verdict PASS disagrees with solumbe gate (WARN).",
    'check "Risk review" is PASS, but solumbe gate says WARN.',
    'check "Vibes" is not one solumbe gate ran.',
  ]);
  assert.deepEqual(validateSummary({ ...summary, checks: [] }, gate), ['check "Risk review" (WARN) is missing from the summary.']);
});

test("a summary off the schema is refused field by field", () => {
  const errors = validateSummary({ verdict: "MAYBE", headline: " ", checks: [{ name: "", status: "OK" }], risks: "none", extra: 1 }, gate);
  assert.deepEqual(errors, [
    'Unexpected field "extra".',
    "verdict must be one of PASS, WARN, FAIL.",
    "headline must be a non-empty string.",
    "risks must be an array of strings.",
    "nextSteps must be an array of strings.",
    "checks[0].name must be a non-empty string.",
    "checks[0].status must be one of PASS, WARN, FAIL, SKIPPED.",
    "checks[0].note must be a string.",
  ]);
  assert.deepEqual(validateSummary([], gate), ["The summary is not a JSON object."]);
});

test("the comment carries its marker, escapes table cells and names the run", () => {
  const markdown = renderMarkdown(summary, envelope({}));
  assert.ok(markdown.startsWith(`${COMMENT_MARKER}\n## Claude Code gate summary: WARN\n`));
  assert.match(markdown, /\| Risk review \| WARN \| touches \.github\/workflows \\\| needs a look \|/);
  assert.match(markdown, /\*\*Risks\*\*\n\n- A new workflow runs on every PR\./);
  assert.match(markdown, /\(3 turns, \$0\.0123\)\. Advisory: not a required check\./);
});

test("the CLI writes the comment for a valid summary and exits 1 on a disagreeing one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-claude-gate-"));
  const files = { claude: path.join(dir, "claude.json"), gate: path.join(dir, "gate.json"), markdown: path.join(dir, "summary.md") };
  fs.writeFileSync(files.gate, JSON.stringify(gate));
  const run = () => spawnSync(process.execPath, [SCRIPT, "--claude", files.claude, "--gate", files.gate, "--markdown", files.markdown], { encoding: "utf8" });

  fs.writeFileSync(files.claude, JSON.stringify(envelope({ structured_output: summary })));
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), summary);
  assert.ok(fs.readFileSync(files.markdown, "utf8").startsWith(COMMENT_MARKER));

  fs.rmSync(files.markdown);
  fs.writeFileSync(files.claude, JSON.stringify(envelope({ structured_output: { ...summary, verdict: "PASS" } })));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /verdict PASS disagrees with solumbe gate \(WARN\)/);
  assert.equal(fs.existsSync(files.markdown), false, "nothing is written to post");

  const schema = spawnSync(process.execPath, [SCRIPT, "--schema"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(schema.stdout), SUMMARY_SCHEMA);
});
