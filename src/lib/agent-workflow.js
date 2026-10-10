/**
 * How an agent uses solumbe across a task. The MCP server sends it to every
 * host in its `initialize` result, so the workflow travels with the server
 * instead of living in one host's instruction file (CLAUDE.md, AGENTS.md,
 * .cursor/rules). Tool names are the server's own; hosts may prefix them.
 */

/** Each stage, and the tool it calls. */
export const AGENT_WORKFLOW_STAGES = Object.freeze([
  Object.freeze({
    stage: "New task, or the scope changes",
    tool: "context_pack",
    how: "Call it first, before reading or grepping files: limit 8, online true (the model read needs TYPESAFE_API_KEY and falls back when it is missing).",
  }),
  Object.freeze({
    stage: "Weak result: intent unknown, or the top files don't fit the task",
    tool: "repo_search",
    how: "Retry once with concrete names (library, component, route) before grepping. It searches indexed repositories; call repo_index first for one that isn't indexed.",
  }),
  Object.freeze({
    stage: "Before editing a specific change",
    tool: "change_impact",
    how: "Use its risk flags and suggested tests. To hold the change to its scope, pass declare: true and keep the intent it returns.",
  }),
  Object.freeze({
    stage: "Delegating to another agent",
    tool: "context_pack",
    how: "Put solumbe's files and hotspots in the agent's prompt and tell it to call context_pack first.",
  }),
  Object.freeze({
    stage: "Before each commit",
    tool: "convergence_score",
    how: "Score the diff against the base branch and report any drift from the task.",
  }),
  Object.freeze({
    stage: "Before opening a pull request",
    tool: "review_gate",
    how: "Include its verdict in the pull request. Pass the intent declared before the edit, so a changed file that was never declared fails.",
  }),
]);

/** The workflow as plain text, for MCP `initialize` instructions. */
export const AGENT_WORKFLOW_INSTRUCTIONS = [
  "Use solumbe at each stage of repository work, not once at the start:",
  ...AGENT_WORKFLOW_STAGES.map(({ stage, tool, how }, index) => `${index + 1}. ${stage}: ${tool}. ${how}`),
  "Misses are feedback: when grep or another agent finds files solumbe did not rank, tell the user the request and the missed files.",
  "Skip solumbe for conversation without repository work and for follow-ups within the same scope.",
].join("\n");
