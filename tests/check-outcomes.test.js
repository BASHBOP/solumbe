import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { formatCheckOutcomes, gradeCheckOutcomes } from "../scripts/hooks/check-outcomes.mjs";
import { promptHash, readSessions } from "../scripts/hooks/route-outcomes.mjs";
import { requestHash } from "../src/lib/check-trial.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hooks", "check-outcomes.mjs");
const T0 = Date.parse("2026-09-26T10:00:00Z");
const at = (/** @type {number} */ minutes) => new Date(T0 + minutes * 60000).toISOString();

function user(sessionId, minutes, text) {
  return { type: "user", sessionId, timestamp: at(minutes), uuid: `${sessionId}-${minutes}`, message: { role: "user", content: [{ type: "text", text }] } };
}
function tool(sessionId, minutes, name, input) {
  return { type: "assistant", sessionId, timestamp: at(minutes), message: { role: "assistant", content: [{ type: "tool_use", name, input }] } };
}
const edit = (sessionId, minutes, file) => tool(sessionId, minutes, "Edit", { file_path: file });
const check = (sessionId, minutes, query) => tool(sessionId, minutes, "mcp__solumbe__convergence_score", { query, base: "origin/main" });
function decision(minutes, query, arm, extra = {}) {
  return {
    v: 1,
    ts: at(minutes),
    tool: "convergence_score",
    root: "/repo",
    head: "abc",
    mode: "trial",
    arm,
    withheld: arm === "withheld",
    requestHash: requestHash(query),
    ...extra,
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-outcomes-"));
  const project = path.join(dir, "projects", "-Users-me-repo");
  fs.mkdirSync(project, { recursive: true });
  const lines = [
    // Shown: the check ran, and the user moved on to something else.
    user("s1", 0, "add a refund endpoint"),
    edit("s1", 1, "src/refund.js"),
    check("s1", 2, "add a refund endpoint"),
    user("s1", 5, "now document it"),
    edit("s1", 6, "README.md"),
    user("s1", 9, "thanks"),
    // Withheld: two checks under one prompt, then pushback and the same file again.
    user("s2", 0, "add a charge endpoint"),
    edit("s2", 1, "src/charge.js"),
    check("s2", 2, "add a charge endpoint"),
    check("s2", 2.5, "add a charge endpoint"),
    user("s2", 4, "no, it has to validate the currency"),
    edit("s2", 5, "src/charge.js"),
    user("s2", 8, "ok"),
    // A check with no follow-up prompt is joined and not graded.
    user("s3", 0, "rename the helper"),
    check("s3", 1, "rename the helper"),
  ];
  const bySession = new Map();
  for (const line of lines) bySession.set(line.sessionId, [...(bySession.get(line.sessionId) ?? []), line]);
  for (const [id, entries] of bySession) fs.writeFileSync(path.join(project, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const decisions = [
    decision(2.1, "add a refund endpoint", "shown"),
    decision(2.1, "add a charge endpoint", "withheld"),
    decision(2.6, "add a charge endpoint", "withheld"),
    decision(1.1, "rename the helper", "shown"),
    // No transcript holds this call.
    decision(50, "something never asked here", "shown"),
  ];
  const log = path.join(dir, "check-decisions.jsonl");
  fs.writeFileSync(log, `${decisions.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { dir, log, decisions, transcripts: path.join(dir, "projects") };
}

test("a session transcript records calls to the pre-commit checks under any server name", () => {
  const { transcripts } = fixture();
  const events = readSessions(transcripts).get("s2") ?? [];
  const checks = events.filter((event) => event.kind === "check");
  assert.equal(checks.length, 2);
  assert.deepEqual([checks[0].tool, checks[0].hash], ["convergence_score", promptHash("add a charge endpoint")]);
  assert.equal(promptHash("x"), requestHash("x"), "the transcript and the decision log hash a request the same way");
  assert.equal(events.filter((event) => event.kind === "edit").length, 2, "a check call is not an edit");
});

test("decisions join to the tool call they logged and grade each prompt once, in its arm", () => {
  const { decisions, transcripts } = fixture();
  const data = gradeCheckOutcomes(decisions, readSessions(transcripts), { minSample: 1 });
  assert.deepEqual([data.decisions, data.joined, data.unjoined], [5, 4, 1]);
  assert.equal(data.prompts, 3, "two checks under one prompt are one prompt");
  assert.equal(data.graded, 2, "a prompt with no follow-up is not graded");
  const [shown, withheld] = data.arms;
  assert.deepEqual([shown.name, shown.prompts, shown.corrected.hits, shown.corrected.n], ["shown", 2, 0, 1]);
  assert.deepEqual([shown.reworked.hits, shown.reworked.n], [0, 1]);
  assert.deepEqual([withheld.name, withheld.prompts, withheld.corrected.hits, withheld.corrected.n], ["withheld", 1, 1, 1]);
  assert.deepEqual([withheld.reworked.hits, withheld.reworked.n], [1, 1]);
  assert.equal(typeof data.fewerWhenShown.corrected, "boolean");

  const markdown = formatCheckOutcomes(data);
  assert.match(markdown, /# Check trial outcomes, same session/);
  assert.match(markdown, /\| withheld \| 1 \|/);
});

test("below the minimum sample no rate and no difference is claimed", () => {
  const { decisions, transcripts } = fixture();
  const data = gradeCheckOutcomes(decisions, readSessions(transcripts));
  assert.equal(data.arms[0].corrected.rate, null);
  assert.deepEqual(data.fewerWhenShown, { corrected: null, reworked: null });
  assert.match(formatCheckOutcomes(data), /n < 30, withheld/);
});

test("the script reads a decision log and a transcripts directory, and says when there is no log", () => {
  const { log, transcripts, dir } = fixture();
  const run = spawnSync(process.execPath, [SCRIPT, "--log", log, "--transcripts", transcripts, "--min-sample", "1", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const data = JSON.parse(run.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.joined, 4);
  const missing = spawnSync(process.execPath, [SCRIPT, "--log", path.join(dir, "absent.jsonl")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no decision log at/);
});
