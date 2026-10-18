import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCanUseTool, createPreToolUseHook, inDeclaredScope } from "../integrations/agent-sdk/guardrails.mjs";
import { buildQueryOptions, modelForRoute, readGate, runOrchestrator } from "../integrations/agent-sdk/orchestrator.mjs";
import { parseArgs } from "../integrations/agent-sdk/run.mjs";
import { createSolumbeClient, isWithheld, streamTransport } from "../integrations/agent-sdk/solumbe-client.mjs";
import { startMcpServer } from "../src/lib/mcp.js";

// No network anywhere in this file: the Agent SDK's query() is a scripted
// fake, and solumbe is either a fake or its real server on in-process streams.

const repo = path.resolve("/tmp/agent-sdk-example-repo");
const intent = {
  schema: "solumbe.intent/v1",
  request: "add a --json flag to status",
  declared: { owners: ["src/status.js"], supporting: ["docs/status.md"], modules: ["src/status"] },
  amendments: [],
};

/**
 * A fake solumbe with canned answers; records every call in order.
 * @param {{ gate?: any, impact?: any }} [answers]
 */
function fakeSolumbe({ gate = { verdict: "PASS", checks: [{ name: "Changed files", status: "PASS", summary: "2 files" }] }, impact = { intent } } = {}) {
  /** @type {string[]} */
  const calls = [];
  /** @type {any[]} */
  const gateArgs = [];
  return {
    calls,
    gateArgs,
    contextPack: async () => (calls.push("context_pack"), { primaryFiles: [{ path: "src/status.js" }, { path: "src/cli.js" }] }),
    modelRoute: async (/** @type {{ query: string }} */ { query }) => {
      calls.push("model_route");
      return query.startsWith("Write and run tests") ? { tier: "cheap", hostModel: "claude-haiku-5-5" } : { tier: "premium", hostModel: "claude-opus-5-5" };
    },
    declareIntent: async () => (calls.push("change_impact"), impact),
    reviewGate: async (/** @type {any} */ args) => (calls.push("review_gate"), gateArgs.push(args), gate),
  };
}

/**
 * A scripted stand-in for the SDK's query(): it runs each scripted tool call
 * through the hook and the permission callback the orchestrator configured,
 * then yields a result message.
 * @param {{ toolCalls?: { tool: string, input: any }[], result?: any }} [script]
 */
function fakeQuery({
  toolCalls = [],
  result = { type: "result", subtype: "success", result: "Added --json; tests pass.", total_cost_usd: 0.42, num_turns: 7 },
} = {}) {
  const seen = { prompt: "", options: /** @type {any} */ (null), outcomes: /** @type {any[]} */ ([]) };
  /** @param {{ prompt: string, options: any }} args */
  const query = async function* ({ prompt, options }) {
    seen.prompt = prompt;
    seen.options = options;
    yield { type: "system", subtype: "init" };
    for (const { tool, input } of toolCalls) {
      const hook = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t" }, "t", {});
      if (hook.hookSpecificOutput?.permissionDecision === "deny") {
        seen.outcomes.push({ tool, by: "hook", reason: hook.hookSpecificOutput.permissionDecisionReason });
        continue;
      }
      if (options.allowedTools.includes(tool)) {
        seen.outcomes.push({ tool, by: "allowedTools" });
        continue;
      }
      const decision = await options.canUseTool(tool, input, { signal: new globalThis.AbortController().signal });
      seen.outcomes.push({ tool, by: "canUseTool", behavior: decision.behavior, reason: decision.message });
    }
    yield result;
  };
  return { query, seen };
}

test("a passing run plans, routes, declares, delegates, gates and proposes in that order", async () => {
  const solumbe = fakeSolumbe();
  const { query, seen } = fakeQuery({
    toolCalls: [
      { tool: "Read", input: { file_path: "src/status.js" } },
      { tool: "Edit", input: { file_path: `${repo}/src/status.js` } },
    ],
  });
  let escalated = false;
  const result = await runOrchestrator({ task: "add a --json flag to status", repo, query, solumbe, escalate: () => void (escalated = true) });

  assert.deepEqual(solumbe.calls, ["context_pack", "model_route", "model_route", "change_impact", "review_gate"]);
  assert.equal(result.status, "proposed");
  assert.equal(result.verdict, "PASS");
  assert.equal(escalated, false);
  assert.deepEqual(solumbe.gateArgs[0].intent, intent, "the gate checks the diff against the intent declared before the edit");
  assert.equal(solumbe.gateArgs[0].base, "origin/develop");

  assert.equal(seen.options.agents.implementer.model, "claude-opus-5-5");
  assert.equal(seen.options.agents["test-writer"].model, "claude-haiku-5-5", "each subagent gets its own routed model");
  assert.match(seen.prompt, /src\/status\.js, src\/cli\.js/);
  assert.deepEqual(seen.outcomes, [
    { tool: "Read", by: "allowedTools" },
    { tool: "Edit", by: "canUseTool", behavior: "allow", reason: undefined },
  ]);
  assert.match(result.prBody ?? "", /Verdict: \*\*PASS\*\*/);
  assert.match(result.prBody ?? "", /cost: \$0\.42, turns: 7/);
});

test("a FAIL verdict blocks the merge and escalates with the gate's reasons", async () => {
  const gate = {
    verdict: "FAIL",
    checks: [
      { name: "Scope contract", status: "FAIL", summary: "src/billing.js was never declared." },
      { name: "Secret safety", status: "PASS", summary: "clean" },
    ],
  };
  const solumbe = fakeSolumbe({ gate });
  const { query } = fakeQuery();
  /** @type {any[]} */
  const escalations = [];
  const result = await runOrchestrator({ task: "add a --json flag to status", repo, query, solumbe, escalate: (e) => void escalations.push(e) });

  assert.equal(result.status, "escalated");
  assert.equal(result.prBody, undefined, "nothing is proposed for merge");
  assert.deepEqual(escalations, [
    { kind: "gate-fail", verdict: "FAIL", reasons: ["Scope contract: src/billing.js was never declared."], task: "add a --json flag to status" },
  ]);
});

test("a withheld gate result is non-blocking and says so in the PR body", async () => {
  const solumbe = fakeSolumbe({ gate: { ok: true, withheld: true, tool: "review_gate", message: "withheld arm: recorded, not shown" } });
  const { query } = fakeQuery();
  const result = await runOrchestrator({ task: "t", repo, query, solumbe });
  assert.equal(result.status, "proposed");
  assert.equal(result.verdict, "WITHHELD");
  assert.match(result.prBody ?? "", /Verdict withheld by the solumbe check trial/);
});

test("no declared intent means no edit: the run stops before the SDK is called", async () => {
  const solumbe = fakeSolumbe({ impact: { ok: true } });
  const { query, seen } = fakeQuery();
  await assert.rejects(runOrchestrator({ task: "t", repo, query, solumbe }), /no declared intent/);
  assert.equal(seen.options, null);
});

test("a run that hits the budget cap escalates without reaching the gate", async () => {
  const solumbe = fakeSolumbe();
  const { query } = fakeQuery({ result: { type: "result", subtype: "error_max_budget_usd", total_cost_usd: 1, num_turns: 3 } });
  /** @type {any[]} */
  const escalations = [];
  const result = await runOrchestrator({ task: "t", repo, query, solumbe, limits: { maxBudgetUsd: 1 }, escalate: (e) => void escalations.push(e) });
  assert.equal(result.status, "escalated");
  assert.ok(!solumbe.calls.includes("review_gate"));
  assert.equal(escalations[0].kind, "run-error");
  assert.match(escalations[0].reasons[0], /error_max_budget_usd \(budget \$1\)/);
});

test("query options carry every guardrail: tools, allow-list, limits, isolation, callback and hook", () => {
  const options = buildQueryOptions({
    repo,
    intent,
    routes: { implementer: { model: "sonnet" }, "test-writer": { model: "haiku" } },
    limits: { maxTurns: 12, maxBudgetUsd: 2, leadModel: "claude-opus-5-5" },
    solumbeServer: { type: "stdio", command: "solumbe", args: ["mcp"] },
    log: () => {},
  });
  assert.equal(options.maxTurns, 12);
  assert.equal(options.maxBudgetUsd, 2);
  assert.equal(options.permissionMode, "default");
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.allowedTools, ["Read", "Glob", "Grep", "mcp__solumbe__context_pack", "mcp__solumbe__repo_search"]);
  for (const write of ["Edit", "Write", "Bash"]) assert.ok(!options.allowedTools.includes(write), `${write} is never auto-approved`);
  assert.ok(options.disallowedTools.includes("mcp__solumbe__review_gate"), "agents cannot run the gate on themselves");
  assert.ok(!options.agents.implementer.tools.includes("Bash"));
  assert.ok(!options.agents["test-writer"].tools.includes("mcp__solumbe__context_pack"));
  assert.equal(typeof options.canUseTool, "function");
  assert.equal(typeof options.hooks.PreToolUse[0].hooks[0], "function");
});

test("the PreToolUse hook hard-denies out-of-scope writes, escapes and dangerous commands", async () => {
  /** @type {any[]} */
  const log = [];
  const hook = createPreToolUseHook({ root: repo, intent, log: (e) => log.push(e) });
  const decide = async (/** @type {string} */ tool, /** @type {any} */ input) =>
    (await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input })).hookSpecificOutput?.permissionDecision ?? "pass";

  assert.equal(await decide("Edit", { file_path: "src/status.js" }), "pass");
  assert.equal(await decide("Write", { file_path: "src/status/format.js" }), "pass", "a new file in a declared module is in scope");
  assert.equal(await decide("Write", { file_path: "tests/status.test.js" }), "pass", "tests are in scope");
  assert.equal(await decide("Edit", { file_path: "src/billing.js" }), "deny");
  assert.equal(await decide("Write", { file_path: "/etc/hosts" }), "deny");
  assert.equal(await decide("Write", { file_path: "../other/x.js" }), "deny");
  assert.equal(await decide("Write", { file_path: ".git/config" }), "deny");
  assert.equal(await decide("Bash", { command: "git push origin HEAD" }), "deny");
  assert.equal(await decide("Bash", { command: "gh pr merge 12" }), "deny");
  assert.equal(await decide("Bash", { command: "npm test && npm publish" }), "deny");
  assert.equal(await decide("mcp__solumbe__review_gate", {}), "deny");
  assert.equal(log.filter((e) => e.decision === "deny").length, 8);
});

test("canUseTool allows test commands and in-scope edits, and denies everything else", async () => {
  const canUseTool = createCanUseTool({ root: repo, intent });
  const decide = async (/** @type {string} */ tool, /** @type {any} */ input) => (await canUseTool(tool, input)).behavior;
  assert.equal(await decide("Edit", { file_path: "src/status.js" }), "allow");
  assert.equal(await decide("Bash", { command: "npm test" }), "allow");
  assert.equal(await decide("Bash", { command: "node --test tests/status.test.js" }), "allow");
  assert.equal(await decide("Bash", { command: "curl https://example.com" }), "deny");
  assert.equal(await decide("Bash", { command: "npm test; rm -rf /" }), "deny");
  assert.equal(await decide("Edit", { file_path: "src/billing.js" }), "deny");
  assert.equal(await decide("NotebookEdit", {}), "deny");
});

test("scope, routing and gate helpers handle partial answers", () => {
  assert.equal(inDeclaredScope("docs/status.md", intent), true);
  assert.equal(inDeclaredScope("src/later.js", { ...intent, amendments: [{ files: ["src/later.js"], reason: "r" }] }), true);
  assert.equal(inDeclaredScope("src/status-other.js", intent), false, "a module prefix matches whole path segments only");
  assert.deepEqual(modelForRoute({ tier: "cheap" }), { tier: "cheap", model: "haiku" });
  assert.deepEqual(modelForRoute(null), { tier: "mid", model: "sonnet" });
  assert.deepEqual(readGate({ verdict: "WARN", checks: [{ name: "Risk review", status: "WARN", summary: "auth path" }] }), {
    verdict: "WARN",
    blocked: false,
    reasons: ["Risk review: auth path"],
  });
  assert.equal(readGate({}).blocked, true, "no verdict is treated as FAIL");
  assert.equal(isWithheld({ withheld: true }), true);
  assert.deepEqual(parseArgs(["--repo", "/tmp/x", "--budget", "3", "fix", "it"]), {
    repo: "/tmp/x",
    base: "origin/develop",
    maxBudgetUsd: 3,
    maxTurns: 40,
    task: "fix it",
  });
});

test("the MCP client initializes first, parses tool JSON and surfaces errors", async () => {
  /** @type {any[]} */
  const sent = [];
  /** @type {(message: any) => void} */
  let deliver = () => {};
  const transport = {
    send: (/** @type {any} */ message) => {
      sent.push(message);
      if (message.id == null) return;
      const reply =
        message.method === "initialize"
          ? { result: { protocolVersion: "2025-06-18" } }
          : message.params.name === "broken"
            ? { result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }] } }
            : message.params.name === "missing"
              ? { error: { code: -32602, message: "Unknown tool" } }
              : { result: { content: [{ type: "text", text: JSON.stringify({ ok: true, tier: "mid" }) }] } };
      globalThis.queueMicrotask(() => deliver({ jsonrpc: "2.0", id: message.id, ...reply }));
    },
    onMessage: (/** @type {(message: any) => void} */ listener) => void (deliver = listener),
    close: () => {},
  };
  const client = createSolumbeClient(transport);
  assert.deepEqual(await client.modelRoute({ query: "q", path: repo }), { ok: true, tier: "mid" });
  assert.deepEqual(
    sent.map((m) => m.method),
    ["initialize", "notifications/initialized", "tools/call"],
  );
  assert.deepEqual(sent[2].params, { name: "model_route", arguments: { query: "q", path: repo, host: "claude-code" } });
  await assert.rejects(client.call("broken", {}), /solumbe broken failed: boom/);
  await assert.rejects(client.call("missing", {}), /solumbe -32602: Unknown tool/);
});

test("the MCP client talks to solumbe's real server over in-process streams", async (t) => {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-agent-sdk-xdg-"));
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const server = startMcpServer({ input: toServer, output: fromServer });
  const client = createSolumbeClient(streamTransport(fromServer, toServer));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const route = await client.call("model_route", { query: "fix a typo in the README", path: root, host: "claude-code", offline: true });
  client.close();
  await server;
  assert.equal(route.ok, true);
  assert.ok(["cheap", "mid", "premium"].includes(route.tier));
  assert.equal(typeof modelForRoute(route).model, "string");
});
