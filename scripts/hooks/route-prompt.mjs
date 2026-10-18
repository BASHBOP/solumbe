#!/usr/bin/env node
// A Claude Code `UserPromptSubmit` hook that routes a request before it is
// worked on, so the tier is decided every time rather than whenever the model
// happens to remember the skill.
//
// What this can and cannot do, because the difference is the whole design:
//
//   - It CANNOT change the model this session runs on. No hook can. The docs
//     are explicit: `PreModelSwitch` may block a switch and `PostModelSwitch`
//     is read-only, and no hook output carries a model. A session cannot even
//     re-price itself through the app's own tooling.
//   - It CAN make the tier arrive as context, every time, before any work.
//   - It CAN name the model a SUBAGENT should be launched on. That is advice
//     and nothing more: the text lands in the parent session's context, and
//     the parent decides whether to pass `model` to the Agent tool at all.
//     Nothing in this file can see, let alone change, that call.
//
// The binding lives in the sibling `PreToolUse` hook, enforce-agent-model.mjs.
// It reads the decision this hook logged for the prompt and, in the delegate
// arm, rewrites an Agent call whose `model` is missing or differs. Without that
// hook registered, the routed subagent model is a recommendation the parent may
// ignore.
//
// With `SOLUMBE_ROUTE_MODE=delegate` a share of requests (the delegate arm) are
// told to hand the work itself to a subagent on the routed tier, which is the
// only model switch a session is allowed to make, and the PreToolUse hook
// enforces the model on that arm only. The rest stay advisory as the control,
// and every decision records its arm so `route-outcomes` can grade following
// the router against not following it.
//
// It never claims the session was switched, which is the anti-pattern the
// model-router skill calls out by name. It also keeps what it decided, one line
// per routed prompt in a local log, because a tier printed as context is gone
// when the turn ends, a router can only ever be graded against decisions that
// were kept, and the PreToolUse hook has nothing else to read the tier from.
//
// It must never break a prompt. Every failure path is silent and exits 0: a
// router that can swallow a user's request is worse than no router.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_MODEL, routeArm } from "../../src/lib/route-arm.js";

export { AGENT_MODEL, routeArm };

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This checkout's CLI, so the hook works whatever directory it routes. */
const CLI = path.resolve(HERE, "..", "..", "src", "cli.js");

/** Hard ceiling on the routing call. A slow repo must not stall a prompt. */
export const ROUTE_TIMEOUT_MS = 6000;

/**
 * The ceiling for this run. `SOLUMBE_ROUTE_TIMEOUT_MS` raises or lowers it,
 * which the tests use on a loaded machine where spawning node alone has taken
 * longer than the default; anything that is not a positive number is ignored.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function routeTimeoutMs(env = process.env) {
  const raw = Number(env.SOLUMBE_ROUTE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ROUTE_TIMEOUT_MS;
}

/** A `git rev-parse` that takes longer than this is not worth the head. */
const GIT_TIMEOUT_MS = 1500;

/**
 * Where the hook keeps what it decided. The tier printed as context is gone
 * when the turn ends; this file is the only record that a request was routed
 * and how, which is what any later grading of the router has to join to. It
 * never leaves the machine and never holds the prompt, only its hash.
 * `SOLUMBE_ROUTE_LOG` names another file; `off` keeps nothing.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function routeLogPath(env = process.env) {
  const raw = env.SOLUMBE_ROUTE_LOG;
  if (raw !== undefined && /^(off|0|false|none)$/i.test(raw.trim())) return null;
  return path.resolve(raw && raw.trim() ? raw.trim() : path.join(os.homedir(), ".solumbe", "route-decisions.jsonl"));
}

/**
 * The head and branch at prompt time, best effort. The head is what a later
 * commit join keys on: the request's change is the next commit on this branch
 * whose first parent is this head.
 * @param {string} cwd
 * @returns {{ head: string|null, branch: string|null }}
 */
export function gitStateAt(cwd) {
  const read = (/** @type {string[]} */ args) => {
    try {
      const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
      const out = result.status === 0 ? result.stdout.trim() : "";
      return out || null;
    } catch {
      return null;
    }
  };
  return { head: read(["rev-parse", "--short=12", "HEAD"]), branch: read(["symbolic-ref", "--short", "-q", "HEAD"]) };
}

/**
 * One line of the decision log: everything `solumbe regret --rescore` reads to
 * re-tier a request (signals and the answers exactly as scored), the tier each
 * half gave, the session it belongs to, and where the repository was. Pure,
 * so it can be tested without a hook run.
 * @param {{ session_id?: string, prompt_id?: string, cwd?: string, prompt?: string }} input
 * @param {any} route the `solumbe route --json` payload
 * @param {{ head?: string|null, branch?: string|null }} [git]
 */
export function decisionRecord(input, route, git = {}, arm = { mode: "advisory", arm: "advisory", share: null }) {
  const prompt = String(input.prompt ?? "");
  const source = route?.model?.source === "jev" ? "jev" : "offline";
  const tiers = { deterministic: route?.deterministic?.tier ?? null, [source]: route?.tier ?? null };
  const routes = { deterministic: route?.deterministic?.route ?? null, [source]: route?.scoring?.route ?? null };
  const signals = route?.signals ?? {};
  return {
    v: 1,
    ts: new Date().toISOString(),
    host: "claude-code",
    sessionId: input.session_id ?? null,
    promptId: input.prompt_id ?? null,
    repo: route?.repo?.name ?? null,
    root: route?.repo?.root ?? input.cwd ?? null,
    branch: git.branch ?? null,
    head: git.head ?? null,
    promptHash: crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 16),
    promptChars: prompt.length,
    tier: route?.tier ?? null,
    // A route with no evidence names only a fail-safe tier, which the
    // PreToolUse hook must never enforce.
    evidenceSufficient: route?.scoring?.evidence?.sufficient !== false,
    mode: arm.mode,
    arm: arm.arm,
    delegateShare: arm.share,
    hostModel: route?.hostModel ?? null,
    tiers,
    routes,
    signals: {
      ax: signals.ax ?? null,
      containment: signals.containment ?? null,
      candidates: signals.candidates ?? null,
      riskPaths: signals.riskPaths ?? [],
    },
    model: { source, name: route?.model?.model ?? null, fallbackReason: route?.model?.fallbackReason ?? null },
    answers: route?.model?.answers ?? null,
    modelRouteEngineVersion: route?.modelRouteEngineVersion ?? null,
  };
}

/**
 * Append one record. Best effort: a log that cannot be written costs the
 * record, never the prompt.
 * @param {Record<string, any>} record
 * @param {string|null} logPath
 * @returns {boolean}
 */
export function appendDecision(record, logPath) {
  if (!logPath) return false;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this run is the first to handle `key` inside `ttlMs`. The same hook
 * can be registered twice, in `~/.claude/settings.json` and in a repository's
 * `.claude/settings.json`, under commands that differ only in how they name
 * the script, so the host runs both. The first run to create the claim file
 * does the work and any other exits quietly, so a prompt is routed and logged
 * once. A guard that cannot run never costs the prompt: it lets the run go.
 * `SOLUMBE_HOOK_CLAIMS_DIR` moves the claims.
 * @param {string} key
 * @param {{ env?: NodeJS.ProcessEnv, ttlMs?: number, now?: number }} [options]
 * @returns {boolean}
 */
export function claimOnce(key, { env = process.env, ttlMs = 60000, now = Date.now() } = {}) {
  const dir = env.SOLUMBE_HOOK_CLAIMS_DIR?.trim() || path.join(os.tmpdir(), "solumbe-hook-claims");
  const file = path.join(dir, crypto.createHash("sha256").update(key).digest("hex").slice(0, 32));
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(file, String(now), { flag: "wx" });
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "EEXIST") return true;
      // An empty claim is one another run created and has not written yet.
      const raw = fs.readFileSync(file, "utf8").trim();
      if (!raw) return false;
      const claimedAt = Number(raw);
      if (Number.isFinite(claimedAt) && now - claimedAt < ttlMs) return false;
      // A claim older than the window is the same prompt typed again.
      fs.writeFileSync(file, String(now));
      return true;
    }
  } catch {
    return true;
  }
}

/**
 * The claim key for one prompt, or null when the input cannot tell two runs of
 * the same prompt from two prompts (no session), in which case nothing dedupes.
 * @param {{ session_id?: string, prompt_id?: string, prompt?: string }} input
 * @returns {string|null}
 */
export function promptClaimKey(input) {
  if (!input?.session_id) return null;
  const id =
    input.prompt_id ??
    crypto
      .createHash("sha256")
      .update(String(input.prompt ?? ""))
      .digest("hex")
      .slice(0, 16);
  return `route:${input.session_id}:${id}`;
}

/**
 * Prompts that are turn-taking rather than work. Routing these would spend
 * seconds of latency to score the word "ok".
 */
const CONVERSATIONAL =
  /^(y|n|ok(ay)?|yes|no|yep|yeah|nope|sure|thanks|thank you|ta|cheers|go|go on|go ahead|continue|carry on|keep going|do it|please|stop|wait|hold on|nvm|never mind|undo|same|agreed|sounds good|lgtm|ship it)\b[\s.!?]*$/i;

/**
 * What the harness submits through `UserPromptSubmit` on its own: a background
 * task finishing, the desktop app's CI monitor reporting, and the record of a
 * `!` shell command with its output. None of them is a request, and whatever
 * work follows belongs to one that was already routed.
 *
 * The list is what was measured, not what might exist. On 2026-09-27 each
 * wrapper was matched by prompt hash to decisions this hook had logged (75, 1
 * and 3 of 146), so each demonstrably reaches the hook. `<command-name>` and
 * `<local-command-stdout>` fill the transcripts and never reached it.
 * `<create-pr-command>`, `<cross-session-message>` and `<pasted_content>` did,
 * and still route, because each carries a request.
 */
const HARNESS_PROMPT = /^<(task-notification|ci-monitor-event|bash-input)[\s>]/;

/** A reminder the harness puts in front of what the user typed. */
const LEADING_REMINDER = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/;

/**
 * The prompt without the reminders the harness put in front of it. Every
 * logged prompt that opened with a reminder had a request behind it, so the
 * reminder is looked past, never taken as a reason to skip.
 * @param {string} prompt
 * @returns {string}
 */
function withoutReminders(prompt) {
  let text = String(prompt ?? "").trim();
  while (LEADING_REMINDER.test(text)) text = text.replace(LEADING_REMINDER, "");
  return text;
}

/**
 * Whether the harness wrote this prompt, rather than a person asking for
 * something. `route-outcomes` reads the same rule, so what the hook skips is
 * what the grader leaves out.
 * @param {string} prompt
 * @returns {boolean}
 */
export function isHarnessPrompt(prompt) {
  return HARNESS_PROMPT.test(withoutReminders(prompt));
}

/**
 * Whether a prompt is worth a routing call.
 *
 * Deliberately permissive: a request that is skipped costs nothing but a
 * missing hint, while a request that is routed costs seconds of latency. So
 * only clearly non-work prompts are filtered, and anything ambiguous routes.
 *
 * @param {string} prompt
 * @returns {boolean}
 */
export function isRoutable(prompt) {
  const trimmed = withoutReminders(prompt);
  if (!trimmed) return false;
  // The harness wrote it: there is no request to score.
  if (HARNESS_PROMPT.test(trimmed)) return false;
  // A slash command is handled by its own skill and is not a coding request.
  if (trimmed.startsWith("/")) return false;
  if (CONVERSATIONAL.test(trimmed)) return false;
  // Very short and not a sentence: "hi", "?", "again".
  if (trimmed.length < 12 && trimmed.split(/\s+/).length < 3) return false;
  return true;
}

/**
 * Whether this hook invocation should route at all.
 *
 * A subagent is skipped for two reasons: it was launched on a tier that was
 * already chosen for it, so re-routing would second-guess its own caller, and
 * a subagent that routes could launch a subagent, which is a loop nobody asked
 * for.
 *
 * @param {{hook_event_name?: string, prompt?: string, cwd?: string, agent_id?: string}} input
 * @returns {boolean}
 */
export function shouldRoute(input) {
  if (!input || typeof input !== "object") return false;
  if (input.hook_event_name && input.hook_event_name !== "UserPromptSubmit") return false;
  if (input.agent_id) return false;
  if (!input.cwd) return false;
  return isRoutable(input.prompt ?? "");
}

/**
 * The line a reader sees, and the instruction a model acts on.
 *
 * The wording is careful about two things. It says "recommends" rather than
 * "switched", because nothing here switched anything. And it asks for a
 * subagent only when delegating is already on the table, so a routed tier
 * cannot turn a one-line answer into a spawned agent.
 *
 * @param {{tier: string, hostModel?: string, scoring?: {route?: number, evidence?: {sufficient?: boolean}}, signals?: {ax?: number}, model?: {read?: any}}} route
 * @returns {string}
 */
export function formatContext(route, arm = { arm: "advisory" }) {
  const score = route?.scoring?.route;
  const ax = route?.signals?.ax;
  const detail = [score === undefined ? null : `route ${score}`, ax === undefined ? null : `AX ${ax}`].filter(Boolean).join(", ");

  // No evidence is the router's "Otherwise": say so rather than presenting a
  // read of an empty set as a tier. The fail-safe tier is still named.
  if (route?.scoring?.evidence?.sufficient === false) {
    return [
      `solumbe has no recommendation for this request: it matched no files, so the route would describe an empty set. Fail-safe tier: **${route.tier}**${route.hostModel ? ` (${route.hostModel})` : ""}.`,
      "",
      "This is a recommendation, not a switch: a hook cannot change the model this session runs on. Do not say the model was changed.",
    ].join("\n");
  }

  const lines = [
    `solumbe routed this request: tier **${route.tier}**${route.hostModel ? ` (${route.hostModel})` : ""}${detail ? ` — ${detail}` : ""}.`,
    "",
    "This is a recommendation, not a switch: a hook cannot change the model this session runs on, and this session cannot re-price its own turns. Do not say the model was changed.",
  ];

  // The request read rides the same route call. Only answers that cleared
  // their confidence floor are worth a line; an unsure one would be noise.
  const read = route?.model?.read;
  const readParts = [];
  if (read?.intent?.accepted) readParts.push(`intent **${read.intent.choice}** (${read.intent.confidence})`);
  if (read?.capability?.accepted && read.capability.choice !== "none") {
    readParts.push(`solumbe tool **${read.capability.choice}** (${read.capability.confidence})`);
  }
  if (readParts.length) lines.push("", `Request read (TypeSafe Jev, advisory): ${readParts.join(", ")}.`);

  // The delegate arm: the one real switch available. The session keeps the
  // conversation and the review; the routed tier does the work. Evidence-free
  // routes never reach here, so a fail-safe premium is never enforced.
  const agentModel = AGENT_MODEL[/** @type {keyof typeof AGENT_MODEL} */ (route.tier)];
  if (arm.arm === "delegate" && agentModel) {
    lines[2] =
      "solumbe enforce mode, delegate arm: this request is part of a routing trial. The session's own model cannot change, so the tier is applied by delegation.";
    lines.push(
      "",
      `Do the tool work for this request (investigation, edits, running checks) in a subagent launched with model \`${agentModel}\`${route.hostModel ? ` (${route.hostModel})` : ""}. Brief it fully, then review what it returns before reporting. Answer directly without a subagent only when the request needs no tool work at all. Do not say the session's model was changed.`,
    );
    return lines.join("\n");
  }

  if (route.hostModel) {
    lines.push(
      "",
      `If you delegate any part of this request to a subagent, launch it on \`${route.hostModel}\`${agentModel ? ` (Agent tool \`model: "${agentModel}"\`)` : ""}. Do not spawn a subagent you would not otherwise have used just to reach that tier.`,
    );
  }

  return lines.join("\n");
}

/**
 * Run `solumbe route` for one request.
 * @param {string} cwd
 * @param {string} prompt
 * @returns {Promise<any|null>} the route payload, or null on any failure
 */
export function routeRequest(cwd, prompt) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {any} */ value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn(process.execPath, [CLI, "route", cwd, prompt, "--host", "claude-code", "--json"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return done(null);
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, routeTimeoutMs());

    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done(null);
      try {
        const parsed = JSON.parse(out);
        // A route with no evidence behind it is still returned; formatContext
        // reads `scoring.evidence.sufficient` and says "no recommendation".
        if (!parsed?.tier) return done(null);
        done(parsed);
      } catch {
        done(null);
      }
    });
  });
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

  if (!shouldRoute(input)) return;

  // Registered twice (user and project settings), the second run stands down.
  const claimKey = promptClaimKey(input);
  if (claimKey && !claimOnce(claimKey)) return;

  const route = await routeRequest(input.cwd, input.prompt);
  if (!route) return;

  const arm = routeArm(String(input.prompt ?? ""));

  // The decision outlives the turn only here.
  appendDecision(decisionRecord(input, route, gitStateAt(input.cwd), arm), routeLogPath());

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatContext(route, arm),
      },
    }),
  );
}

// Only run when invoked as the hook, so the tests can import the pure parts.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    // Silence is the contract: a failed router must not block a prompt.
  });
}
