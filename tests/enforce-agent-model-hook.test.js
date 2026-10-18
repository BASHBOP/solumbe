import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_TOOLS, agentCallRecord, agentModelLogPath, enforcement, findDecision, modelMatches } from "../scripts/hooks/enforce-agent-model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "scripts", "hooks", "enforce-agent-model.mjs");
const REPO = path.resolve(HERE, "..");

/** A decision line the way route-prompt.mjs writes one. */
function decision(overrides = {}) {
  return {
    v: 1,
    ts: "2026-10-18T08:00:00.000Z",
    sessionId: "sess-1",
    promptId: "prompt-1",
    promptHash: "abcd1234abcd1234",
    tier: "cheap",
    evidenceSufficient: true,
    mode: "delegate",
    arm: "delegate",
    ...overrides,
  };
}

/** A PreToolUse input the way Claude Code sends one for the Agent tool. */
function agentCall(toolInput = {}, overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "sess-1",
    prompt_id: "prompt-1",
    cwd: REPO,
    tool_name: "Agent",
    tool_use_id: "toolu_1",
    tool_input: { description: "fix it", prompt: "Fix the thing", subagent_type: "general-purpose", ...toolInput },
    ...overrides,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enforce-agent-model-"));
}

/** @param {unknown} input @param {Record<string, string>} env */
function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SOLUMBE_HOOK_CLAIMS_DIR: tempDir(), ...env },
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (c) => (out += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

test("the hook covers the Agent tool under its current and earlier name", () => {
  assert.deepEqual([...AGENT_TOOLS].sort(), ["Agent", "Task"]);
});

test("a full model id names its family; missing and inherit are not a tier", () => {
  assert.equal(modelMatches("haiku", "haiku"), true);
  assert.equal(modelMatches("claude-sonnet-5", "sonnet"), true);
  assert.equal(modelMatches("opus", "sonnet"), false);
  assert.equal(modelMatches(undefined, "sonnet"), false);
  assert.equal(modelMatches("", "sonnet"), false);
  assert.equal(modelMatches("inherit", "sonnet"), false);
});

test("the delegate arm rewrites a missing model to the routed one and keeps every other field", () => {
  const input = agentCall();
  const result = enforcement(input, decision());
  assert.equal(result?.action, "rewrote");
  const out = result?.output?.hookSpecificOutput;
  assert.equal(out.hookEventName, "PreToolUse");
  // `updatedInput` replaces the whole input, so it must carry what it kept.
  assert.deepEqual(out.updatedInput, { ...input.tool_input, model: "haiku" });
  assert.equal(out.permissionDecision, "allow");
  assert.match(out.additionalContext, /asked for no model and was launched with model `haiku`/);
  assert.doesNotMatch(out.additionalContext, /session's model was changed|switched/);
});

test("the delegate arm rewrites a model that names another tier", () => {
  const result = enforcement(agentCall({ model: "opus" }), decision({ tier: "mid" }));
  assert.equal(result?.action, "rewrote");
  assert.equal(result?.output?.hookSpecificOutput.updatedInput.model, "sonnet");
  assert.equal(result?.requested, "opus");
  assert.match(result?.output?.hookSpecificOutput.additionalContext, /asked for `opus`/);
});

test("a call already on the routed tier is left alone, in every arm", () => {
  for (const arm of ["delegate", "control", "advisory"]) {
    const result = enforcement(agentCall({ model: "haiku" }), decision({ arm }));
    assert.equal(result?.action, "matched");
    assert.equal(result?.output, null);
  }
});

test("the control and advisory arms observe a divergent call and never change it", () => {
  for (const arm of ["control", "advisory"]) {
    const result = enforcement(agentCall({ model: "opus" }), decision({ arm }));
    assert.equal(result?.action, "diverged");
    assert.equal(result?.arm, arm);
    assert.equal(result?.output, null);
  }
  // A decision logged before the trial has no arm and is advisory.
  const { arm: _arm, ...legacy } = decision();
  assert.equal(enforcement(agentCall(), legacy)?.action, "diverged");
});

test("nothing is enforced without evidence, a decision, a tier, or outside the Agent tool", () => {
  // A route with no evidence names only the fail-safe tier.
  assert.equal(enforcement(agentCall(), decision({ evidenceSufficient: false })), null);
  // A decision logged before the field existed is not known to have evidence.
  const { evidenceSufficient: _e, ...old } = decision();
  assert.equal(enforcement(agentCall(), old), null);
  assert.equal(enforcement(agentCall(), null), null);
  assert.equal(enforcement(agentCall(), decision({ tier: null })), null);
  assert.equal(enforcement(agentCall({}, { tool_name: "Bash" }), decision()), null);
  assert.equal(enforcement(agentCall({}, { hook_event_name: "PostToolUse" }), decision()), null);
  assert.equal(enforcement(null, decision()), null);
});

test("inside a subagent the hook does nothing: its caller already chose", () => {
  assert.equal(enforcement(agentCall({}, { agent_id: "agent_1" }), decision()), null);
});

test("the decision is the prompt's own when the host sends its id, else the session's latest", () => {
  const dir = tempDir();
  const log = path.join(dir, "route-decisions.jsonl");
  const lines = [
    decision({ promptId: "prompt-1", tier: "premium" }),
    decision({ sessionId: "sess-2", promptId: "prompt-9", tier: "mid" }),
    decision({ promptId: "prompt-2", tier: "cheap" }),
  ];
  fs.writeFileSync(log, `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
  assert.equal(findDecision(log, { sessionId: "sess-1", promptId: "prompt-1" })?.tier, "premium");
  // An unrouted prompt (`go ahead`) continues the request routed before it.
  assert.equal(findDecision(log, { sessionId: "sess-1", promptId: "prompt-3" })?.tier, "cheap");
  assert.equal(findDecision(log, { sessionId: "sess-1" })?.tier, "cheap");
  assert.equal(findDecision(log, { sessionId: "sess-2" })?.tier, "mid");
  assert.equal(findDecision(log, { sessionId: "sess-3" }), null);
  assert.equal(findDecision(log, {}), null);
  assert.equal(findDecision(null, { sessionId: "sess-1" }), null);
  assert.equal(findDecision(path.join(dir, "missing.jsonl"), { sessionId: "sess-1" }), null);
});

test("the agent-model log is on by default, movable, and off when asked", () => {
  assert.match(String(agentModelLogPath({})), /\.solumbe[/\\]agent-model-decisions\.jsonl$/);
  assert.equal(agentModelLogPath({ SOLUMBE_AGENT_MODEL_LOG: "/tmp/a.jsonl" }), path.resolve("/tmp/a.jsonl"));
  assert.equal(agentModelLogPath({ SOLUMBE_AGENT_MODEL_LOG: "off" }), null);
});

test("a call record joins its routing decision on the session and the prompt hash", () => {
  const d = decision();
  const result = enforcement(agentCall({ model: "opus" }), d);
  assert.ok(result);
  const record = agentCallRecord(agentCall({ model: "opus" }), d, result);
  assert.equal(record.v, 1);
  assert.equal(record.sessionId, "sess-1");
  assert.equal(record.promptHash, d.promptHash);
  assert.equal(record.toolUseId, "toolu_1");
  assert.equal(record.arm, "delegate");
  assert.equal(record.routed, "haiku");
  assert.equal(record.requested, "opus");
  assert.equal(record.action, "rewrote");
  // It never holds the prompt or the subagent's brief.
  assert.doesNotMatch(JSON.stringify(record), /Fix the thing/);
});

test("run as a hook: the delegate arm rewrites the call and logs it once", async () => {
  const dir = tempDir();
  const routeLog = path.join(dir, "route-decisions.jsonl");
  const agentLog = path.join(dir, "agent-model-decisions.jsonl");
  fs.writeFileSync(routeLog, `${JSON.stringify(decision({ tier: "mid" }))}\n`);
  const claims = tempDir();
  const env = { SOLUMBE_ROUTE_LOG: routeLog, SOLUMBE_AGENT_MODEL_LOG: agentLog, SOLUMBE_HOOK_CLAIMS_DIR: claims };
  const first = await runHook(agentCall({ model: "haiku" }), env);
  assert.equal(first.code, 0);
  const out = JSON.parse(first.out);
  assert.equal(out.hookSpecificOutput.updatedInput.model, "sonnet");
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, "Fix the thing");
  // The same call reaching a second registration of the hook stands down.
  const second = await runHook(agentCall({ model: "haiku" }), env);
  assert.equal(second.code, 0);
  assert.equal(second.out, "");
  const logged = fs.readFileSync(agentLog, "utf8").trim().split("\n");
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).action, "rewrote");
});

test("run as a hook: the control arm leaves the call as made and logs what it saw", async () => {
  const dir = tempDir();
  const routeLog = path.join(dir, "route-decisions.jsonl");
  const agentLog = path.join(dir, "agent-model-decisions.jsonl");
  fs.writeFileSync(routeLog, `${JSON.stringify(decision({ arm: "control" }))}\n`);
  const { code, out } = await runHook(agentCall({ model: "opus" }), { SOLUMBE_ROUTE_LOG: routeLog, SOLUMBE_AGENT_MODEL_LOG: agentLog });
  assert.equal(code, 0);
  assert.equal(out, "");
  assert.equal(JSON.parse(fs.readFileSync(agentLog, "utf8")).action, "diverged");
});

test("run as a hook: bad stdin, no log and no decision all exit 0 and leave the call alone", async () => {
  const dir = tempDir();
  for (const [input, env] of [
    ["this is not json", {}],
    [agentCall(), { SOLUMBE_ROUTE_LOG: "off" }],
    [agentCall(), { SOLUMBE_ROUTE_LOG: path.join(dir, "missing.jsonl") }],
  ]) {
    const { code, out } = await runHook(input, { SOLUMBE_AGENT_MODEL_LOG: "off", ...env });
    assert.equal(code, 0);
    assert.equal(out, "");
  }
});

test("the project settings register both repo hooks by repo-relative path only", () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
  // Personal settings stay in ~/.claude: nothing here but the hooks.
  assert.deepEqual(Object.keys(settings).sort(), ["$schema", "hooks"]);
  const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
  for (const command of commands) {
    assert.match(command, /^node "\$CLAUDE_PROJECT_DIR\/scripts\/hooks\/[a-z-]+\.mjs"$/, command);
    const script = command.match(/\/(scripts\/hooks\/[a-z-]+\.mjs)/)?.[1];
    assert.ok(script && fs.existsSync(path.join(REPO, script)), `${script} exists`);
  }
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /route-prompt\.mjs/);
  const pre = settings.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, "Agent|Task");
  assert.match(pre[0].hooks[0].command, /enforce-agent-model\.mjs/);
  assert.doesNotMatch(JSON.stringify(settings), /\/Users\/|permissions|~\//);
});
