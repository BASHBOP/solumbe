import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { formatOutcomes, gradeAgentCalls, gradeDecisions, outcomesFor, promptHash, readSessions, readsAsPushback } from "../scripts/hooks/route-outcomes.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hooks", "route-outcomes.mjs");
const T0 = Date.parse("2026-09-26T10:00:00Z");
const at = (/** @type {number} */ minutes) => new Date(T0 + minutes * 60000).toISOString();

/** A transcript line the way Claude Code writes one. */
function user(sessionId, minutes, text, extra = {}) {
  return {
    type: "user",
    sessionId,
    timestamp: at(minutes),
    uuid: `${sessionId}-${minutes}`,
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  };
}
function edit(sessionId, minutes, file) {
  return {
    type: "assistant",
    sessionId,
    timestamp: at(minutes),
    message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: file } }] },
  };
}
function decision(sessionId, minutes, prompt, tiers) {
  return { v: 1, ts: at(minutes), sessionId, promptHash: promptHash(prompt), tier: tiers.offline, tiers, routes: {}, signals: {}, answers: {} };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-outcomes-"));
  const project = path.join(dir, "projects", "-Users-me-repo");
  fs.mkdirSync(project, { recursive: true });
  const s = "sess-a";
  const lines = [
    user(s, 0, "add a --quiet flag to the doctor command"),
    edit(s, 1, "src/cli.js"),
    user(s, 3, "no, the flag has to silence the footer too"), // pushback, and the same file again: corrected + reworked
    edit(s, 4, "src/cli.js"),
    user(s, 8, "now document it"), // moved on, edits a different file
    edit(s, 9, "README.md"),
    user(s, 8.5, "now document it"), // the duplicate copy the transcript writes; not a prompt
    user(s, 12, "[Request interrupted by user]"), // an interruption is a correction
    user(s, 13, "thanks"),
    user(s, 200, "unrelated, hours later"), // outside the window for the one before it
    // Tool results and meta records are not prompts.
    { ...user(s, 2, "tool output"), toolUseResult: { ok: true } },
    { ...user(s, 2.5, "context"), isMeta: true },
  ];
  fs.writeFileSync(path.join(project, `${s}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const log = path.join(dir, "route-decisions.jsonl");
  const records = [
    decision(s, 0, "add a --quiet flag to the doctor command", { deterministic: "cheap", offline: "cheap" }),
    decision(s, 8, "now document it", { deterministic: "cheap", offline: "mid" }),
    decision(s, 12.5, "a prompt the transcript never recorded", { deterministic: "mid", offline: "mid" }), // a stray decision joins nothing and must not crash
    decision("sess-zzz", 0, "a session with no transcript", { deterministic: "mid", offline: "mid" }),
  ];
  fs.writeFileSync(log, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, transcripts: path.join(dir, "projects"), log, records };
}

/** A finished background task, as the harness words it. */
function notification(taskId, command) {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    "<status>completed</status>",
    `<summary>Background command "${command}" completed (exit code 0)</summary>`,
    "</task-notification>",
  ].join("\n");
}
/** The queue record the harness writes when it submits a prompt. */
function enqueue(sessionId, minutes, content) {
  return { type: "queue-operation", operation: "enqueue", sessionId, timestamp: at(minutes), content };
}

/**
 * A session the hook routed before it skipped harness prompts: two finished
 * background tasks, a CI monitor event and a shell record sit between a
 * request and the prompt that pushes back on it, and each left a decision.
 */
function harnessFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-outcomes-harness-"));
  const project = path.join(dir, "projects", "-Users-me-repo");
  fs.mkdirSync(project, { recursive: true });
  const s = "sess-h";
  const delivered = notification("bg1", "yarn test");
  const midTurn = notification("bg2", "yarn lint");
  const monitor = "<ci-monitor-event>CI failed on the pull request this session opened.</ci-monitor-event>";
  const shell = "<bash-input>git push origin v3.2.0</bash-input><bash-stdout>Everything up-to-date</bash-stdout><bash-stderr></bash-stderr>";
  const reminded = "<system-reminder>\nYou are operating in a git worktree.\n</system-reminder>\n\nrun the suite in the background and fix what fails";
  const lines = [
    enqueue(s, 0, reminded),
    user(s, 0, reminded, { origin: { kind: "human" } }),
    edit(s, 1, "src/cli.js"),
    // Delivered between turns: a queue record and a user record.
    enqueue(s, 2, delivered),
    user(s, 2.1, delivered, { origin: { kind: "task-notification" } }),
    edit(s, 3, "src/cli.js"),
    // Absorbed mid-turn: filed as an attachment, so only the queue holds it.
    enqueue(s, 4, midTurn),
    { type: "attachment", sessionId: s, timestamp: at(4), attachment: { type: "queued_command", prompt: midTurn, commandMode: "task-notification" } },
    { type: "queue-operation", operation: "remove", sessionId: s, timestamp: at(4.1), content: midTurn, reason: "absorbed_mid_turn" },
    enqueue(s, 5, monitor),
    user(s, 5, monitor),
    enqueue(s, 6, shell),
    user(s, 6, shell, { origin: { kind: "human" } }),
    enqueue(s, 9, "no, the footer is still printed"),
    user(s, 9, "no, the footer is still printed", { origin: { kind: "human" } }),
    edit(s, 10, "src/cli.js"),
  ];
  fs.writeFileSync(path.join(project, `${s}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const log = path.join(dir, "route-decisions.jsonl");
  const records = [
    decision(s, 0, reminded, { deterministic: "cheap", offline: "mid" }),
    decision(s, 2, delivered, { deterministic: "cheap", offline: "mid" }),
    decision(s, 4, midTurn, { deterministic: "cheap", offline: "premium" }),
    decision(s, 5, monitor, { deterministic: "cheap", offline: "mid" }),
    decision(s, 6, shell, { deterministic: "cheap", offline: "mid" }),
    decision(s, 9, "no, the footer is still printed", { deterministic: "cheap", offline: "cheap" }),
    // The same notification text, logged for a session with no transcript: nothing says what it was.
    decision("sess-gone", 2, delivered, { deterministic: "cheap", offline: "mid" }),
  ];
  fs.writeFileSync(log, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, transcripts: path.join(dir, "projects"), log, records, delivered, midTurn };
}

test("a harness prompt in a transcript is neither a prompt nor anybody's follow-up", () => {
  const { dir, transcripts, delivered, midTurn } = harnessFixture();
  const events = readSessions(transcripts).get("sess-h");
  assert.ok(events);
  assert.deepEqual(
    events.filter((e) => e.kind !== "harness").map((e) => e.kind),
    ["prompt", "edit", "edit", "prompt", "edit"],
  );
  const harness = events.filter((e) => e.kind === "harness");
  assert.ok(harness.some((e) => e.hash === promptHash(delivered)));
  assert.ok(
    harness.some((e) => e.hash === promptHash(midTurn)),
    "a notification absorbed mid-turn is known from the queue",
  );
  assert.ok(
    harness.every((e) => e.text === undefined),
    "only the hash is kept, as in the log",
  );
  // The request's follow-up is the user's pushback nine minutes later, not the
  // notification at minute two, and the edits made on the way are its own.
  assert.deepEqual(outcomesFor(events, 0, 60 * 60000), { followUp: true, corrected: true, reworked: true });
  assert.deepEqual(
    outcomesFor(events, 0, 5 * 60000),
    { followUp: false, corrected: null, reworked: null },
    "a notification does not bring the follow-up closer",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decisions logged for harness prompts are left out of the grade and counted", () => {
  const { dir, transcripts, log, records } = harnessFixture();
  const data = gradeDecisions(records, readSessions(transcripts), { minSample: 1 });
  assert.equal(data.records, 7);
  assert.equal(data.excluded, 4, "two notifications, a CI monitor event and a shell record");
  assert.equal(data.joined, 2);
  assert.equal(data.unjoined, 1, "without its transcript a row cannot be told from a prompt that was never recorded");
  assert.equal(data.graded, 1, "the last prompt has nothing after it");
  assert.equal(data.excluded + data.joined + data.unjoined, data.records);
  const offline = data.variants.offline.tiers;
  assert.deepEqual(
    offline.map((t) => t.corrected.n),
    [0, 1, 0],
    "the premium notification and the four mid ones grade nothing",
  );
  assert.deepEqual([offline[1].corrected.hits, offline[1].reworked.n, offline[1].reworked.hits], [1, 1, 1]);
  assert.match(formatOutcomes(data), /7 logged, 4 excluded as harness prompts \(task notifications, CI monitor events, shell records\), 2 joined/);

  const run = spawnSync(process.execPath, [SCRIPT, "--log", log, "--transcripts", transcripts, "--min-sample", "1", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.excluded, 4);
  assert.equal(parsed.joined, 2);
  const text = spawnSync(process.execPath, [SCRIPT, "--log", log, "--transcripts", transcripts], { encoding: "utf8" });
  assert.match(text.stdout, /4 excluded as harness prompts/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pushback is read from how the next prompt opens", () => {
  for (const text of [
    "no that is wrong",
    "still failing",
    "undo that",
    "why did you delete it",
    "you missed the footer",
    "Actually keep it",
    "[Request interrupted by user]".replace("[", "wait "),
  ]) {
    assert.ok(readsAsPushback(text), text);
  }
  for (const text of ["now document it", "thanks", "open pr", "add tests for the flag"]) assert.ok(!readsAsPushback(text), text);
});

test("sessions are read with prompts, interruptions and edits in order, duplicates and tool results left out", () => {
  const { dir, transcripts } = fixture();
  const sessions = readSessions(transcripts);
  const events = sessions.get("sess-a");
  assert.ok(events);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["prompt", "edit", "prompt", "edit", "prompt", "edit", "interrupt", "prompt", "prompt"],
  );
  assert.deepEqual(outcomesFor(events, 0, 60 * 60000), { followUp: true, corrected: true, reworked: true });
  assert.deepEqual(
    outcomesFor(events, 4, 60 * 60000),
    { followUp: true, corrected: true, reworked: false },
    "the interruption corrects; README was not re-edited",
  );
  assert.deepEqual(outcomesFor(events, 7, 60 * 60000), { followUp: false, corrected: null, reworked: null }, "hours later is not a follow-up");
  assert.deepEqual(outcomesFor(events, 8, 60 * 60000), { followUp: false, corrected: null, reworked: null }, "the last prompt has nothing after it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decisions join to their prompt by session and hash, and grade per tier with the minimum-sample rule", () => {
  const { dir, transcripts, log, records } = fixture();
  const data = gradeDecisions(records, readSessions(transcripts), { minSample: 1 });
  assert.equal(data.records, 4);
  assert.equal(data.excluded, 0);
  assert.equal(data.joined, 2);
  assert.equal(data.unjoined, 2);
  assert.equal(data.graded, 2);
  const offline = data.variants.offline;
  const cheap = offline.tiers.find((t) => t.name === "cheap");
  const mid = offline.tiers.find((t) => t.name === "mid");
  assert.deepEqual([cheap.corrected.n, cheap.corrected.hits, cheap.reworked.n, cheap.reworked.hits], [1, 1, 1, 1]);
  assert.deepEqual([mid.corrected.n, mid.corrected.hits, mid.reworked.n, mid.reworked.hits], [1, 1, 1, 0]);
  assert.equal(cheap.corrected.rate, 1);
  assert.deepEqual(cheap.corrected.ci95, [0.207, 1]);
  assert.equal(offline.monotonic, null, "premium has no rows");
  const deterministic = data.variants.deterministic.tiers.find((t) => t.name === "cheap");
  assert.equal(deterministic.corrected.n, 2, "both joined prompts were deterministic-cheap");

  // Rows logged before the trial carry no arm and grade as advisory.
  assert.equal(gradeDecisions(records, readSessions(transcripts), { minSample: 1, arm: "advisory" }).records, 4);
  const delegateOnly = gradeDecisions(
    records.map((r, i) => (i === 0 ? { ...r, arm: "delegate" } : r)),
    readSessions(transcripts),
    { minSample: 1, arm: "delegate" },
  );
  assert.equal(delegateOnly.records, 1);
  assert.equal(delegateOnly.arm, "delegate");

  const withheld = gradeDecisions(records, readSessions(transcripts), { minSample: 30 });
  assert.equal(withheld.variants.offline.tiers[0].corrected.rate, null);
  const text = formatOutcomes(withheld);
  assert.match(text, /1 · 1 _\(n < 30, withheld\)_/);
  assert.match(text, /2 joined to a transcript prompt \(2 not found\)/);

  const run = spawnSync(process.execPath, [SCRIPT, "--log", log, "--transcripts", transcripts, "--min-sample", "1", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.joined, 2);
  const missing = spawnSync(process.execPath, [SCRIPT, "--log", path.join(dir, "nope.jsonl"), "--transcripts", transcripts], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no decision log/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Agent calls are counted per arm, joined to the decisions they belong to", () => {
  const records = [
    { v: 1, sessionId: "s", promptHash: "h1", arm: "delegate" },
    { v: 1, sessionId: "s", promptHash: "h2", arm: "control" },
    { v: 1, sessionId: "s", promptHash: "h3" },
  ];
  const calls = [
    { v: 1, sessionId: "s", promptHash: "h1", arm: "delegate", action: "rewrote" },
    { v: 1, sessionId: "s", promptHash: "h1", arm: "delegate", action: "matched" },
    { v: 1, sessionId: "s", promptHash: "h2", arm: "control", action: "diverged" },
    { v: 1, sessionId: "s", promptHash: "h3", action: "matched" },
    { v: 1, sessionId: "other", promptHash: "h1", arm: "delegate", action: "rewrote" },
  ];
  const all = gradeAgentCalls(calls, records);
  assert.deepEqual(all.arms.delegate, { calls: 2, requests: 1, matched: 1, diverged: 0, rewrote: 1 });
  assert.deepEqual(all.arms.control, { calls: 1, requests: 1, matched: 0, diverged: 1, rewrote: 0 });
  assert.deepEqual(all.arms.advisory, { calls: 1, requests: 1, matched: 1, diverged: 0, rewrote: 0 });
  assert.equal(all.unjoined, 1);
  const control = gradeAgentCalls(calls, records, { arm: "control" });
  assert.deepEqual(Object.keys(control.arms), ["control"]);

  const text = formatOutcomes({ ...gradeDecisions([], new Map()), agentCalls: all });
  assert.match(text, /## Subagent model, per arm/);
  assert.match(text, /\| delegate \| 2 \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(text, /1 Agent call\(s\) joined no logged decision/);
  assert.doesNotMatch(formatOutcomes(gradeDecisions([], new Map())), /Subagent model/);
});
