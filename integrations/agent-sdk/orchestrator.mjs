// The orchestrator: a deterministic workflow around one Claude Agent SDK run.
//
//   plan      solumbe context_pack          what the change touches
//   route     solumbe model_route per role  which model each subagent runs on
//   declare   solumbe change_impact         the scope contract, frozen before any edit
//   delegate  SDK query() with two subagents, guarded (see guardrails.mjs)
//   gate      solumbe review_gate           PASS/WARN proposes a merge; FAIL escalates
//
// Every step outside `delegate` is code. The model decides how to make the
// change; it does not decide whether the change is in scope or mergeable.

import { DISALLOWED_TOOLS, READ_TOOLS, ROLE_TOOLS, SOLUMBE_READ_TOOLS, createCanUseTool, createPreToolUseHook } from "./guardrails.mjs";
import { isWithheld } from "./solumbe-client.mjs";

/** Used when model_route returns a tier without a host model id. */
export const TIER_MODELS = Object.freeze({ cheap: "haiku", mid: "sonnet", premium: "opus" });

/** @typedef {{ maxTurns: number, maxBudgetUsd: number, leadModel: string }} Limits */
/** @typedef {{ type: "stdio", command: string, args?: string[], env?: Record<string, string> }} StdioServer */

/** @type {Readonly<Limits>} */
export const DEFAULT_LIMITS = Object.freeze({ maxTurns: 40, maxBudgetUsd: 5, leadModel: "claude-opus-5-5" });

/**
 * @typedef {{ call?: Function, contextPack: Function, modelRoute: Function, declareIntent: Function, reviewGate: Function }} Solumbe
 * @typedef {{ kind: "gate-fail"|"run-error", reasons: string[], verdict?: string, task: string }} Escalation
 * @typedef {{
 *   status: "proposed"|"escalated",
 *   verdict: "PASS"|"WARN"|"FAIL"|"WITHHELD"|null,
 *   reasons: string[],
 *   routes: Record<string, { tier: string, model: string }>,
 *   intent: any,
 *   run: { subtype: string, costUsd: number|null, turns: number|null, summary: string },
 *   decisions: object[],
 *   prBody?: string,
 * }} OrchestratorResult
 */

/**
 * Resolve the model a role runs on from solumbe's routing answer.
 * @param {any} route model_route's result
 */
export function modelForRoute(route) {
  const tier = typeof route?.tier === "string" ? route.tier : "mid";
  const model =
    typeof route?.hostModel === "string" && route.hostModel ? route.hostModel : (TIER_MODELS[/** @type {"cheap"|"mid"|"premium"} */ (tier)] ?? "sonnet");
  return { tier, model };
}

/**
 * Turn review_gate's answer into a decision. FAIL blocks. A withheld result
 * (the check trial) is non-blocking: solumbe always shows a blocking FAIL,
 * so withheld means "recorded, nothing blocks".
 * @param {any} gate
 * @returns {{ verdict: "PASS"|"WARN"|"FAIL"|"WITHHELD", blocked: boolean, reasons: string[] }}
 */
export function readGate(gate) {
  if (isWithheld(gate)) return { verdict: "WITHHELD", blocked: false, reasons: [String(gate.message ?? "Verdict withheld by the solumbe check trial.")] };
  const verdict = gate?.verdict === "PASS" || gate?.verdict === "WARN" ? gate.verdict : "FAIL";
  const checks = Array.isArray(gate?.checks) ? gate.checks : [];
  const flagged = checks.filter((/** @type {any} */ check) => check.status === (verdict === "FAIL" ? "FAIL" : "WARN"));
  const reasons = flagged.map((/** @type {any} */ check) => `${check.name}: ${check.summary}`);
  if (verdict === "FAIL" && reasons.length === 0)
    reasons.push(gate?.verdict ? "review_gate returned FAIL without check details." : "review_gate returned no verdict; treated as FAIL.");
  return { verdict, blocked: verdict === "FAIL", reasons };
}

/**
 * The SDK options for the delegate step. Exported so the guardrails are
 * testable without running anything.
 * @param {{ repo: string, intent: any, routes: Record<string, { model: string }>, limits: Limits, solumbeServer: StdioServer, log: (event: object) => void }} args
 */
export function buildQueryOptions({ repo, intent, routes, limits, solumbeServer, log }) {
  const context = { root: repo, intent, log };
  const scope = JSON.stringify(intent?.declared ?? {}, null, 2);
  return {
    cwd: repo,
    model: limits.leadModel,
    // Isolation: no user or project settings, so nothing outside this file
    // widens the permissions below.
    settingSources: [],
    permissionMode: /** @type {const} */ ("default"),
    tools: [
      ...new Set(
        Object.values(ROLE_TOOLS)
          .flat()
          .filter((tool) => !tool.startsWith("mcp__")),
      ),
    ],
    allowedTools: [...READ_TOOLS, ...SOLUMBE_READ_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    canUseTool: createCanUseTool(context),
    hooks: { PreToolUse: [{ hooks: [createPreToolUseHook(context)] }] },
    maxTurns: limits.maxTurns,
    maxBudgetUsd: limits.maxBudgetUsd,
    mcpServers: { solumbe: solumbeServer },
    systemPrompt:
      "You lead a small team. You do not edit files. Delegate the source change to the implementer agent and the tests to the test-writer agent, " +
      "then reply with a short summary of what changed and how it was tested. Stay inside this declared scope; if the change needs a file outside it, stop and say which file and why.\n" +
      `Declared scope:\n${scope}`,
    agents: {
      implementer: {
        description: "Makes the source change for the task, inside the declared scope.",
        prompt:
          "Implement the requested change with the smallest diff that does it. Call mcp__solumbe__context_pack first. Do not write tests; the test-writer does.",
        tools: [...ROLE_TOOLS.implementer],
        model: routes.implementer.model,
      },
      "test-writer": {
        description: "Writes or updates tests for the change and runs the test command.",
        prompt: "Write focused tests for the change the implementer made, then run the project's test command (npm test or node --test) and report the result.",
        tools: [...ROLE_TOOLS["test-writer"]],
        model: routes["test-writer"].model,
      },
    },
  };
}

/**
 * Drain an SDK query and keep what the orchestrator needs from the result.
 * @param {AsyncIterable<any>} stream
 */
async function collectRun(stream) {
  let result = null;
  for await (const message of stream) {
    if (message?.type === "result") result = message;
  }
  return {
    subtype: result?.subtype ?? "error_during_execution",
    costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
    turns: typeof result?.num_turns === "number" ? result.num_turns : null,
    summary: result?.subtype === "success" ? String(result.result ?? "") : "",
  };
}

/**
 * @param {{ task: string, verdict: string, reasons: string[], routes: Record<string, { tier: string, model: string }>, run: { costUsd: number|null, turns: number|null, summary: string } }} args
 */
export function formatPrBody({ task, verdict, reasons, routes, run }) {
  const lines = [
    `## Task`,
    task,
    "",
    "## solumbe review_gate",
    verdict === "WITHHELD" ? "Verdict withheld by the solumbe check trial (recorded, non-blocking)." : `Verdict: **${verdict}**`,
    ...reasons.map((reason) => `- ${reason}`),
    "",
    "## Agents",
    ...Object.entries(routes).map(([role, route]) => `- ${role}: ${route.model} (tier ${route.tier})`),
    `- cost: ${run.costUsd == null ? "unknown" : `$${run.costUsd.toFixed(2)}`}, turns: ${run.turns ?? "unknown"}`,
    "",
    "## Summary",
    run.summary || "(no summary)",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Run one task end to end. Proposes a merge; never merges.
 * @param {{
 *   task: string,
 *   repo: string,
 *   base?: string,
 *   query: (args: { prompt: string, options: object }) => AsyncIterable<any>,
 *   solumbe: Solumbe,
 *   solumbeServer?: StdioServer,
 *   escalate?: (escalation: Escalation) => void | Promise<void>,
 *   limits?: Partial<Limits>,
 * }} args
 * @returns {Promise<OrchestratorResult>}
 */
export async function runOrchestrator({
  task,
  repo,
  base = "origin/develop",
  query,
  solumbe,
  solumbeServer = { type: /** @type {const} */ ("stdio"), command: "solumbe", args: ["mcp"] },
  escalate = () => {},
  limits = {},
}) {
  /** @type {object[]} */
  const decisions = [];
  const log = (/** @type {object} */ event) => decisions.push(event);
  const merged = { ...DEFAULT_LIMITS, ...limits };

  // plan
  const context = await solumbe.contextPack({ query: task, path: repo });
  const primary = (context?.primaryFiles ?? []).map((/** @type {any} */ f) => f.path ?? f).slice(0, 8);

  // route: one call per role, so a cheap test-writing job does not inherit
  // the implementer's tier.
  const roleTasks = { implementer: task, "test-writer": `Write and run tests for: ${task}` };
  /** @type {Record<string, { tier: string, model: string }>} */
  const routes = {};
  for (const [role, roleTask] of Object.entries(roleTasks)) {
    routes[role] = modelForRoute(await solumbe.modelRoute({ query: roleTask, path: repo }));
  }

  // declare: the scope contract, before any edit
  const impact = await solumbe.declareIntent({ query: task, path: repo });
  const intent = impact?.intent;
  if (!intent) throw new Error("change_impact returned no declared intent; refusing to edit without a scope contract.");

  // delegate
  const options = buildQueryOptions({ repo, intent, routes, limits: merged, solumbeServer, log });
  const prompt = [`Task: ${task}`, primary.length ? `solumbe's primary files: ${primary.join(", ")}` : null].filter(Boolean).join("\n");
  const run = await collectRun(query({ prompt, options }));
  if (run.subtype !== "success") {
    const reasons = [
      `Agent run ended with ${run.subtype}${run.subtype === "error_max_budget_usd" ? ` (budget $${merged.maxBudgetUsd})` : run.subtype === "error_max_turns" ? ` (max ${merged.maxTurns} turns)` : ""}.`,
    ];
    await escalate({ kind: "run-error", reasons, task });
    return { status: "escalated", verdict: null, reasons, routes, intent, run, decisions };
  }

  // gate
  const gate = readGate(await solumbe.reviewGate({ path: repo, base, intent, request: task }));
  if (gate.blocked) {
    await escalate({ kind: "gate-fail", verdict: gate.verdict, reasons: gate.reasons, task });
    return { status: "escalated", verdict: gate.verdict, reasons: gate.reasons, routes, intent, run, decisions };
  }
  const prBody = formatPrBody({ task, verdict: gate.verdict, reasons: gate.reasons, routes, run });
  return { status: "proposed", verdict: gate.verdict, reasons: gate.reasons, routes, intent, run, decisions, prBody };
}
