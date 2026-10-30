import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { formatCheckOutcomes, gradeCheckOutcomes } from "../scripts/hooks/check-outcomes.mjs";
import { promptHash, readSessions, readUsage, turnTokens } from "../scripts/hooks/route-outcomes.mjs";
import { requestHash } from "../src/lib/check-trial.js";
import { billedTokens } from "../src/lib/tokens.js";

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

function reply(sessionId, minutes, id, usage, extra = {}) {
  return { type: "assistant", sessionId, timestamp: at(minutes), message: { id, role: "assistant", content: [{ type: "text", text: "ok" }], usage }, ...extra };
}

/** The fixture, with what each response was billed written into its sessions. */
function billedFixture() {
  const base = fixture();
  const project = path.join(base.transcripts, "-Users-me-repo");
  const append = (id, lines) => fs.appendFileSync(path.join(project, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const first = { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 100 };
  append("s1", [
    reply("s1", 1.5, "m1", first),
    // A response that streamed two blocks repeats its usage under one id.
    reply("s1", 1.6, "m1", first),
    // The next prompt's turn, which no check graded.
    reply("s1", 6.5, "m2", { input_tokens: 5000 }),
  ]);
  append("s2", [
    reply("s2", 1.5, "m3", { cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 400 }, output_tokens: 20 }),
    reply("s2", 3, "m4", { input_tokens: 50 }),
    // A subagent's response is not this session's turn.
    reply("s2", 2, "m5", { input_tokens: 999999 }, { isSidechain: true }),
  ]);
  return base;
}

test("billed tokens weight each kind by its price against an input token", () => {
  assert.deepEqual(billedTokens({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 100 }), {
    input: 10,
    cacheRead: 1000,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 100,
    weighted: 610,
  });
  const split = billedTokens({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 } });
  assert.deepEqual([split.cacheWrite5m, split.cacheWrite1h, split.weighted], [600, 400, 1550]);
  assert.equal(
    billedTokens({ cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 99 } }).cacheWrite1h,
    10,
    "the 1-hour share never exceeds the writes",
  );
  assert.equal(billedTokens({ input_tokens: -5, output_tokens: "x" }).weighted, 0);
  assert.equal(billedTokens(undefined).weighted, 0);
});

test("a session's usage counts each response once and leaves subagents out", () => {
  const { transcripts } = billedFixture();
  const usage = readUsage(transcripts);
  assert.deepEqual(
    (usage.get("s1") ?? []).map((entry) => entry.tokens.weighted),
    [610, 5000],
  );
  assert.deepEqual(
    (usage.get("s2") ?? []).map((entry) => entry.tokens.weighted),
    [1650, 50],
  );
  const events = readSessions(transcripts).get("s2") ?? [];
  assert.equal(turnTokens(events, 0, usage.get("s2") ?? []), 1700, "a turn runs from its prompt to the next one");
  assert.equal(turnTokens(events, events.length - 1, []), null, "a turn with no usage is unknown, not free");
});

test("each arm reports what its graded prompts' turns were billed", () => {
  const { decisions, transcripts } = billedFixture();
  const data = gradeCheckOutcomes(decisions, readSessions(transcripts), { minSample: 1, usage: readUsage(transcripts) });
  const [shown, withheld] = data.arms;
  assert.deepEqual(shown.billed, { n: 1, total: 610, median: 610, mean: 610, publishable: true }, "a prompt whose turn carried no usage is left out");
  assert.deepEqual(withheld.billed, { n: 1, total: 1700, median: 1700, mean: 1700, publishable: true });
  assert.match(formatCheckOutcomes(data), /\| withheld \| 1 \|.*\| 1 · 1,700 median, 1,700 mean \|/);

  const below = gradeCheckOutcomes(decisions, readSessions(transcripts), { usage: readUsage(transcripts) });
  assert.deepEqual([below.arms[1].billed.median, below.arms[1].billed.total], [null, 1700]);
  assert.match(formatCheckOutcomes(below), /1 · 1,700 in all _\(n < 30, withheld\)_/);

  const without = gradeCheckOutcomes(decisions, readSessions(transcripts), { minSample: 1 });
  assert.equal(without.arms[0].billed, null);
  assert.doesNotMatch(formatCheckOutcomes(without), /billed per prompt/);
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
