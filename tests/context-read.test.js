import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { AMBIGUOUS_ACTION_QUESTION, formatContextPackTerminal, generateContextPack } from "../src/lib/context-engine.js";
import { readContextPack } from "../src/lib/context-read.js";
import { CHOICE_FLOOR, DEMOTE_BELOW } from "../src/lib/jev.js";
import { startMcpServer } from "../src/lib/mcp.js";
import { createRenderer } from "../src/lib/render/fancy.js";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-read-"));
  const files = {
    "package.json": JSON.stringify({ name: "read-fixture", scripts: { test: "node --test", lint: "eslint ." } }),
    "src/events/events.controller.ts": "export class EventsController { list() {} findEvent() {} }\n",
    "src/events/events.service.ts": "export class EventsService { listEvents() {} }\n",
    "src/events/events.api.ts": "export async function listEvents() { return fetch('/api/events'); }\n",
    "src/billing/events-invoice.ts": "export const eventsInvoice = () => 'events';\n",
    "tests/events.test.ts": "import test from 'node:test';\ntest('events', () => {});\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return root;
}

/** The candidate order readContextPack sends: primary, then related, de-duplicated by repo ROOT + path (as the engine identifies files). */
function candidates(pack) {
  const seen = new Set();
  return [...pack.data.primaryFiles, ...pack.data.relatedFiles].filter((file) => {
    const key = `${file.repo.root}\u0000${file.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function replyWith(answers, sent = []) {
  return async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return /** @type {any} */ ({ ok: true, json: async () => ({ model: "jev-test", usage: { input_tokens: 1000 }, answers }) });
  };
}

function relevanceAnswers(files, scoreFor) {
  return Object.fromEntries(files.map((file, index) => [`read_file_${index}`, { type: "noul", noul: scoreFor(file, index) }]));
}

test("a pack that never asked for a read renders exactly as before", () => {
  const pack = generateContextPack("list events", { path: makeFixture() });
  assert.equal(pack.data.modelRead, undefined);
  assert.doesNotMatch(pack.markdown, /Model Read/);
});

test("a confident read relabels the intent, demotes a strong no, and re-ranks the rest", async () => {
  const pack = generateContextPack("events listing is slow for organisers", { path: makeFixture() });
  const files = candidates(pack);
  assert.ok(pack.data.primaryFiles.length >= 2, "the fixture must give the read something to re-rank");
  assert.equal(pack.data.intent.action, "unknown", "no action word, so solumbe cannot name the work");
  assert.ok(pack.data.openQuestions.includes(AMBIGUOUS_ACTION_QUESTION));

  // Demote the first-ranked file, and put the last primary file on top.
  const lastPrimary = pack.data.primaryFiles.at(-1).path;
  const demotedPath = files[0].path;
  const sent = [];
  const read = await readContextPack(pack, {
    apiKey: "k",
    fetchImpl: replyWith(
      {
        read_intent: { type: "choice", choice: "debug", confidence: 0.91, probabilities: { debug: 0.94, fix: 0.06 } },
        ...relevanceAnswers(files, (file, index) => (index === 0 ? DEMOTE_BELOW / 2 : file.path === lastPrimary ? 0.99 : 0.5)),
      },
      sent,
    ),
  });

  // One call: the request, the candidates as state, intent and one Noul per file.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.request, "events listing is slow for organisers");
  assert.deepEqual(
    sent[0].state.candidate_files.map((file) => file.path),
    files.map((file) => file.path),
  );
  assert.ok(sent[0].questions.read_intent);
  assert.equal(sent[0].questions.read_capability, undefined, "a context pack does not need the tool choice");

  const data = read.data;
  assert.equal(data.intent.action, "debug");
  assert.equal(data.intent.source, "jev");
  assert.equal(data.intent.heuristicAction, "unknown");
  assert.ok(!data.openQuestions.includes(AMBIGUOUS_ACTION_QUESTION), "a settled intent withdraws the ambiguity question");

  const lists = [...data.primaryFiles, ...data.relatedFiles].map((file) => file.path);
  assert.ok(!lists.includes(demotedPath), "a strong no leaves the ranked lists");
  assert.ok(!data.hotspots.some((hotspot) => hotspot.path === demotedPath), "and its hotspots go with it");
  assert.deepEqual(
    data.modelRead.demoted.map((entry) => [entry.path, entry.relevance, entry.from, entry.rank]),
    [[demotedPath, DEMOTE_BELOW / 2, "primaryFiles", 0]],
  );
  assert.equal(data.primaryFiles[0].path, lastPrimary, "the rest are re-ranked by relevance");
  assert.equal(data.primaryFiles[0].relevance, 0.99);
  assert.equal(typeof data.primaryFiles[0].rank, "number", "each file keeps its original rank");

  assert.equal(data.modelRead.source, "jev");
  assert.equal(data.modelRead.model, "jev-test");
  assert.equal(data.modelRead.costUsd, 0.000042);
  assert.match(read.markdown, /## Model Read/);
  assert.match(read.markdown, /Intent: debug \(confidence 0\.91; solumbe's own reading was unknown\)/);
  assert.match(read.markdown, /Demoted 1 file\(s\)/);

  const terminal = formatContextPackTerminal(data, (options) => createRenderer({ ...options, color: false, emoji: false }));
  assert.match(terminal, /Model read/);

  // The pack that was passed in is untouched.
  assert.equal(pack.data.intent.action, "unknown");
  assert.equal(pack.data.primaryFiles[0].path, demotedPath);
  assert.equal(pack.data.modelRead, undefined);
});

test("an unsure intent is reported, not applied", async () => {
  const pack = generateContextPack("events listing is slow for organisers", { path: makeFixture() });
  const read = await readContextPack(pack, {
    apiKey: "k",
    fetchImpl: replyWith({ read_intent: { type: "choice", choice: "fix", confidence: CHOICE_FLOOR - 0.01, probabilities: { fix: 0.6 } } }),
  });
  assert.equal(read.data.intent.action, "unknown");
  assert.equal(read.data.modelRead.intent.accepted, false);
  assert.ok(read.data.openQuestions.includes(AMBIGUOUS_ACTION_QUESTION));
  assert.match(read.markdown, /under the floor; kept solumbe's reading \(unknown\)/);
  assert.deepEqual(
    read.data.primaryFiles.map((file) => file.path),
    pack.data.primaryFiles.map((file) => file.path),
    "no relevance answers, no movement",
  );
});

test("two repos that share a name and a path are kept distinct, not merged", async () => {
  // Both repos are named "shared" and both own src/events.js. Keyed by name the
  // two files would collide into one candidate and one relevance score; keyed
  // by root they stay separate, so a low score demotes only the repo it was
  // asked about.
  function sameNameRepo(marker) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-multi-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "shared", scripts: { test: "node --test" } }));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "events.js"), `export function listEvents() { return '${marker} events'; }\n`);
    return root;
  }
  const repoA = sameNameRepo("alpha");
  const repoB = sameNameRepo("beta");
  const pack = generateContextPack("list events", { paths: [repoA, repoB] });
  const files = candidates(pack);
  const eventsFiles = files.filter((file) => file.path === "src/events.js");
  assert.equal(eventsFiles.length, 2, "the fixture must give two same-path files across the two repos");

  // Score repo A's src/events.js high and repo B's low; a name-keyed lookup
  // would apply one of these to both.
  const sent = [];
  const read = await readContextPack(pack, {
    apiKey: "k",
    // Each repo's file gets its own answer, by index: repo A high, repo B low.
    fetchImpl: replyWith(
      relevanceAnswers(files, (file) => (file.path === "src/events.js" ? (file.repo.root === repoA ? 0.95 : 0.02) : 0.6)),
      sent,
    ),
  });

  // The model was asked one question per file, not one for the pair.
  const asked = sent[0].state.candidate_files.filter((file) => file.path.endsWith("src/events.js"));
  assert.equal(asked.length, 2, "each repo's file is its own question, not a merged one");

  const kept = [...read.data.primaryFiles, ...read.data.relatedFiles].filter((file) => file.path === "src/events.js");
  const keptRoots = new Set(kept.map((file) => file.repo.root));
  assert.ok(keptRoots.has(repoA), "the high-scored repo's file survives");
  assert.ok(!keptRoots.has(repoB), "the low-scored repo's file is demoted, and only it");
  assert.deepEqual(
    read.data.modelRead.demoted.filter((entry) => entry.path === "src/events.js").map((entry) => entry.relevance),
    [0.02],
    "exactly one events.js demoted, at repo B's score — the two were never collapsed",
  );
});

test("a read that rejects every primary file keeps solumbe's list and says so", async () => {
  const pack = generateContextPack("list events", { path: makeFixture() });
  const files = candidates(pack);
  const read = await readContextPack(pack, { apiKey: "k", fetchImpl: replyWith(relevanceAnswers(files, () => 0.01)) });
  assert.deepEqual(
    read.data.primaryFiles.map((file) => file.path),
    pack.data.primaryFiles.map((file) => file.path),
  );
  assert.match(read.data.modelRead.notApplied, /Every primary file scored under/);
  assert.ok(read.data.modelRead.demoted.every((entry) => entry.from === "relatedFiles"));
});

test("a failed or unkeyed call returns solumbe's pack unchanged and says why", async (t) => {
  const pack = generateContextPack("list events", { path: makeFixture() });
  const failed = await readContextPack(pack, {
    apiKey: "k",
    fetchImpl: async () => /** @type {any} */ ({ ok: false, status: 529, text: async () => "overloaded" }),
  });
  assert.equal(failed.data.modelRead.source, "offline");
  assert.match(failed.data.modelRead.fallbackReason, /529/);
  assert.deepEqual(failed.data.primaryFiles, pack.data.primaryFiles);
  assert.match(failed.markdown, /Not applied: TypeSafe API 529/);

  // Unkeyed means no provider at all: an Anthropic key would select Claude.
  const saved = {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    SOLUMBE_READ_PROVIDER: process.env.SOLUMBE_READ_PROVIDER,
  };
  for (const name of Object.keys(saved)) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const unkeyed = await readContextPack(pack, { fetchImpl: async () => assert.fail("no call without a key") });
  assert.match(unkeyed.data.modelRead.fallbackReason, /TYPESAFE_API_KEY is not set/);
});

test("context_pack only reads online when asked, over MCP", async (t) => {
  const savedKey = process.env.TYPESAFE_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.TYPESAFE_API_KEY = "test-key";
  const sent = [];
  globalThis.fetch = replyWith({ read_intent: { type: "choice", choice: "add", confidence: 0.97, probabilities: { add: 0.98 } } }, sent);
  t.after(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
  });

  const fixture = makeFixture();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    text += chunk;
  });
  const done = startMcpServer({ input, output });
  const call = (id, args) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "context_pack", arguments: { query: "list events", path: fixture, ...args } } });
  input.write(`${call(1, {})}\n${call(2, { online: true })}\n`);
  input.end();
  await done;

  const [plain, online] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(JSON.parse(line).result.content[0].text));
  assert.equal(plain.modelRead, undefined, "a key alone does not make context_pack call out");
  assert.equal(online.modelRead.source, "jev");
  assert.equal(online.intent.action, "add");
  assert.equal(sent.length, 1, "exactly one call, for the online request");
});
