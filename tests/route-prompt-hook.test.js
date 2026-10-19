import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_MODEL,
  appendDecision,
  claimOnce,
  promptClaimKey,
  ROUTE_TIMEOUT_MS,
  routeTimeoutMs,
  GIT_TIMEOUT_MS,
  gitTimeoutMs,
  gitStateAt,
  decisionRecord,
  formatContext,
  routeArm,
  isHarnessPrompt,
  isRoutable,
  routeLogPath,
  shouldRoute,
} from "../scripts/hooks/route-prompt.mjs";

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hooks", "route-prompt.mjs");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// What the harness submits through UserPromptSubmit on its own, in the shapes
// the transcripts hold.
const TASK_NOTIFICATION = [
  "<task-notification>",
  "<task-id>bg1f88yix</task-id>",
  "<tool-use-id>toolu_01</tool-use-id>",
  "<output-file>/private/tmp/claude-501/tasks/bg1f88yix.output</output-file>",
  "<status>completed</status>",
  '<summary>Background command "yarn test 2&gt;&amp;1 | tail -15" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");
const CI_MONITOR_EVENT = '<ci-monitor-event>"Auto-fix pull requests" was just enabled for this session. No action needed right now.</ci-monitor-event>';
const SHELL_RECORD = "<bash-input>git push origin v3.2.0</bash-input><bash-stdout>Everything up-to-date</bash-stdout><bash-stderr></bash-stderr>";
const REMINDER = "<system-reminder>\nYou are operating in a git worktree.\nWorktree name: frosty-lederberg-90e4d2\n</system-reminder>";

/**
 * Run the hook as the harness runs it: JSON on stdin, JSON or nothing on
 * stdout. Returns the exit code and the raw stdout.
 * @param {unknown} input
 */
function runHook(input, { timeout = 90000, env: extra = {} } = {}) {
  return new Promise((resolve) => {
    // No vendor key reaches the hook: a test must not make a billed call
    // because of what the developer's shell exports. And no test writes the
    // developer's real decision log.
    const { TYPESAFE_API_KEY: _key, ...env } = process.env;
    const child = spawn(process.execPath, [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...env,
        SOLUMBE_ROUTE_LOG: "off",
        // Each run claims its prompt in a directory of its own, so two tests
        // that send the same prompt never stand each other down.
        SOLUMBE_HOOK_CLAIMS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "route-claims-")),
        // The 6 s budget is for a prompt; a suite that spawns node in parallel
        // has run past it, and these tests check the output, not the deadline.
        SOLUMBE_ROUTE_TIMEOUT_MS: "60000",
        // Likewise the 1.5 s git read: under load `git rev-parse` has run past
        // it, and the decision log test checks the head was kept.
        SOLUMBE_ROUTE_GIT_TIMEOUT_MS: "60000",
        ...extra,
      },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

test("turn-taking prompts are not worth a routing call", () => {
  for (const prompt of ["ok", "OK.", "yes", "thanks", "sure", "go ahead", "continue", "ship it", "lgtm", "nvm", "hi", "?"]) {
    assert.equal(isRoutable(prompt), false, `${JSON.stringify(prompt)} should be skipped`);
  }
});

test("anything that could be work is routed, because a miss costs less than a false skip", () => {
  for (const prompt of [
    "fix the auth bug",
    "add a --quiet flag to the doctor command",
    "why is the gate failing on main?",
    "rename running to score",
    // Short, but three words of intent rather than an acknowledgement.
    "fix the typo",
  ]) {
    assert.equal(isRoutable(prompt), true, `${JSON.stringify(prompt)} should route`);
  }
});

test("a slash command belongs to its own skill, not to the router", () => {
  assert.equal(isRoutable("/code-review high"), false);
  assert.equal(isRoutable("/loop check the deploy"), false);
});

test("what the harness submits on its own is not a request, so it routes nothing", () => {
  for (const prompt of [TASK_NOTIFICATION, CI_MONITOR_EVENT, SHELL_RECORD, `\n  ${TASK_NOTIFICATION}\n`, `${REMINDER}\n\n${TASK_NOTIFICATION}`]) {
    assert.equal(isHarnessPrompt(prompt), true, `${JSON.stringify(prompt.slice(0, 40))} is the harness's`);
    assert.equal(isRoutable(prompt), false, `${JSON.stringify(prompt.slice(0, 40))} should be skipped`);
  }
  assert.equal(shouldRoute({ hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt: TASK_NOTIFICATION }), false);
});

test("a reminder in front of a prompt is looked past, not taken as the prompt", () => {
  // Every logged prompt that opened with a reminder had a request behind it.
  const request = `${REMINDER}\n\nIn the solumbe repo, the local gate gives a wrong repair hint`;
  assert.equal(isRoutable(request), true);
  assert.equal(isHarnessPrompt(request), false);
  assert.equal(isRoutable(`${REMINDER}\n${REMINDER}\n\nopen prs if needed let me know when to merge`), true, "two reminders, one request");
  // Behind the reminder the usual rules apply.
  assert.equal(isRoutable(`${REMINDER}\n\nyes`), false);
  assert.equal(isRoutable(`${REMINDER}\n\n/code-review high`), false);
  assert.equal(isRoutable(REMINDER), false, "a reminder with nothing behind it is not a prompt");
  // An unclosed reminder is not one the harness wrote, so it routes.
  assert.equal(isRoutable("<system-reminder> is showing up in my transcripts, why?"), true);
});

test("a wrapper that carries a request still routes", () => {
  for (const prompt of [
    '\n\n<pasted_content id="f8cb">\nthe review said the gate ignores --path\n</pasted_content id="f8cb">\n',
    "<create-pr-command>\n## Overview\n\nCreate a pull request for the changes in this session.\n</create-pr-command>",
    '<cross-session-message from="local_63035a58" name="Setup">\nThe plan was amended. Re-read it before Phase 1.\n</cross-session-message>',
    // Naming a wrapper is not being one.
    "why does <task-notification> reach the route hook?",
    "<task-notifications> are noisy, filter them in the grader",
  ]) {
    assert.equal(isRoutable(prompt), true, `${JSON.stringify(prompt.slice(0, 40))} should route`);
    assert.equal(isHarnessPrompt(prompt), false);
  }
});

test("a subagent never routes, so a routed agent cannot launch another", () => {
  const base = { hook_event_name: "UserPromptSubmit", cwd: "/repo", prompt: "add a retry to the token refresh" };
  assert.equal(shouldRoute(base), true);
  assert.equal(shouldRoute({ ...base, agent_id: "agent_1" }), false);
});

test("a hook invocation without the fields it needs routes nothing", () => {
  assert.equal(shouldRoute(null), false);
  assert.equal(shouldRoute({}), false);
  assert.equal(shouldRoute({ hook_event_name: "PreToolUse", cwd: "/repo", prompt: "real work here" }), false);
  // No cwd means nothing to score the request against.
  assert.equal(shouldRoute({ hook_event_name: "UserPromptSubmit", prompt: "real work here" }), false);
});

test("the context names the subagent model but never claims a switch", () => {
  const context = formatContext({
    tier: "cheap",
    hostModel: "claude-haiku-4-5-20251001",
    scoring: { route: 88 },
    signals: { ax: 83 },
  });
  assert.match(context, /tier \*\*cheap\*\*/);
  assert.match(context, /claude-haiku-4-5-20251001/);
  assert.match(context, /route 88/);
  assert.match(context, /AX 83/);
  // The anti-pattern the skill names: claiming the host switched models when
  // it only recommended a tier.
  assert.match(context, /cannot change the model this session runs on/);
  assert.match(context, /Do not say the model was changed/);
  // And it must not manufacture delegation that was not already happening.
  assert.match(context, /Do not spawn a subagent you would not otherwise have used/);
});

test("an accepted request read rides along; an unsure one stays out", () => {
  const read = {
    intent: { choice: "fix", confidence: 0.93, accepted: true },
    capability: { choice: "change_impact", confidence: 0.61, accepted: true },
    relevance: [],
  };
  const context = formatContext({ tier: "mid", scoring: { route: 60 }, model: { read } });
  assert.match(context, /Request read \(TypeSafe Jev, advisory\): intent \*\*fix\*\* \(0\.93\), solumbe tool \*\*change_impact\*\* \(0\.61\)\./);

  const unsure = formatContext({
    tier: "mid",
    model: { read: { ...read, intent: { ...read.intent, accepted: false }, capability: { choice: "none", confidence: 0.9, accepted: true } } },
  });
  assert.doesNotMatch(unsure, /Request read/, "under the floor, or no tool, says nothing");
  assert.doesNotMatch(formatContext({ tier: "mid", model: { read: null } }), /Request read/);
});

test("a route with no host model still renders, without inventing a model id", () => {
  const context = formatContext({ tier: "mid", scoring: { route: 60 } });
  assert.match(context, /tier \*\*mid\*\*/);
  assert.doesNotMatch(context, /claude-/);
  assert.doesNotMatch(context, /subagent/);
});

test("malformed stdin exits 0 and emits nothing, because a router must not eat a prompt", async () => {
  const { code, out } = await runHook("this is not json");
  assert.equal(code, 0);
  assert.equal(out, "");
});

test("a skipped prompt exits 0 and emits nothing", async () => {
  const { code, out } = await runHook({ hook_event_name: "UserPromptSubmit", cwd: REPO, prompt: "ok" });
  assert.equal(code, 0);
  assert.equal(out, "");
});

test("a real request produces the documented hook output shape", async () => {
  const { code, out } = await runHook({
    hook_event_name: "UserPromptSubmit",
    cwd: REPO,
    prompt: "rename the variable running to score in model-route.js",
  });
  assert.equal(code, 0);
  assert.notEqual(out, "", "a routable request in a real repo should produce context");

  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.match(context, /solumbe routed this request/);
  // The host map is real, so the model id must be one of the three it holds.
  assert.match(context, /claude-(haiku-4-5-20251001|sonnet-5|opus-5)/);
});

test("the decision record keeps what a rescore reads and never the prompt", () => {
  const route = {
    tier: "mid",
    hostModel: "claude-sonnet-5",
    scoring: { route: 61, baseTier: "mid" },
    deterministic: { tier: "cheap", route: 80 },
    repo: { name: "solumbe", root: "/repo" },
    signals: { ax: 72, containment: 55, candidates: 4, riskPaths: ["configuration"], evidence: [{ path: "src/a.js" }] },
    model: { source: "offline", model: "offline-heuristic", answers: { specificity: { score: 0.6 }, blast_radius: { score: 0.4 }, novelty: { noul: 0.1 } } },
    modelRouteEngineVersion: "0.1.0",
  };
  const prompt = "rename running to score in model-route.js";
  const record = decisionRecord({ session_id: "s-1", cwd: "/repo", prompt }, route, { head: "abc123", branch: "develop" });
  assert.equal(record.v, 1);
  assert.equal(record.sessionId, "s-1");
  assert.equal(record.promptHash, crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16));
  assert.equal(record.promptChars, prompt.length);
  assert.deepEqual(record.tiers, { deterministic: "cheap", offline: "mid" });
  assert.deepEqual(record.routes, { deterministic: 80, offline: 61 });
  assert.deepEqual(record.signals, { ax: 72, containment: 55, candidates: 4, riskPaths: ["configuration"] });
  assert.deepEqual(record.answers, route.model.answers);
  assert.equal(record.head, "abc123");
  assert.equal(record.hostModel, "claude-sonnet-5");
  assert.doesNotMatch(JSON.stringify(record), /rename running/);
  // A Jev-scored route files its tier under the model variant.
  const jev = decisionRecord({ prompt }, { ...route, model: { ...route.model, source: "jev", model: "jev-1.13.0" } });
  assert.deepEqual(jev.tiers, { deterministic: "cheap", jev: "mid" });
});

test("the decision log is on by default, movable, and off when asked", () => {
  assert.match(routeLogPath({}), /\.solumbe[\\/]route-decisions\.jsonl$/);
  assert.equal(routeLogPath({ SOLUMBE_ROUTE_LOG: "off" }), null);
  assert.equal(routeLogPath({ SOLUMBE_ROUTE_LOG: "0" }), null);
  assert.equal(routeLogPath({ SOLUMBE_ROUTE_LOG: "/tmp/x.jsonl" }), path.resolve("/tmp/x.jsonl"));
  assert.equal(appendDecision({ v: 1 }, null), false, "off keeps nothing and says so");
});

test("a routed prompt leaves one line in the decision log, and a skipped one leaves none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-log-"));
  const log = path.join(dir, "nested", "route-decisions.jsonl");
  const prompt = "rename the variable running to score in model-route.js";
  const { code } = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-42", cwd: REPO, prompt }, { env: { SOLUMBE_ROUTE_LOG: log } });
  assert.equal(code, 0);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.sessionId, "sess-42");
  assert.equal(record.promptHash, crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16));
  assert.ok(["cheap", "mid", "premium"].includes(record.tier));
  assert.ok(["cheap", "mid", "premium"].includes(record.tiers.deterministic));
  assert.equal(typeof record.signals.ax, "number");
  assert.ok(record.answers?.specificity, "the answers ride along for a rescore");
  assert.match(record.head ?? "", /^[0-9a-f]{12}$/, "the head at prompt time is kept");
  assert.doesNotMatch(lines[0], /rename the variable/);

  await runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-42", cwd: REPO, prompt: "ok" }, { env: { SOLUMBE_ROUTE_LOG: log } });
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "a skipped prompt is not a decision");

  // The harness delivers a finished background task through the same event.
  for (const prompt of [TASK_NOTIFICATION, CI_MONITOR_EVENT, SHELL_RECORD]) {
    const harness = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess-42", cwd: REPO, prompt }, { env: { SOLUMBE_ROUTE_LOG: log } });
    assert.equal(harness.code, 0);
    assert.equal(harness.out, "", "no routing hint is injected for a prompt nobody wrote");
  }
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "a harness prompt is not a decision");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a route with no evidence says no recommendation instead of routing", () => {
  const context = formatContext({
    tier: "premium",
    hostModel: "claude-opus-5-5",
    scoring: { route: 85, evidence: { sufficient: false } },
    signals: { ax: 84 },
  });
  assert.match(context, /no recommendation/);
  assert.match(context, /Fail-safe tier: \*\*premium\*\* \(claude-opus-5-5\)/);
  assert.doesNotMatch(context, /solumbe routed this request/);
  assert.doesNotMatch(context, /launch it on/);
  assert.match(context, /Do not say the model was changed/);
});

test("enforce mode is off unless asked for, and splits requests into two stable arms", () => {
  assert.deepEqual(routeArm("fix the login bug", {}), { mode: "advisory", arm: "advisory", share: null });
  const env = { SOLUMBE_ROUTE_MODE: "delegate" };
  const arms = Array.from({ length: 400 }, (_, i) => routeArm(`request ${i}`, env).arm);
  const delegated = arms.filter((a) => a === "delegate").length;
  assert.ok(delegated > 150 && delegated < 250, `about half delegate, got ${delegated}`);
  assert.ok(arms.every((a) => a === "delegate" || a === "control"));
  assert.equal(routeArm("same prompt", env).arm, routeArm("same prompt", env).arm);
  assert.equal(routeArm("x", { ...env, SOLUMBE_ROUTE_DELEGATE_SHARE: "1" }).arm, "delegate");
  assert.equal(routeArm("x", { ...env, SOLUMBE_ROUTE_DELEGATE_SHARE: "0" }).arm, "control");
});

test("the delegate arm hands the work to a subagent on the routed tier, and never claims a switch", () => {
  const route = { tier: "cheap", hostModel: "claude-haiku-4-5-20251001", scoring: { route: 80 } };
  const context = formatContext(route, { arm: "delegate" });
  assert.match(context, /subagent launched with model `haiku`/);
  assert.match(context, /Do not say the session's model was changed/);
  assert.doesNotMatch(context, /Do not spawn a subagent you would not otherwise have used/);
  assert.equal(AGENT_MODEL.premium, "opus");
  // The control arm reads exactly like advisory.
  assert.equal(formatContext(route, { arm: "control" }), formatContext(route));
  // No evidence: nothing is enforced.
  assert.doesNotMatch(formatContext({ ...route, scoring: { evidence: { sufficient: false } } }, { arm: "delegate" }), /subagent launched/);
});

test("a decision records its arm", () => {
  const record = decisionRecord({ prompt: "p" }, { tier: "mid" }, {}, { mode: "delegate", arm: "control", share: 0.5 });
  assert.equal(record.mode, "delegate");
  assert.equal(record.arm, "control");
  assert.equal(record.delegateShare, 0.5);
  assert.equal(decisionRecord({ prompt: "p" }, { tier: "mid" }).arm, "advisory");
});

test("solumbe route reports the enforce arm in the terminal and in JSON", () => {
  const CLI = path.join(REPO, "src", "cli.js");
  const { TYPESAFE_API_KEY: _key, ...env } = process.env;
  const run = (/** @type {string[]} */ args, /** @type {Record<string,string>} */ extra) =>
    spawnSync(process.execPath, [CLI, "route", REPO, "fix the route prompt hook arm", "--offline", ...args], { encoding: "utf8", env: { ...env, ...extra } });
  const off = JSON.parse(run(["--json"], {}).stdout);
  assert.equal(off.enforce, undefined);
  const on = JSON.parse(run(["--json"], { SOLUMBE_ROUTE_MODE: "delegate", SOLUMBE_ROUTE_DELEGATE_SHARE: "1" }).stdout);
  assert.equal(on.enforce.arm, "delegate");
  assert.equal(on.enforce.agentModel, AGENT_MODEL[on.tier]);
  assert.match(run([], { SOLUMBE_ROUTE_MODE: "delegate", SOLUMBE_ROUTE_DELEGATE_SHARE: "1", NO_COLOR: "1" }).stdout, /ENFORCE/);
});

test("the header does not claim the injected text binds the subagent on its own", () => {
  const source = fs.readFileSync(HOOK, "utf8");
  const header = source.slice(0, source.indexOf("import "));
  assert.doesNotMatch(header, /binds the subagent|real actuation/);
  assert.match(header, /enforce-agent-model\.mjs/);
  assert.match(header, /parent decides whether to pass `model`/);
});

test("the advisory line names the Agent tool's model alias beside the host model", () => {
  const context = formatContext({ tier: "mid", hostModel: "claude-sonnet-5", scoring: { route: 61 } });
  assert.match(context, /launch it on `claude-sonnet-5` \(Agent tool `model: "sonnet"`\)/);
});

test("a decision keeps the prompt id and whether the route had evidence, for the PreToolUse hook", () => {
  const record = decisionRecord({ session_id: "s", prompt_id: "p-1", prompt: "x" }, { tier: "mid", scoring: { evidence: { sufficient: true } } });
  assert.equal(record.promptId, "p-1");
  assert.equal(record.evidenceSufficient, true);
  assert.equal(decisionRecord({ prompt: "x" }, { tier: "premium", scoring: { evidence: { sufficient: false } } }).evidenceSufficient, false);
  assert.equal(decisionRecord({ prompt: "x" }, { tier: "mid" }).promptId, null);
});

test("a prompt is claimed once, so a hook registered twice routes it once", () => {
  const env = { SOLUMBE_HOOK_CLAIMS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "route-claims-")) };
  const now = Date.parse("2026-10-18T08:00:00Z");
  assert.equal(claimOnce("route:s:p", { env, now }), true);
  assert.equal(claimOnce("route:s:p", { env, now: now + 1000 }), false);
  assert.equal(claimOnce("route:s:other", { env, now }), true);
  // Typed again after the window, it is a new prompt.
  assert.equal(claimOnce("route:s:p", { env, now: now + 120000 }), true);
  assert.equal(claimOnce("route:s:p", { env, now: now + 121000 }), false);
  // A guard that cannot run lets the run go.
  assert.equal(claimOnce("k", { env: { SOLUMBE_HOOK_CLAIMS_DIR: "/dev/null/nope" } }), true);
  assert.equal(promptClaimKey({ session_id: "s", prompt_id: "p" }), "route:s:p");
  assert.match(String(promptClaimKey({ session_id: "s", prompt: "fix it" })), /^route:s:[0-9a-f]{16}$/);
  assert.equal(promptClaimKey({ prompt: "fix it" }), null);
});

test("the routing deadline is 6 s unless the environment sets a positive one", () => {
  assert.equal(ROUTE_TIMEOUT_MS, 6000);
  assert.equal(routeTimeoutMs({}), 6000);
  assert.equal(routeTimeoutMs({ SOLUMBE_ROUTE_TIMEOUT_MS: "60000" }), 60000);
  for (const bad of ["", "0", "-5", "soon"]) assert.equal(routeTimeoutMs({ SOLUMBE_ROUTE_TIMEOUT_MS: bad }), 6000);
});

test("the git read deadline is 1.5 s unless the environment sets a positive one", () => {
  assert.equal(GIT_TIMEOUT_MS, 1500);
  assert.equal(gitTimeoutMs({}), 1500);
  assert.equal(gitTimeoutMs({ SOLUMBE_ROUTE_GIT_TIMEOUT_MS: "60000" }), 60000);
  for (const bad of ["", "0", "-5", "soon"]) assert.equal(gitTimeoutMs({ SOLUMBE_ROUTE_GIT_TIMEOUT_MS: bad }), 1500);
});

test("the head at prompt time is read from git, and a directory with none keeps none", () => {
  const generous = { SOLUMBE_ROUTE_GIT_TIMEOUT_MS: "60000" };
  assert.match(gitStateAt(REPO, generous).head ?? "", /^[0-9a-f]{12}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-no-git-"));
  assert.deepEqual(gitStateAt(dir, generous), { head: null, branch: null });
  fs.rmSync(dir, { recursive: true, force: true });
});
