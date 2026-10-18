// Guardrails for the example agent, in code rather than in the prompt.
//
// Four layers, from coarse to fine:
//   1. `tools` per role: what each agent can see at all.
//   2. `allowedTools`: the read-only subset that runs without a decision.
//   3. `canUseTool`: decides every other call (writes, Bash) per role.
//   4. A PreToolUse hook: hard denies that no permission mode or rule can
//      lift (pushes, merges, publishes, writes outside the declared scope).
// The SDK's `maxTurns` and `maxBudgetUsd` bound the run as a whole.

import { isAbsolute, relative, resolve } from "node:path";

export const READ_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
export const SOLUMBE_READ_TOOLS = Object.freeze(["mcp__solumbe__context_pack", "mcp__solumbe__repo_search"]);
export const WRITE_TOOLS = Object.freeze(["Edit", "Write"]);

/**
 * What each role may use. The lead only reads and delegates; the implementer
 * edits source; the test writer edits tests and may run the test command.
 */
export const ROLE_TOOLS = Object.freeze({
  lead: [...READ_TOOLS, ...SOLUMBE_READ_TOOLS, "Agent"],
  implementer: [...READ_TOOLS, ...SOLUMBE_READ_TOOLS, ...WRITE_TOOLS],
  "test-writer": [...READ_TOOLS, ...WRITE_TOOLS, "Bash"],
});

/** Tools no agent in this example may ever use. */
export const DISALLOWED_TOOLS = Object.freeze(["WebFetch", "WebSearch", "mcp__solumbe__review_gate", "mcp__solumbe__change_impact"]);

/** Bash commands the test writer may run: the project's test commands, nothing else. */
export const BASH_ALLOW = Object.freeze([/^npm (run )?test( |$)/, /^node --test( |$)/]);

/** Commands denied outright, whatever the role or permission mode. */
export const BASH_DENY = Object.freeze([/\bgit\s+(push|merge|rebase|reset)\b/, /\bgh\s+pr\s+merge\b/, /\bnpm\s+publish\b/, /\brm\s+-rf?\b/, /[;&|`$]/]);

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.test\.[cm]?[jt]sx?$/;

/**
 * Is a repository-relative path inside the declared intent? Declared owners,
 * supporting files and modules count, and so do tests (convergence_score
 * treats tests of in-scope files as in scope).
 * @param {string} file repository-relative path
 * @param {any} intent the record change_impact returned with declare: true
 */
export function inDeclaredScope(file, intent) {
  const declared = intent?.declared ?? {};
  const files = [...(declared.owners ?? []), ...(declared.supporting ?? []), ...(intent?.amendments ?? []).flatMap((/** @type {any} */ a) => a.files ?? [])];
  if (files.includes(file)) return true;
  if ((declared.modules ?? []).some((/** @type {string} */ dir) => file === dir || file.startsWith(`${dir.replace(/\/$/, "")}/`))) return true;
  return TEST_PATH.test(file);
}

/**
 * @param {string} root
 * @param {unknown} filePath
 * @returns {string|null} the repository-relative path, or null when it escapes the root
 */
export function repoRelative(root, filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const rel = relative(root, isAbsolute(filePath) ? filePath : resolve(root, filePath));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/**
 * The hard rules, shared by the hook and the permission callback.
 * @param {{ root: string, intent: any }} context
 * @param {string} toolName
 * @param {any} input
 * @returns {string|null} a deny reason, or null
 */
export function hardDenyReason({ root, intent }, toolName, input) {
  if (DISALLOWED_TOOLS.includes(toolName)) return `${toolName} is not available to agents; the orchestrator runs it.`;
  if (WRITE_TOOLS.includes(toolName)) {
    const rel = repoRelative(root, input?.file_path);
    if (!rel) return `Writes must stay inside the repository (${String(input?.file_path)}).`;
    if (rel.startsWith(".git/") || rel === ".git") return "Writes to .git are not allowed.";
    if (!inDeclaredScope(rel, intent))
      return `${rel} is outside the declared change. Stop and report it; the orchestrator decides whether to amend the intent.`;
  }
  if (toolName === "Bash") {
    const command = String(input?.command ?? "").trim();
    if (BASH_DENY.some((pattern) => pattern.test(command))) return `Command not allowed: ${command}`;
  }
  return null;
}

/**
 * A PreToolUse hook. It runs for the lead and every subagent, before any
 * permission rule, so it is the layer that cannot be bypassed.
 * @param {{ root: string, intent: any, log?: (event: object) => void }} context
 */
export function createPreToolUseHook(context) {
  /** @param {any} input */
  return async (input) => {
    if (input?.hook_event_name !== "PreToolUse") return {};
    const reason = hardDenyReason(context, input.tool_name, input.tool_input);
    context.log?.({ layer: "hook", tool: input.tool_name, decision: reason ? "deny" : "pass", reason });
    if (!reason) return {};
    return {
      hookSpecificOutput: {
        hookEventName: /** @type {const} */ ("PreToolUse"),
        permissionDecision: /** @type {const} */ ("deny"),
        permissionDecisionReason: reason,
      },
    };
  };
}

/**
 * The SDK's canUseTool callback: decides each call that `allowedTools` does
 * not auto-approve. The SDK does not say which agent is calling, so the role
 * check is on the union the run exposes; per-role limits come from each
 * agent's own `tools` list.
 * @param {{ root: string, intent: any, log?: (event: object) => void }} context
 */
export function createCanUseTool(context) {
  /**
   * @param {string} toolName
   * @param {Record<string, unknown>} input
   * @returns {Promise<{ behavior: "allow", updatedInput: Record<string, unknown> } | { behavior: "deny", message: string }>}
   */
  return async (toolName, input) => {
    const hard = hardDenyReason(context, toolName, input);
    const known = Object.values(ROLE_TOOLS).some((tools) => tools.includes(toolName));
    let reason = hard ?? (known ? null : `${toolName} is not on any role's allow-list.`);
    if (!reason && toolName === "Bash") {
      const command = String(input?.command ?? "").trim();
      if (!BASH_ALLOW.some((pattern) => pattern.test(command))) reason = `Only test commands may run: ${command}`;
    }
    context.log?.({ layer: "canUseTool", tool: toolName, decision: reason ? "deny" : "allow", reason });
    return reason ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };
  };
}
