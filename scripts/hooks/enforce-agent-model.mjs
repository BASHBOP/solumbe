#!/usr/bin/env node
// A Claude Code `PreToolUse` hook on the Agent tool that holds a subagent to
// the tier route-prompt.mjs routed the prompt to.
//
// route-prompt.mjs can only put the routed model in the parent session's
// context. Whether the parent passes `model` to the Agent tool, and which one,
// is the parent's call, and nothing that hook prints can change it. This hook
// sits on the call itself: it reads the decision route-prompt logged for this
// session and prompt, and compares the tier with the `model` the call carries.
//
// Rewrite, not deny. When the call's `model` is missing or names another tier,
// the hook returns `updatedInput` with the routed model and the rest of the
// input unchanged. A deny would cost a full turn for the parent to read the
// reason and issue the same call again with one field changed, and a parent
// that ignored the advice once can ignore the reason too. The rewrite lands
// on the first try and the parent is told what happened through
// `additionalContext`, so it cannot report the subagent's model wrongly. The
// decision is `allow` because Claude Code applies `updatedInput` with `allow`
// or `ask`, and `ask` would put a prompt in front of every delegated call. An
// `allow` from a hook does not override the user's deny or ask rules, which
// the host still evaluates against the rewritten input.
//
// It enforces in the delegate arm only, the arm route-prompt recorded in the
// decision. The control arm and plain advisory mode are observed, never
// changed, so `route-outcomes` can compare the arm where the router binds the
// subagent with the arm where the parent was only told. Every Agent call that
// joins a decision leaves one line in `agent-model-decisions.jsonl` with its
// arm, the routed and the requested model, and what was done.
//
// It never enforces a tier the router had no evidence for (the fail-safe
// premium), never acts inside a subagent (its caller already chose), and,
// like route-prompt, it must never break a call: every failure path exits 0
// and writes nothing, which leaves the call as the parent made it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_MODEL } from "../../src/lib/route-arm.js";
import { claimOnce, routeLogPath } from "./route-prompt.mjs";

/** The subagent tool, under its current and its earlier name. */
export const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** How much of the decision log's tail is read. The decision is recent. */
const TAIL_BYTES = 512 * 1024;

/**
 * Where the hook keeps what it did. `SOLUMBE_AGENT_MODEL_LOG` names another
 * file; `off` keeps nothing.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function agentModelLogPath(env = process.env) {
  const raw = env.SOLUMBE_AGENT_MODEL_LOG;
  if (raw !== undefined && /^(off|0|false|none)$/i.test(raw.trim())) return null;
  return path.resolve(raw && raw.trim() ? raw.trim() : path.join(os.homedir(), ".solumbe", "agent-model-decisions.jsonl"));
}

/**
 * The routing decision this call belongs to: the one logged for this prompt
 * when the host sends a prompt id and the hook recorded it, else the latest
 * one in the session. A prompt the router skipped (`go ahead`, a task
 * notification) continues the request routed before it.
 * @param {string|null} logPath
 * @param {{ sessionId?: string, promptId?: string }} keys
 * @returns {Record<string, any>|null}
 */
export function findDecision(logPath, { sessionId, promptId }) {
  if (!logPath || !sessionId) return null;
  let text;
  try {
    const fd = fs.openSync(logPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      // A tail that starts mid-line drops the partial line.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let latest = null;
  for (const line of text.split("\n")) {
    if (!line.includes(sessionId)) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.v !== 1 || record.sessionId !== sessionId) continue;
    if (promptId && record.promptId === promptId) return record;
    latest = record;
  }
  return latest;
}

/**
 * Whether the model an Agent call asks for is the routed one. The tool takes
 * an alias, but a full id names its family (`claude-sonnet-5` is `sonnet`).
 * Missing and `inherit` are not a choice of tier.
 * @param {unknown} requested
 * @param {string} routed
 */
export function modelMatches(requested, routed) {
  if (typeof requested !== "string" || !requested.trim()) return false;
  return requested.trim().toLowerCase().includes(routed);
}

/**
 * What to do with one Agent call, given the decision it belongs to. Pure, so
 * it is tested without a hook run. Null when there is nothing to enforce or
 * record.
 * @param {{ tool_name?: string, tool_input?: Record<string, any>, agent_id?: string, hook_event_name?: string }} input
 * @param {Record<string, any>|null} decision
 * @returns {null | { action: "rewrote"|"matched"|"diverged", arm: string, tier: string, routed: string, requested: string|null, output: Record<string, any>|null }}
 */
export function enforcement(input, decision) {
  if (!input || typeof input !== "object") return null;
  if (input.hook_event_name && input.hook_event_name !== "PreToolUse") return null;
  if (!AGENT_TOOLS.has(String(input.tool_name ?? ""))) return null;
  // Inside a subagent the caller already chose; and a subagent's own tier is
  // not the parent's request.
  if (input.agent_id) return null;
  if (!decision || decision.evidenceSufficient !== true) return null;
  const tier = String(decision.tier ?? "");
  const routed = AGENT_MODEL[/** @type {keyof typeof AGENT_MODEL} */ (tier)];
  if (!routed) return null;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const requested = typeof toolInput.model === "string" ? toolInput.model : null;
  const arm = String(decision.arm ?? "advisory");
  if (modelMatches(requested, routed)) return { action: "matched", arm, tier, routed, requested, output: null };
  if (arm !== "delegate") return { action: "diverged", arm, tier, routed, requested, output: null };
  const was = requested ? `\`${requested}\`` : "no model";
  return {
    action: "rewrote",
    arm,
    tier,
    routed,
    requested,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: `solumbe routed this request to tier ${tier}; the subagent runs on ${routed}.`,
        updatedInput: { ...toolInput, model: routed },
        additionalContext: `solumbe enforce mode, delegate arm: this Agent call asked for ${was} and was launched with model \`${routed}\`, the routed tier (${tier}). Report the subagent's model as \`${routed}\`.`,
      },
    },
  };
}

/**
 * One line of the agent-model log. It joins to the routing decision on the
 * session and the prompt hash, which is how route-outcomes reads it.
 * @param {Record<string, any>} input
 * @param {Record<string, any>} decision
 * @param {NonNullable<ReturnType<typeof enforcement>>} result
 */
export function agentCallRecord(input, decision, result) {
  return {
    v: 1,
    ts: new Date().toISOString(),
    host: "claude-code",
    sessionId: input.session_id ?? null,
    promptId: input.prompt_id ?? decision.promptId ?? null,
    promptHash: decision.promptHash ?? null,
    toolUseId: input.tool_use_id ?? null,
    arm: result.arm,
    tier: result.tier,
    routed: result.routed,
    requested: result.requested,
    action: result.action,
  };
}

/** Read all of stdin, or "" if nothing arrives. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const decision = findDecision(routeLogPath(), { sessionId: input?.session_id, promptId: input?.prompt_id });
  const result = enforcement(input, decision);
  if (!result || !decision) return;

  // Registered twice, the second run stands down rather than log the call twice.
  if (input.tool_use_id && !claimOnce(`agent-model:${input.session_id}:${input.tool_use_id}`)) return;

  const logPath = agentModelLogPath();
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${JSON.stringify(agentCallRecord(input, decision, result))}\n`);
    } catch {
      // A record that cannot be written costs the record, never the call.
    }
  }
  if (result.output) process.stdout.write(JSON.stringify(result.output));
}

// Only run when invoked as the hook, so the tests can import the pure parts.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    // Silence is the contract: a failed hook leaves the call as it was made.
  });
}
