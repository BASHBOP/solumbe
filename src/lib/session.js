import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateContextPack } from "./context-engine.js";
import { generateImpact } from "./impact.js";
import { declaredScope, intentFromImpact, verifyIntent, writeIntent } from "./intent.js";
import { generateConvergence, formatConvergenceMarkdown } from "./converge.js";
import { evaluateLocal } from "./pass-local.js";

/**
 * Run the repository workflow as one deterministic task artifact. Context and
 * impact happen before the edit; convergence and the local gate evaluate the
 * current tree so the same command can be used before and after an edit.
 *
 * @param {string} request
 * @param {{ path?: string, base?: string, head?: string, staged?: boolean, top?: number, limit?: number, intent?: string, policy?: string, governance?: string, runValidation?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function runSession(request, options = {}) {
  const query = String(request ?? "").trim();
  if (!query) throw new Error('session requires a request, e.g. `solumbe session "add Stripe refunds"`');
  const repoPath = options.path ?? ".";
  const root = gitRoot(repoPath);
  const context = generateContextPack(query, { path: root, limit: options.limit, includeEvidence: true }).data;
  const impact = generateImpact(query, { path: root, top: options.top ?? 10 }).data;
  const intent = intentFromImpact(impact);
  const intentPath = writeIntent(root, intent, options.intent ?? ".solumbe/intent.json");
  const verified = verifyIntent(intent);
  if (!verified.ok) throw new Error(`session intent does not verify: ${verified.error}`);

  const base = options.base ?? defaultBase(root);
  const convergence = generateConvergence(query, {
    path: root,
    base,
    head: options.head,
    staged: options.staged,
    top: options.top ?? 10,
    declared: declaredScope(intent, verified.tip),
  });
  const gate = evaluateLocal(root, {
    base,
    head: options.head,
    staged: options.staged,
    policy: options.policy,
    governance: options.governance,
    request: query,
    intent,
    runValidation: options.runValidation,
  });

  return {
    ok: true,
    schema: "solumbe.session/v1",
    request: query,
    repo: { root, name: context.repos?.[0]?.name ?? path.basename(root) },
    base,
    intentPath,
    context,
    impact,
    intent,
    convergence,
    gate,
    verdict: gate.verdict,
  };
}

/**
 * @param {Record<string, any>} data
 * @returns {string}
 */
export function formatSessionMarkdown(data) {
  const context = data.context ?? {};
  const impact = data.impact ?? {};
  const gate = data.gate ?? {};
  const lines = [
    `# Solumbe Session: ${data.request}`,
    "",
    `Repository: ${data.repo.name}`,
    `Root: ${data.repo.root}`,
    `Base: ${data.base}`,
    `Intent: ${data.intentPath}`,
    `Verdict: **${data.verdict}**`,
    "",
    "## Context",
    "",
    `- Primary files: ${formatPaths(context.primaryFiles)}`,
    `- Related files: ${formatPaths(context.relatedFiles)}`,
    `- Tests: ${formatPaths(context.tests)}`,
    `- Validation commands: ${formatCommands(context.commands)}`,
    "",
    "## Declared intent",
    "",
    `- Owners: ${formatList(data.intent?.declared?.owners)}`,
    `- Supporting: ${formatList(data.intent?.declared?.supporting)}`,
    `- Contract: ${data.intent?.contractHash ?? "unknown"}`,
    "",
    "## Impact",
    "",
    `- Required owners: ${formatList(impact.classifications?.requiredOwners)}`,
    `- Suggested tests: ${formatList(impact.testSuggestions)}`,
    "",
    "## Convergence",
    "",
    formatConvergenceMarkdown(data.convergence),
    "",
    "## Gate",
    "",
    `- Verdict: **${gate.verdict ?? "unknown"}**`,
    ...(gate.checks ?? []).map((/** @type {any} */ check) => `- ${check.status}: ${check.name} — ${check.summary}`),
  ];
  return lines.join("\n");
}

/** @param {string} repoPath @returns {string} */
function gitRoot(repoPath) {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`session requires a Git repository: ${String(result.stderr ?? "").trim() || repoPath}`);
  return result.stdout.trim();
}

/** @param {string} root @returns {string} */
function defaultBase(root) {
  for (const candidate of ["origin/main", "main", "HEAD"]) {
    const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", `${candidate}^{commit}`], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) return candidate;
  }
  throw new Error("session could not find a base commit; pass --base <ref>");
}

/** @param {any[] | undefined} files @returns {string} */
function formatPaths(files) {
  return formatList((files ?? []).map((file) => (typeof file === "string" ? file : file.path)).filter(Boolean));
}

/** @param {any[] | undefined} commands @returns {string} */
function formatCommands(commands) {
  return formatList((commands ?? []).map((command) => (typeof command === "string" ? command : command.command)).filter(Boolean));
}

/** @param {any[] | undefined} values @returns {string} */
function formatList(values) {
  const items = values ?? [];
  return items.length ? items.map((item) => `\`${item}\``).join(", ") : "none";
}
