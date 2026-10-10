import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { LEGACY_TOOL_ALIASES, startMcpServer, tools } from "../src/lib/mcp.js";
import { getAgentTools } from "../src/lib/agent-tools.js";
import { BUILTIN_HOSTS } from "../src/lib/model-route.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function makeRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-mcp-disp-"));
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "fixture-events-api",
      version: "0.1.0",
      type: "module",
      scripts: { test: "node --test", lint: "eslint ." },
    }),
    "src/events/events.controller.ts": [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('events')",
      "export class EventsController {",
      "  @Get(':id')",
      "  findOne() {}",
      "}",
      "",
    ].join("\n"),
    "src/events/events.api.ts": ["import axios from 'axios';", "export async function listEvents() {", "  return axios.get('/api/events');", "}", ""].join(
      "\n",
    ),
    "tests/events.test.ts": "import test from 'node:test';\ntest('ok', () => {});\n",
  });
  return root;
}

function makeGitRepoFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `solumbe-mcp-git-${prefix}-`));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  writeFiles(root, {
    "package.json": JSON.stringify({
      name: "fixture-git",
      version: "1.0.0",
      scripts: { test: "node --test", lint: "eslint ." },
    }),
    "src/index.ts": "export const greet = () => 'hi';\n",
  });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  writeFiles(root, { "src/index.ts": "export const greet = () => 'hello';\n" });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "tweak");
  return root;
}

async function runRequests(rawMessages) {
  const input = new PassThrough();
  const output = new PassThrough();
  const collected = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) collected.push(JSON.parse(line));
  });

  const done = startMcpServer({ input, output });
  for (const message of rawMessages) {
    const line = typeof message === "string" ? message : JSON.stringify(message);
    input.write(`${line}\n`);
  }
  input.end();
  await done;
  if (buffer.trim()) collected.push(JSON.parse(buffer));
  return collected;
}

function byId(messages, id) {
  const match = messages.find((m) => m.id === id);
  if (!match) throw new Error(`no response for id ${id}: ${JSON.stringify(messages)}`);
  return match;
}

// The transport now ships a single text payload — compact JSON for data
// results, raw markdown for includeMarkdown:true — and no structuredContent.
// These helpers decode that single payload for assertions.
function rawText(message, id) {
  const result = byId(message, id).result;
  assert.equal(result.structuredContent, undefined, `id ${id} must not ship structuredContent`);
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

function structured(messages, id) {
  return JSON.parse(rawText(messages, id));
}

test("startMcpServer handles initialize, ping, tools/list, and skips notifications", async () => {
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
  ]);

  assert.equal(messages.length, 3, "notifications must not produce a response");
  const init = byId(messages, 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.capabilities.tools.listChanged, false);
  assert.equal(typeof init.result.serverInfo.name, "string");
  assert.equal(typeof init.result.serverInfo.version, "string");
  assert.match(init.result.instructions, /^Use solumbe at each stage/);
  assert.deepEqual(byId(messages, 2).result, {});

  const expectedTools = [
    "repo_inspect",
    "repo_map",
    "repo_index",
    "repo_search",
    "context_pack",
    "change_impact",
    "agent_experience",
    "model_route",
    "convergence_score",
    "review_gate",
    "review_verdict",
    "workspace_report",
    "review_context",
    "repo_harness",
  ];
  const names = byId(messages, 3).result.tools.map((t) => t.name);
  for (const name of expectedTools) {
    assert.ok(names.includes(name), `missing tool: ${name}`);
  }
  // The v2 surface is exactly 14 tools — no more, no fewer. Retired names
  // (repo_discover, repo_catalog, find_*, pr_review, review_pr, merge_readiness,
  // pr_merge_readiness) must NOT appear in tools/list.
  assert.equal(names.length, 14, `tools/list must expose exactly 14 tools, got ${names.length}: ${names.join(", ")}`);
  assert.deepEqual([...names].sort(), [...expectedTools].sort());
  for (const retired of [
    "repo_discover",
    "repo_catalog",
    "find_domain",
    "find_file_kind",
    "find_backend_route",
    "find_frontend_api_client",
    "pr_review",
    "review_pr",
    "merge_readiness",
    "pr_merge_readiness",
  ]) {
    assert.ok(!names.includes(retired), `retired tool must not appear in tools/list: ${retired}`);
  }
});

test("startMcpServer returns -32700 on malformed JSON and skips blank lines", async () => {
  const messages = await runRequests(["", "   ", "{not json"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, null);
  assert.equal(messages[0].error.code, -32700);
  assert.match(messages[0].error.message, /Parse error/);
});

test("startMcpServer rejects invalid envelopes and unknown methods", async () => {
  const messages = await runRequests([
    { jsonrpc: "1.0", id: 10, method: "initialize" },
    { jsonrpc: "2.0", id: 11 },
    { jsonrpc: "2.0", id: 12, method: "no_such_method" },
    "null",
  ]);
  assert.equal(byId(messages, 10).error.code, -32600);
  assert.equal(byId(messages, 11).error.code, -32600);
  assert.equal(byId(messages, 12).error.code, -32601);
  const nullEnvelope = messages.find((m) => m.id === null && m.error?.code === -32600);
  assert.ok(nullEnvelope, "null payload must produce an invalid-request error");
});

test("tools/call validates params, name, arguments, and unknown tools", async () => {
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: "not-an-object" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "   " } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "repo_inspect", arguments: [] } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
  ]);
  for (const id of [1, 2, 3, 4, 5]) {
    const m = byId(messages, id);
    assert.equal(m.error?.code, -32602, `expected -32602 for id ${id}, got ${JSON.stringify(m)}`);
  }
  assert.match(byId(messages, 5).error.message, /Unknown tool/);
});

test("tools/call returns isError content when the underlying tool throws", async () => {
  const bogusPath = path.join(os.tmpdir(), "solumbe-mcp-missing-xyz-abc-123");
  const messages = await runRequests([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_inspect", arguments: { path: bogusPath } } }]);
  const response = byId(messages, 1);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.content[0].type, "text");
  assert.ok(response.result.content[0].text.length > 0);
});

test("repo_inspect, repo_map, and repo_harness produce structured results", async () => {
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_inspect", arguments: { path: fixture } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, includeFiles: true, limit: 5 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, kind: "controller" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, domain: "events", limit: -3 } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "repo_harness", arguments: { path: fixture } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "repo_harness", arguments: { path: fixture, includeMarkdown: true } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "repo_inspect", arguments: { path: fixture, includeScripts: true } } },
  ]);

  const inspect = structured(messages, 1);
  assert.equal(inspect.root, fixture);
  assert.equal(inspect.ok, true);
  assert.ok(Array.isArray(inspect.scriptNames), "inspect must always report script names");
  assert.equal(inspect.scripts, undefined, "script bodies are gated off by default");

  const notable = structured(messages, 2);
  assert.equal(notable.ok, true);
  assert.equal(notable.files, undefined);
  assert.ok(Array.isArray(notable.notableFiles));

  const withFiles = structured(messages, 3);
  assert.equal(withFiles.notableFiles, undefined);
  assert.ok(Array.isArray(withFiles.files));
  assert.ok(withFiles.files.length <= 5);

  const byKind = structured(messages, 4);
  assert.ok(byKind.files.every((file) => file.kind === "controller"));
  assert.ok(byKind.files.some((file) => file.path.endsWith("events.controller.ts")));

  const byDomain = structured(messages, 5);
  assert.ok(byDomain.files.every((file) => (file.domains ?? [file.domain]).some((d) => d?.includes("events"))));

  const harnessOnly = structured(messages, 6);
  assert.ok(harnessOnly.commands, "harness data must include commands");
  assert.equal(harnessOnly.markdown, undefined);

  // includeMarkdown:true returns the markdown report AS the text payload.
  const harnessMarkdown = rawText(messages, 7);
  assert.match(harnessMarkdown, /^#/m, "harness markdown should read as a markdown document");
  assert.throws(() => JSON.parse(harnessMarkdown), "markdown payload must not be JSON");

  const inspectWithScripts = structured(messages, 8);
  assert.ok(inspectWithScripts.scripts, "includeScripts:true must include script command bodies");
  assert.equal(inspectWithScripts.scripts.test, "node --test");
  assert.ok(Array.isArray(inspectWithScripts.scriptNames));
});

test("repo_index dryRun is read-only and does not write the catalog", async () => {
  const fixture = makeRepoFixture();
  const catalogPath = path.join(os.tmpdir(), `solumbe-mcp-dry-${path.basename(fixture)}.json`);
  // Run the dryRun request on its own so the assertion sees the state before any
  // non-dryRun index could write the catalog.
  const messages = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "repo_index", arguments: { paths: [fixture], dryRun: true, catalog: catalogPath, depth: 2, limit: 25 } },
    },
  ]);

  const discover = structured(messages, 1);
  assert.equal(discover.dryRun, true, "dryRun result is flagged");
  assert.ok(discover.repositoryCount >= 1, "dryRun discovers the fixture repo");
  assert.ok(!fs.existsSync(catalogPath), "dryRun must not write a catalog");

  if (fs.existsSync(catalogPath)) fs.unlinkSync(catalogPath);
});

test("repo_index, repo_search query, and no-query repo_search catalog round-trip a fixture", async () => {
  const fixture = makeRepoFixture();
  const catalogPath = path.join(os.tmpdir(), `solumbe-mcp-cat-${path.basename(fixture)}.json`);
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_index", arguments: { paths: [fixture], catalog: catalogPath } } },
    // repo_search with no query returns the catalog listing (old repo_catalog).
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "repo_search", arguments: { catalog: catalogPath } } },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "repo_search", arguments: { query: "events", catalog: catalogPath, limit: 10, offline: true } },
    },
  ]);

  const index = structured(messages, 1);
  assert.equal(index.ok, true);
  assert.ok(fs.existsSync(catalogPath), "a non-dryRun index writes the catalog");

  // No-query repo_search returns the catalog listing.
  const catalog = structured(messages, 2);
  assert.ok(catalog && typeof catalog === "object");
  assert.ok(catalog.repositoryCount >= 1, "no-query repo_search lists cataloged repositories");
  assert.ok(Array.isArray(catalog.repositories), "no-query repo_search returns a repositories array");
  assert.equal(catalog.matchCount, undefined, "no-query repo_search is the catalog listing, not a search result");

  const search = structured(messages, 3);
  assert.ok(search && typeof search === "object");
  assert.ok(search.repositoryCount >= 1, "search against a populated catalog reports repositories");
  assert.equal(search.remediation, undefined, "no remediation hint when the catalog has repositories");

  if (fs.existsSync(catalogPath)) fs.unlinkSync(catalogPath);
});

test("repo_search on an empty catalog returns a remediation hint pointing at repo_index", async () => {
  // A non-existent catalog path loads as an empty catalog (no repositories).
  const emptyCatalog = path.join(os.tmpdir(), `solumbe-mcp-empty-cat-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_search", arguments: { query: "events", catalog: emptyCatalog } } },
  ]);

  const search = structured(messages, 1);
  assert.equal(search.repositoryCount, 0);
  assert.equal(search.matchCount, 0);
  assert.match(search.remediation, /repo_index/);
});

test("context_pack and change_impact require a query and respect includeMarkdown", async () => {
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: { query: "add events tool", path: fixture } } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "context_pack", arguments: { query: "add events tool", path: fixture, includeMarkdown: true } },
    },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context_pack", arguments: { path: fixture } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "change_impact", arguments: { query: "rename event controller", path: fixture, top: 5 } } },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "change_impact", arguments: { query: "rename event controller", path: fixture, includeMarkdown: true } },
    },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "change_impact", arguments: { path: fixture } } },
  ]);

  const dataText = rawText(messages, 1);
  const dataOnly = JSON.parse(dataText);
  assert.equal(dataOnly.markdown, undefined);
  assert.ok(dataOnly.primaryFiles || dataOnly.repositories || dataOnly.intent);
  // Evidence slices are off by default; path/kind/score/reasons are always kept.
  for (const file of dataOnly.primaryFiles ?? []) {
    assert.equal(file.imports, undefined, "imports evidence must be omitted by default");
    assert.equal(file.exports, undefined, "exports evidence must be omitted by default");
    assert.equal(file.symbols, undefined, "symbols evidence must be omitted by default");
    assert.ok(typeof file.path === "string");
    assert.ok(typeof file.kind === "string");
    assert.ok(typeof file.score === "number");
    assert.ok(Array.isArray(file.reasons));
  }

  const withMarkdownText = rawText(messages, 2);
  assert.match(withMarkdownText, /# Context Pack:/, "includeMarkdown returns the markdown report as text");
  assert.throws(() => JSON.parse(withMarkdownText), "markdown payload must not be JSON");
  // The human-readable markdown report is dramatically smaller than the full
  // JSON packet it summarizes — the whole point of the transport change.
  assert.ok(withMarkdownText.length < dataText.length, `markdown (${withMarkdownText.length}) should be smaller than JSON (${dataText.length})`);

  assert.equal(byId(messages, 3).error?.code, -32602);

  const impact = structured(messages, 4);
  assert.equal(impact.markdown, undefined);
  assert.ok(Array.isArray(impact.topFiles));

  const impactMarkdown = rawText(messages, 5);
  assert.throws(() => JSON.parse(impactMarkdown), "impact markdown payload must not be JSON");
  assert.ok(impactMarkdown.length > 0);

  assert.equal(byId(messages, 6).error?.code, -32602);
});

test("agent_experience scores a change, requires a query, and respects includeMarkdown", async () => {
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "agent_experience", arguments: { query: "rename event controller", path: fixture, top: 5 } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "agent_experience", arguments: { query: "rename event controller", path: fixture, includeMarkdown: true } },
    },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "agent_experience", arguments: { path: fixture } } },
  ]);

  const ax = structured(messages, 1);
  assert.equal(ax.markdown, undefined);
  assert.equal(ax.mode, "task");
  assert.ok(Number.isInteger(ax.ax) && ax.ax >= 0 && ax.ax <= 100);
  assert.ok(["poor", "fair", "good", "excellent"].includes(ax.band));
  for (const key of ["changeability", "containment", "guardrails", "clarity"]) {
    assert.ok(Number.isInteger(ax.subScores[key]), `subScores.${key} must be an integer`);
  }

  const axMarkdown = rawText(messages, 2);
  assert.match(axMarkdown, /# Agent Experience \(AX\):/, "includeMarkdown returns the markdown report as text");
  assert.throws(() => JSON.parse(axMarkdown), "AX markdown payload must not be JSON");

  assert.equal(byId(messages, 3).error?.code, -32602);
});

// model_route may call a vendor, so each test pins the key it sees. A test
// must never reach the network because of what the developer's shell exports.
function withRouteKey(t, key) {
  const saved = process.env.TYPESAFE_API_KEY;
  if (key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
  t.after(() => {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  });
}

function stubFetch(t, respond) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return respond();
  };
  t.after(() => {
    globalThis.fetch = saved;
  });
  return calls;
}

const jevRouteAnswers = {
  specificity: { type: "score", score: 0.1, confidence: 0.9, probabilities: [0.9, 0.08, 0.02] },
  blast_radius: { type: "score", score: 0.2, confidence: 0.8, probabilities: [0.8, 0.15, 0.05] },
  novelty: { type: "noul", noul: 0.05 },
};

test("model_route recommends an advisory tier offline, maps a host, and respects includeMarkdown", async (t) => {
  withRouteKey(t, undefined);
  const calls = stubFetch(t, () => {
    throw new Error("no network in this test");
  });
  const fixture = makeRepoFixture();
  const route = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "model_route", arguments: { path: fixture, ...args } } });
  const messages = await runRequests([
    route(1, { query: "rename the events controller", top: 5 }),
    route(2, { query: "rename the events controller", host: "claude-code" }),
    route(3, { query: "rename the events controller", includeMarkdown: true }),
    route(4, { query: "rename the events controller", host: "no-such-host" }),
    route(5, {}),
  ]);

  const data = structured(messages, 1);
  assert.equal(data.advisory, true, "the route is a recommendation, never a selection");
  assert.ok(["cheap", "mid", "premium"].includes(data.tier));
  assert.equal(data.model.source, "offline", "with no key the read is the labelled offline estimate");
  assert.equal(data.hostModel, undefined, "no host, no model id");
  assert.equal(calls.length, 0, "an unkeyed route makes no network call");

  const mapped = structured(messages, 2);
  assert.equal(mapped.hostModel, BUILTIN_HOSTS["claude-code"][mapped.tier]);

  const markdown = rawText(messages, 3);
  assert.match(markdown, /^# Model route: (cheap|mid|premium)/);
  assert.match(markdown, /offline estimate, not calibrated/);

  const unknown = byId(messages, 4).result;
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no model map for host "no-such-host"/);

  assert.equal(byId(messages, 5).error?.code, -32602, "query is required");
});

test("model_route asks the model when a key is set, and never when offline is true", async (t) => {
  withRouteKey(t, "test-key");
  const calls = stubFetch(t, () => ({ ok: true, json: async () => ({ model: "jev-test", usage: { input_tokens: 500 }, answers: jevRouteAnswers }) }));
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "model_route", arguments: { query: "rename the events controller", path: fixture } } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "model_route", arguments: { query: "rename the events controller", path: fixture, offline: true } },
    },
  ]);

  const online = structured(messages, 1);
  assert.equal(online.model.source, "jev");
  assert.equal(online.model.model, "jev-test");
  assert.equal(online.costUsd, 0.000021, "500 input tokens at the documented rate");
  assert.equal(calls.length, 1, "exactly one call, for the keyed request only");
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].body.state.request, "rename the events controller");

  assert.equal(structured(messages, 2).model.source, "offline", "offline:true wins over a key");
});

test("model_route rejects an unknown host before spending the impact pass and a Jev call", async (t) => {
  withRouteKey(t, "test-key");
  const calls = stubFetch(t, () => {
    throw new Error("an unknown host must fail before any network call");
  });
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "model_route", arguments: { query: "rename the events controller", path: fixture, host: "no-such-host" } },
    },
  ]);
  const unknown = byId(messages, 1).result;
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /no model map for host "no-such-host"/);
  assert.equal(calls.length, 0, "the paid call never went out for a config miss");
});

test("a slow tool call does not block a later one behind it on the stdio loop", async (t) => {
  withRouteKey(t, "test-key");
  // model_route (id 1) awaits a 250ms Jev round trip; a ping (id 2) arrives
  // right after it. On a serial loop the ping waits behind the model call, so
  // its response lands second; dispatched concurrently, the ping answers first.
  stubFetch(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { ok: true, json: async () => ({ model: "jev-test", usage: { input_tokens: 100 }, answers: jevRouteAnswers }) };
  });
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "model_route", arguments: { query: "rename the events controller", path: fixture } } },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);
  assert.equal(byId(messages, 1).result.isError, false, "the slow call still answers");
  assert.deepEqual(byId(messages, 2).result, {}, "and so does the ping");
  const order = messages.map((message) => message.id);
  assert.ok(order.indexOf(2) < order.indexOf(1), "the ping was not stuck behind the Jev round trip");
});

test("context_pack default response is compact: no structuredContent, no pretty-print, evidence gated", async () => {
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: { query: "add events tool", path: fixture } } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "context_pack", arguments: { query: "add events tool", path: fixture, includeEvidence: true } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "context_pack", arguments: { query: "add events tool", path: fixture, includeMarkdown: true } },
    },
  ]);

  const defaultText = rawText(messages, 1);
  // No structuredContent (asserted inside rawText) and no pretty-print: the
  // compact JSON has no newline-plus-indentation sequences.
  assert.ok(!/\n {2}/.test(defaultText), "default JSON payload must not be pretty-printed");
  assert.equal(byId(messages, 1).result.structuredContent, undefined);

  const evidenceText = rawText(messages, 2);
  const withEvidence = JSON.parse(evidenceText);
  const evidenceFile = (withEvidence.primaryFiles ?? []).find(
    (file) => Array.isArray(file.exports) || Array.isArray(file.imports) || Array.isArray(file.symbols),
  );
  assert.ok(evidenceFile, "includeEvidence:true must attach imports/exports/symbols to at least one file");

  // Evidence adds bytes; the default packet must be smaller than the evidence one.
  assert.ok(defaultText.length < evidenceText.length, `default (${defaultText.length}) should be smaller than evidence (${evidenceText.length})`);

  // The markdown report is dramatically smaller than the JSON packet.
  const markdownText = rawText(messages, 3);
  assert.ok(markdownText.length < defaultText.length, `markdown (${markdownText.length}) should be far smaller than JSON (${defaultText.length})`);
});

test("review_gate (local), review_context, and review_verdict work against a real git fixture", async () => {
  const fixture = makeGitRepoFixture("merge");
  const messages = await runRequests([
    // review_gate with no pr → local gate (old merge_readiness).
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_gate", arguments: { path: fixture, base: "HEAD~1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "review_context", arguments: { path: fixture, base: "HEAD~1" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "review_context", arguments: { path: fixture, base: "HEAD~1", includeMarkdown: true } } },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "review_verdict", arguments: { path: fixture, base: "HEAD~1", request: "tweak greeting" } },
    },
  ]);

  const merge = structured(messages, 1);
  assert.ok(["PASS", "WARN", "FAIL"].includes(merge.verdict));
  assert.ok(Array.isArray(merge.checks));

  const pr = structured(messages, 2);
  assert.equal(pr.markdown, undefined);
  assert.ok(pr.changedFiles || pr.comparison);

  const prMd = rawText(messages, 3);
  assert.throws(() => JSON.parse(prMd), "review_context markdown payload must not be JSON");
  assert.ok(prMd.length > 0);

  const review = structured(messages, 4);
  assert.ok(review.verdict || review.summary || review.impact);
});

test("review_gate supports a staged pre-commit scope", async () => {
  const fixture = makeGitRepoFixture("staged-gate");
  fs.writeFileSync(path.join(fixture, "src", "index.ts"), "export const hello = 'staged';\n");
  git(fixture, "add", "src/index.ts");

  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "review_gate", arguments: { path: fixture, base: "HEAD", staged: true } } },
  ]);

  const gate = structured(messages, 1);
  assert.equal(gate.scope, "staged");
  assert.ok(gate.changedFiles.includes("src/index.ts"));
});

test("review_gate enforces a convergence floor and receipt through MCP", async () => {
  const fixture = makeGitRepoFixture("merge-convergence");
  const scored = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1", query: "update the greeting" } },
    },
  ]);
  const receipt = structured(scored, 1).receipt.id;
  const gated = await runRequests([
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "review_gate",
        arguments: { path: fixture, base: "HEAD~1", request: "update the greeting", minConvergence: 0, receipt },
      },
    },
  ]);
  const check = structured(gated, 2).checks.find((entry) => entry.name === "Convergence");
  assert.equal(check.status, "PASS");
  assert.match(check.details.join(" "), /Receipt handle: rcpt_/);
});

test("convergence_score scores intent vs diff against a real git fixture, with a recomputable receipt", async () => {
  const fixture = makeGitRepoFixture("converge");
  const messages = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1", query: "update greet in src/index.ts" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1", query: "update greet in src/index.ts", includeMarkdown: true } },
    },
    // Missing base and missing query are both -32602.
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "convergence_score", arguments: { path: fixture, query: "update the greeting" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1" } } },
  ]);

  const conv = structured(messages, 1);
  assert.equal(conv.markdown, undefined);
  assert.ok(Number.isInteger(conv.convergence) && conv.convergence >= 0 && conv.convergence <= 100);
  assert.ok(["aligned", "partial", "drift"].includes(conv.band));
  for (const key of ["coverage", "scope", "riskAlignment"]) {
    assert.ok(Number.isInteger(conv.subScores[key]), `subScores.${key} must be an integer`);
  }
  assert.match(conv.receipt.id, /^rcpt_[0-9a-f]{12}$/, "ships a recomputable receipt id");
  assert.equal(conv.receipt.algorithm, "sha256");
  assert.equal(conv.base, "HEAD~1");

  const convMd = rawText(messages, 2);
  assert.match(convMd, /# Convergence:/, "includeMarkdown returns the markdown report as text");
  assert.throws(() => JSON.parse(convMd), "convergence markdown payload must not be JSON");

  assert.equal(byId(messages, 3).error?.code, -32602, "missing base is rejected");
  assert.equal(byId(messages, 4).error?.code, -32602, "missing query is rejected");
});

test("change_impact declares and amends an intent, and review_gate holds the change against it", async () => {
  const fixture = makeGitRepoFixture("intent");
  const query = "update greet in src/index.ts";
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { path: fixture, ...args } } });

  const declared = structured(await runRequests([call(1, "change_impact", { query, declare: true })]), 1);
  const intent = declared.intent;
  assert.equal(intent.request, query);
  assert.deepEqual(intent.declared.owners, ["src/index.ts"]);
  assert.match(intent.contractHash, /^[0-9a-f]{64}$/);
  assert.ok(!fs.existsSync(path.join(fixture, ".solumbe")), "declaring through the tool writes nothing");

  // The requested edit, plus a file the request never named.
  writeFiles(fixture, { "src/index.ts": "export const greet = () => 'declared';\n", "src/auth/session.ts": "export const ttl = 1;\n" });
  git(fixture, "add", ".");

  const held = await runRequests([
    call(1, "review_gate", { base: "HEAD", staged: true, intent }),
    call(2, "convergence_score", { base: "HEAD", staged: true, query, intent }),
    call(3, "change_impact", { query, intent, amend: { files: ["src/auth/session.ts"], reason: "greet needs a session lifetime" } }),
    call(4, "change_impact", { query: "something else", intent, amend: { files: ["src/auth/session.ts"], reason: "why" } }),
    call(5, "convergence_score", { base: "HEAD", staged: true, query: "something else", intent }),
  ]);
  const contract = structured(held, 1).checks.find((check) => check.name === "Scope contract");
  assert.equal(contract.status, "FAIL");
  assert.match(contract.summary, /^Touched `src\/auth\/session\.ts`, which was never declared\./);
  assert.equal(structured(held, 1).verdict, "FAIL");
  assert.deepEqual(structured(held, 2).contract, { tip: intent.contractHash, undeclared: ["src/auth/session.ts"] });

  const amended = structured(held, 3).intent;
  assert.equal(amended.amendments.length, 1);
  assert.equal(amended.amendments[0].prevHash, intent.contractHash);
  assert.equal(byId(held, 4).result.isError, true, "an amendment for another request is refused");
  assert.equal(byId(held, 5).result.isError, true, "an intent declared for another request is refused");

  const regated = structured(await runRequests([call(1, "review_gate", { base: "HEAD", staged: true, intent: JSON.stringify(amended) })]), 1);
  const passed = regated.checks.find((check) => check.name === "Scope contract");
  assert.equal(passed.status, "PASS");
  assert.ok(passed.details.includes("Amended #1: src/auth/session.ts (greet needs a session lifetime)"));
});

test("convergence_score staged mode returns a Git-index-bound receipt", async () => {
  const fixture = makeGitRepoFixture("converge-staged");
  fs.writeFileSync(path.join(fixture, "src", "index.ts"), "export const greet = () => 'staged';\n");
  git(fixture, "add", "src/index.ts");
  const expectedTree = git(fixture, "write-tree").trim();
  const messages = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD", query: "update the greeting", staged: true } },
    },
  ]);
  const convergence = structured(messages, 1);

  assert.equal(convergence.subject.kind, "git-index");
  assert.equal(convergence.subject.treeSha, expectedTree);
  assert.deepEqual(convergence.receipt.subject, convergence.subject);
});

test("convergence_score and review_gate score an exact base..head commit through MCP", async () => {
  const fixture = makeGitRepoFixture("converge-head");
  const headSha = git(fixture, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(fixture, "src", "index.ts"), "export const greet = () => 'uncommitted';\n");
  fs.writeFileSync(path.join(fixture, "dump.rdb"), "REDIS0011");
  const scored = await runRequests([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1", head: "HEAD", query: "update the greeting" } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "convergence_score", arguments: { path: fixture, base: "HEAD~1", query: "update the greeting", includeUntracked: true } },
    },
  ]);
  const convergence = structured(scored, 1);
  assert.equal(convergence.subject.kind, "git-commit");
  assert.equal(convergence.subject.headSha, headSha);
  assert.equal(convergence.drivers.changedFiles, 1);
  assert.deepEqual(convergence.receipt.subject, convergence.subject);
  assert.deepEqual(structured(scored, 2).untracked, { included: true, count: 1, files: ["dump.rdb"] });

  const gated = await runRequests([
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "review_gate",
        arguments: { path: fixture, base: "HEAD~1", head: "HEAD", request: "update the greeting", receipt: convergence.receipt.inputsHash },
      },
    },
  ]);
  const gate = structured(gated, 3);
  assert.equal(gate.scope, "commit");
  assert.deepEqual(gate.changedFiles, ["src/index.ts"]);
  assert.equal(gate.checks.find((check) => check.name === "Convergence").status, "PASS");
});

test("review_gate and review_verdict gate a named PR on GitHub, and run the local gate for an omitted or blank pr", async (t) => {
  const fixture = makeGitRepoFixture("gate-pr");
  withFakeGh(t, ghPullRequests(fixture));
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { path: fixture, base: "HEAD~1", ...args } } });
  const messages = await runRequests([
    call(1, "review_gate", {}),
    call(2, "review_gate", { pr: "" }),
    call(3, "review_gate", { pr: " " }),
    call(4, "review_gate", { pr: "42" }),
    call(5, "review_verdict", { pr: "" }),
    call(6, "review_verdict", { pr: " " }),
    call(7, "review_verdict", { pr: "42" }),
  ]);
  // The PR gate reports the PR it gated; the local gate reports no PR, and the base ref it diffed.
  const gated = (id) => {
    const report = structured(messages, id);
    return report.pr?.number ?? report.base;
  };
  // review_verdict reports only the gate's checks, and only the PR gate has a PR state check.
  const prState = (id) => structured(messages, id).pass.checks.find((check) => check.name === "PR state")?.summary;

  assert.equal(gated(1), "HEAD~1", "no pr runs the local gate");
  assert.equal(gated(2), "HEAD~1", "a blank pr counts as omitted");
  assert.equal(gated(3), "HEAD~1", "so does a whitespace pr, not the checked-out branch's PR (#7)");
  assert.equal(gated(4), 42, "a pr naming a PR gates that PR on GitHub");
  assert.equal(prState(5), undefined, "review_verdict runs the local gate for a blank pr");
  assert.equal(prState(6), undefined, "and for a whitespace pr, as review_gate does");
  assert.equal(prState(7), "PR is not draft and has no reported merge conflicts.", "review_verdict gates a named PR on GitHub");
});

test("pr_merge_readiness gates the checked-out branch's PR when its selector is omitted or blank, as it did before 2.0", async (t) => {
  const fixture = makeGitRepoFixture("gate-pr-legacy");
  withFakeGh(t, ghPullRequests(fixture));
  const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "pr_merge_readiness", arguments: { path: fixture, ...args } } });
  const messages = await runRequests([call(1, {}), call(2, { selector: "" }), call(3, { selector: " " }), call(4, { selector: "42" }), call(5, { pr: "42" })]);
  const gated = (id) => structured(messages, id).pr?.number;

  assert.equal(gated(1), 7, "no selector gates the checked-out branch's PR, as `gh pr view` does");
  assert.equal(gated(2), 7, "a blank selector counts as omitted");
  assert.equal(gated(3), 7, "so does a whitespace selector");
  assert.equal(gated(4), 42, "a selector names the PR to gate");
  assert.equal(gated(5), 42, "review_gate's pr still stands in for the selector");
});

// Pin the user config tier to an empty directory, so a developer's own
// ~/.config/solumbe/config.json cannot decide a gate's policy or governance.
function withEmptyUserConfig(t) {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-mcp-xdg-"));
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });
}

function withCwd(t, dir) {
  const saved = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(saved));
}

// Put a `gh` on PATH that answers the GitHub gate from canned JSON, keyed by
// argument prefix, so a review_gate pr call runs evaluatePR end to end offline.
function withFakeGh(t, responses) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-mcp-gh-"));
  const gh = path.join(bin, "gh");
  // A shell script, not a node one: a PR gate calls gh several times in a row
  // under 20 and 30 second timeouts, and on a loaded machine a node start
  // alone has taken longer than that. /bin/sh starts in milliseconds. Each
  // canned answer sits in its own file beside the script, so none of it needs
  // quoting; the first prefix that matches answers, as before.
  const cases = Object.keys(responses).map((prefix, index) => {
    const answer = path.join(bin, `answer-${index}`);
    fs.writeFileSync(answer, responses[prefix]);
    const literal = `"${prefix.replace(/[\\"$`]/g, "\\$&")}"`;
    return `  ${literal} | ${literal}" "*) cat "${answer}"; exit 0 ;;`;
  });
  fs.writeFileSync(gh, ["#!/bin/sh", 'case "$*" in', ...cases, "esac", 'echo "unexpected gh args: $*" >&2', "exit 1", ""].join("\n"));
  fs.chmodSync(gh, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  t.after(() => {
    process.env.PATH = saved;
  });
}

// withFakeGh responses for a makeGitRepoFixture repository: `gh pr view 42`
// answers #42, and a bare `gh pr view`, which gh reads as the checked-out
// branch's PR, answers #7. Any other `pr view` fails.
function ghPullRequests(fixture) {
  const pullRequest = (number) =>
    JSON.stringify({
      number,
      title: "Tweak greeting",
      url: `https://github.com/org/repo/pull/${number}`,
      state: "OPEN",
      mergedAt: null,
      baseRefName: "main",
      baseRefOid: git(fixture, "rev-parse", "HEAD~1").trim(),
      headRefOid: git(fixture, "rev-parse", "HEAD").trim(),
      changedFiles: 1,
      isDraft: false,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      files: [{ path: "src/index.ts" }],
      reviews: [],
      statusCheckRollup: [],
    });
  return { "pr view 42": pullRequest(42), "pr view --json": pullRequest(7) };
}

test("review_gate and review_verdict fill an omitted policy and governance from the gated repository's config", async (t) => {
  withEmptyUserConfig(t);
  const configured = makeGitRepoFixture("gate-config");
  fs.writeFileSync(path.join(configured, ".solumberc.json"), JSON.stringify({ policy: "high-risk", governance: "solo" }));
  const unconfigured = makeGitRepoFixture("gate-no-config");
  // The server runs inside the configured repository, so a lookup from its cwd
  // instead of the gated path would wrongly gate `unconfigured` as solo too.
  withCwd(t, configured);
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { base: "HEAD~1", ...args } } });
  const messages = await runRequests([
    call(1, "review_gate", { path: configured }),
    call(2, "review_verdict", { path: configured, request: "tweak greeting" }),
    call(3, "review_gate", { path: configured, policy: "standard", governance: "team" }),
    call(4, "review_gate", { path: configured, policy: " ", governance: "" }),
    call(5, "review_gate", { path: unconfigured }),
    call(6, "review_gate", {}),
  ]);
  const settings = (report) => ({ policy: report.policy, governance: report.governance });

  assert.deepEqual(settings(structured(messages, 1)), { policy: "high-risk", governance: "solo" }, "the repository's .solumberc.json fills omitted arguments");
  assert.deepEqual(settings(structured(messages, 2).pass), { policy: "high-risk", governance: "solo" }, "review_verdict gates under the same config");
  assert.deepEqual(settings(structured(messages, 3)), { policy: "standard", governance: "team" }, "an explicit argument still wins");
  assert.deepEqual(settings(structured(messages, 4)), { policy: "high-risk", governance: "solo" }, "a blank argument counts as omitted");
  assert.deepEqual(settings(structured(messages, 5)), { policy: "standard", governance: "team" }, "config comes from the gated path, not the server's cwd");
  assert.deepEqual(settings(structured(messages, 6)), { policy: "high-risk", governance: "solo" }, "no path gates the cwd under the cwd's config");
});

test("review_gate in PR mode applies the repository's solo governance, as `solumbe pass-pr` does", async (t) => {
  // The 2026-09-26 split on PR #214: `solumbe pass-pr 214` read .solumberc.json and
  // warned on CODEOWNERS under solo governance, while review_gate { pr: "214" }
  // ignored it and failed CODEOWNERS under team governance.
  withEmptyUserConfig(t);
  const fixture = makeGitRepoFixture("gate-pr-config");
  writeFiles(fixture, {
    ".solumberc.json": JSON.stringify({ governance: "solo" }),
    ".github/CODEOWNERS": "src/index.ts @alice\n",
  });
  withFakeGh(t, {
    "pr view": JSON.stringify({
      number: 42,
      title: "Tweak greeting",
      url: "https://github.com/org/repo/pull/42",
      state: "OPEN",
      mergedAt: null,
      baseRefName: "main",
      baseRefOid: git(fixture, "rev-parse", "HEAD~1").trim(),
      headRefOid: git(fixture, "rev-parse", "HEAD").trim(),
      changedFiles: 1,
      isDraft: false,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      files: [{ path: "src/index.ts" }],
      reviews: [],
      statusCheckRollup: [{ name: "tests", conclusion: "SUCCESS" }],
    }),
    "repo view": JSON.stringify({ nameWithOwner: "org/repo" }),
    "api graphql": JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
    "api repos/org/repo/branches/main/protection": JSON.stringify({
      required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true },
      required_status_checks: { contexts: ["tests"], checks: [{ context: "tests" }] },
      required_conversation_resolution: { enabled: true },
    }),
  });
  const gate = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "review_gate", arguments: { path: fixture, pr: "42", ...args } } });
  const messages = await runRequests([gate(1, {}), gate(2, { governance: "team" })]);
  const codeowners = (report) => report.checks.find((check) => check.name === "CODEOWNERS");

  const solo = structured(messages, 1);
  assert.equal(solo.governance, "solo");
  assert.equal(codeowners(solo).status, "WARN");
  assert.match(codeowners(solo).summary, /solo-maintainer mode requires an explicit owner\/admin merge decision/);

  const team = structured(messages, 2);
  assert.equal(team.governance, "team", "an explicit governance still overrides the repository's config");
  assert.equal(codeowners(team).status, "FAIL");
  assert.equal(team.verdict, "FAIL");
});

test("workspace_report requires two paths and accepts includeMarkdown", async () => {
  const fixtureA = makeRepoFixture();
  const fixtureB = makeRepoFixture();
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_report", arguments: { paths: [fixtureA] } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "workspace_report", arguments: { paths: [fixtureA, fixtureB] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_report", arguments: { paths: [fixtureA, fixtureB], includeMarkdown: true } } },
  ]);
  assert.equal(byId(messages, 1).error?.code, -32602);
  const summary = structured(messages, 2);
  assert.equal(summary.markdown, undefined);
  assert.ok(summary.repositories || summary.repos || summary.summary);
  const withMarkdown = rawText(messages, 3);
  assert.throws(() => JSON.parse(withMarkdown), "workspace markdown payload must not be JSON");
  assert.ok(withMarkdown.length > 0);
});

test("repo_map domain/kind/route filters fold in the retired find_* tools", async () => {
  const fixture = makeRepoFixture();
  const messages = await runRequests([
    // domain filter (find_domain)
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, domain: "events", includeFiles: true, limit: 5 } } },
    // kind filter (find_file_kind)
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, kind: "controller", includeFiles: true } } },
    // controller route filter (find_backend_route) — substring match on the combined route
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "repo_map", arguments: { path: fixture, kind: "controller", route: "events", includeFiles: true } },
    },
    // route filter accepts a regex anchored to the controller route
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "repo_map", arguments: { path: fixture, kind: "controller", route: "^/events/.*", includeFiles: true } },
    },
    // a route that matches nothing returns an empty file set
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "repo_map", arguments: { path: fixture, kind: "controller", route: "no-such-route-xyz", includeFiles: true } },
    },
    // apiClient kind (find_frontend_api_client)
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "repo_map", arguments: { path: fixture, kind: "apiClient", includeFiles: true } } },
  ]);

  const byDomain = structured(messages, 1);
  assert.ok(Array.isArray(byDomain.files));
  assert.ok(byDomain.files.length > 0, "domain filter returns matching files");
  assert.ok(byDomain.files.every((file) => (file.domains ?? [file.domain]).some((d) => d?.includes("events"))));

  const byKind = structured(messages, 2);
  assert.ok(byKind.files.every((file) => file.kind === "controller"));
  assert.ok(byKind.files.some((file) => file.path.endsWith("events.controller.ts")));

  const byRoute = structured(messages, 3);
  assert.ok(byRoute.files.length > 0, "route substring matches the events controller");
  assert.ok(byRoute.files.some((file) => file.path.endsWith("events.controller.ts")));
  assert.ok(byRoute.files.every((file) => file.kind === "controller"));

  const byRouteRegex = structured(messages, 4);
  assert.ok(
    byRouteRegex.files.some((file) => file.path.endsWith("events.controller.ts")),
    "regex route pattern matches the /events/:id route",
  );

  const noMatch = structured(messages, 5);
  assert.equal(noMatch.files.length, 0, "an unmatched route yields no files");

  const apiClient = structured(messages, 6);
  assert.equal(apiClient.ok, true);
  assert.ok(Array.isArray(apiClient.files));
  assert.ok(apiClient.files.every((file) => file.kind === "apiClient"));
});

test("every legacy tool name still dispatches to a sane result via tools/call", async () => {
  const fixture = makeRepoFixture();
  const gitFixture = makeGitRepoFixture("legacy");
  const catalogPath = path.join(os.tmpdir(), `solumbe-mcp-legacy-cat-${path.basename(fixture)}.json`);

  // Seed the catalog so repo_catalog (no-query repo_search) has something to list.
  await runRequests([{ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "repo_index", arguments: { paths: [fixture], catalog: catalogPath } } }]);

  const messages = await runRequests([
    // Renames
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pr_review", arguments: { path: gitFixture, base: "HEAD~1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "review_pr", arguments: { path: gitFixture, base: "HEAD~1", request: "tweak greeting" } } },
    // Gate merges
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "merge_readiness", arguments: { path: gitFixture, base: "HEAD~1" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pr_merge_readiness", arguments: { path: gitFixture, selector: "123" } } },
    // Folded discovery/catalog
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "repo_catalog", arguments: { catalog: catalogPath } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "repo_discover", arguments: { paths: [fixture], depth: 2 } } },
    // Folded find_* tools
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "find_domain", arguments: { path: fixture, domain: "events" } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "find_file_kind", arguments: { path: fixture, kind: "controller" } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "find_backend_route", arguments: { path: fixture, query: "events" } } },
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "find_frontend_api_client", arguments: { path: fixture } } },
  ]);

  // pr_review → review_context: diff/comment context, no verdict.
  const prReview = structured(messages, 1);
  assert.ok(prReview.changedFiles || prReview.comparison, "pr_review alias yields review context");

  // review_pr → review_verdict: composite verdict.
  const reviewPr = structured(messages, 2);
  assert.ok(reviewPr.verdict || reviewPr.summary || reviewPr.impact, "review_pr alias yields a composite verdict");

  // merge_readiness → review_gate (local): PASS/WARN/FAIL.
  const mergeReadiness = structured(messages, 3);
  assert.ok(["PASS", "WARN", "FAIL"].includes(mergeReadiness.verdict), "merge_readiness alias yields a local gate verdict");
  assert.ok(Array.isArray(mergeReadiness.checks));

  // pr_merge_readiness → review_gate (PR): routes through the GitHub gate.
  assert.ok(byId(messages, 4).result.content[0].text.length > 0, "pr_merge_readiness alias routes to the PR gate");

  // repo_catalog → no-query repo_search: catalog listing.
  const catalog = structured(messages, 5);
  assert.ok(Array.isArray(catalog.repositories), "repo_catalog alias lists the catalog");
  assert.ok(catalog.repositoryCount >= 1);

  // repo_discover → repo_index dryRun: read-only discovery, no catalog write.
  const discover = structured(messages, 6);
  assert.equal(discover.dryRun, true, "repo_discover alias maps to dryRun discovery");
  assert.ok(discover.repositoryCount >= 1);

  // find_domain → repo_map domain filter.
  const findDomain = structured(messages, 7);
  assert.ok(Array.isArray(findDomain.files), "find_domain alias returns repo_map files");
  assert.ok(findDomain.files.every((file) => (file.domains ?? [file.domain]).some((d) => d?.includes("events"))));

  // find_file_kind → repo_map kind filter.
  const findKind = structured(messages, 8);
  assert.ok(findKind.files.every((file) => file.kind === "controller"));

  // find_backend_route → repo_map kind:controller + route filter.
  const findRoute = structured(messages, 9);
  assert.ok(findRoute.files.every((file) => file.kind === "controller"));
  assert.ok(findRoute.files.some((file) => file.path.endsWith("events.controller.ts")));

  // find_frontend_api_client → repo_map kind:apiClient.
  const findApi = structured(messages, 10);
  assert.ok(findApi.files.every((file) => file.kind === "apiClient"));

  if (fs.existsSync(catalogPath)) fs.unlinkSync(catalogPath);
});

test("docs/02 maps every legacy tool name to the tool it dispatches to", () => {
  const doc = fs.readFileSync(new URL("../docs/02-mcp-agent-workflows/README.md", import.meta.url), "utf8");
  const section = doc.split(/^### Legacy tool names$/m)[1]?.split(/^#{1,3} |^---$/m)[0] ?? "";
  const documented = Object.fromEntries([...section.matchAll(/^\| `(\w+)`\s*\| `(\w+)`/gm)].map(([, legacy, tool]) => [legacy, tool]));
  const dispatched = Object.fromEntries(Object.entries(LEGACY_TOOL_ALIASES).map(([legacy, alias]) => [legacy, alias.tool]));
  assert.deepEqual(documented, dispatched);
});

test("startMcpServer never responds to notifications, including unknown methods", async () => {
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
    { jsonrpc: "2.0", method: "some/unknown_notification" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ]);

  assert.equal(messages.length, 2, "only the two pings may produce responses");
  assert.deepEqual(byId(messages, 1).result, {});
  assert.deepEqual(byId(messages, 2).result, {});
});

test("initialize negotiates the protocol version against supported revisions", async () => {
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    { jsonrpc: "2.0", id: 3, method: "initialize", params: {} },
  ]);

  assert.equal(byId(messages, 1).result.protocolVersion, "2025-03-26");
  assert.equal(byId(messages, 2).result.protocolVersion, "2025-06-18");
  assert.equal(byId(messages, 3).result.protocolVersion, "2025-06-18");
});

test("agent-tools catalog stays in parity with the MCP tools array", () => {
  const catalog = getAgentTools();
  const catalogByName = new Map(catalog.tools.map((tool) => [tool.name, tool]));

  assert.equal(catalog.tools.length, tools.length, "agent-tools must expose exactly the MCP tool set");

  for (const tool of tools) {
    const derived = catalogByName.get(tool.name);
    assert.ok(derived, `agent-tools is missing MCP tool: ${tool.name}`);
    assert.equal(derived.description, tool.description, `description drift for ${tool.name}`);

    const schemaProps = Object.keys(tool.inputSchema?.properties ?? {}).sort();
    const inputProps = Object.keys(derived.input ?? {}).sort();
    assert.deepEqual(inputProps, schemaProps, `option drift for ${tool.name}`);

    const required = new Set(tool.inputSchema?.required ?? []);
    for (const [name, value] of Object.entries(derived.input ?? {})) {
      const optional = value.endsWith("?");
      assert.equal(optional, !required.has(name), `required flag drift for ${tool.name}.${name}`);
    }
  }
});

test("every MCP tool declares an explicit readOnlyHint annotation", () => {
  for (const tool of tools) {
    assert.ok(tool.annotations, `tool ${tool.name} must declare annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `tool ${tool.name} must declare a boolean readOnlyHint`);
  }

  // Tools that mutate persistent state are honestly flagged non-read-only.
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("repo_index").annotations.readOnlyHint, false, "repo_index mutates the catalog");
  assert.equal(byName.get("review_context").annotations.readOnlyHint, false, "review_context can post a GitHub comment");
  assert.equal(byName.get("repo_inspect").annotations.readOnlyHint, true);
  assert.equal(byName.get("context_pack").annotations.readOnlyHint, true);
  // Staged convergence uses `git write-tree`, which may write Git object/cache
  // metadata even though it never changes source files. MCP annotations cannot
  // vary by input, so these tools are conservatively non-read-only.
  assert.equal(byName.get("convergence_score").annotations.readOnlyHint, false);
  assert.equal(byName.get("review_gate").annotations.readOnlyHint, false);
  // model_route writes nothing, but may call TypeSafe, so it says it reaches
  // outside this machine.
  assert.equal(byName.get("model_route").annotations.readOnlyHint, true);
  assert.equal(byName.get("model_route").annotations.openWorldHint, true);
});

test("the review_* tool descriptions are verb-first and state when to use each vs its siblings", () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const family = ["review_context", "review_gate", "review_verdict"];

  for (const name of family) {
    const description = byName.get(name).description;
    // Verb-first: first word is a capitalized imperative verb, no leading noun phrase.
    assert.match(description, /^[A-Z][a-z]+ /, `${name} description should start with a verb`);
    // Each review_* description cross-references at least one sibling by name.
    const siblings = family.filter((other) => other !== name);
    assert.ok(
      siblings.some((sibling) => description.includes(sibling)),
      `${name} should name a sibling review_* tool to disambiguate, got: ${description}`,
    );
  }
});

test("the initialize instructions only name tools the server lists", async () => {
  const messages = await runRequests([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const listed = new Set(byId(messages, 2).result.tools.map((tool) => tool.name));
  const { AGENT_WORKFLOW_STAGES } = await import("../src/lib/agent-workflow.js");

  for (const { tool } of AGENT_WORKFLOW_STAGES) {
    assert.ok(listed.has(tool), `workflow names ${tool}, which tools/list does not have`);
    assert.ok(byId(messages, 1).result.instructions.includes(`: ${tool}.`), tool);
  }
  for (const named of byId(messages, 1).result.instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? []) {
    assert.ok(listed.has(named), `instructions mention ${named}, which tools/list does not have`);
  }
});

test("the solumbe skill lists the same workflow tools the server sends", async () => {
  const { AGENT_WORKFLOW_STAGES } = await import("../src/lib/agent-workflow.js");
  const skill = fs.readFileSync(path.resolve("codex/skills/solumbe/SKILL.md"), "utf8");
  const section = skill.slice(skill.indexOf("### Over MCP"));
  const rows = [...section.matchAll(/^\| (.+?) +\| `([a-z_]+)` +\|$/gm)].map(([, stage, tool]) => ({ stage, tool }));
  assert.deepEqual(
    rows,
    AGENT_WORKFLOW_STAGES.map(({ stage, tool }) => ({ stage, tool })),
  );
});

test("the check trial withholds a warning or a score in the withheld arm and leaves everything else alone", async (t) => {
  const fixture = makeGitRepoFixture("check-trial");
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-mcp-trial-")), "check-decisions.jsonl");
  const saved = { mode: process.env.SOLUMBE_CHECK_MODE, share: process.env.SOLUMBE_CHECK_SHOWN_SHARE, log: process.env.SOLUMBE_CHECK_LOG };
  t.after(() => {
    for (const [key, value] of [
      ["SOLUMBE_CHECK_MODE", saved.mode],
      ["SOLUMBE_CHECK_SHOWN_SHARE", saved.share],
      ["SOLUMBE_CHECK_LOG", saved.log],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { path: fixture, base: "HEAD~1", ...args } } });
  const requests = [
    call(1, "convergence_score", { query: "update greet in src/index.ts" }),
    call(2, "review_gate", {}),
    call(3, "change_impact", { query: "add an events endpoint" }),
  ];

  process.env.SOLUMBE_CHECK_LOG = log;
  process.env.SOLUMBE_CHECK_MODE = "trial";
  process.env.SOLUMBE_CHECK_SHOWN_SHARE = "0";
  const withheld = await runRequests(requests);
  assert.equal(structured(withheld, 1).withheld, true);
  assert.equal(structured(withheld, 1).convergence, undefined, "the score is not in what the agent sees");
  assert.equal(structured(withheld, 2).withheld, true);
  assert.equal(structured(withheld, 2).checks, undefined);
  assert.equal(structured(withheld, 3).withheld, undefined, "a tool outside the trial answers as usual");

  process.env.SOLUMBE_CHECK_SHOWN_SHARE = "1";
  const shown = await runRequests(requests);
  assert.equal(typeof structured(shown, 1).convergence, "number");
  assert.ok(["PASS", "WARN", "FAIL"].includes(structured(shown, 2).verdict));

  const decisions = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    decisions.map((entry) => [entry.tool, entry.arm, entry.withheld]),
    [
      ["convergence_score", "withheld", true],
      ["review_gate", "withheld", true],
      ["convergence_score", "shown", false],
      ["review_gate", "shown", false],
    ],
  );
  assert.equal(typeof decisions[0].convergence, "number", "the log keeps the result the agent did not see");

  delete process.env.SOLUMBE_CHECK_MODE;
  const off = await runRequests(requests);
  assert.equal(typeof structured(off, 1).convergence, "number");
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 4, "nothing is logged outside the trial");
});
