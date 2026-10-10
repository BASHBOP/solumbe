# 2026-10-06: requests that name a tool

Found while reviewing #269 and #272 with solumbe's own tools.

## Misses

1. `context_pack` on the solumbe repository:

   > ship the agent workflow (when to call context_pack, repo_search, change_impact, convergence_score, review_gate) with solumbe itself for any MCP host: MCP initialize instructions, …

   Expected primary: `src/lib/mcp.js`, which registers every tool. It was missing from the top 8.

2. `convergence_score` on #272's commit ("stop convergence_score counting …"): 79/100 (partial). It reported `src/lib/converge.js`, the file the request is about, as drift.

## Cause

`src/lib/mcp.js` names each tool only as a string: `name: "convergence_score"` in the tools table, and `case "convergence_score":` in `callTool`. The indexer recorded declarations only, so a request naming `convergence_score` matched no symbol in any file. Nothing linked the tool to `converge.js`, whose `generateConvergence` the switch branch calls.

## Fix

- `code-map/ast.js` indexes identifier-shaped strings in those two positions as `registered` symbols, with the functions their entry or branch calls as terms.
- `resolveNamedFiles` follows those calls through the registry's imports to the module that exports one, and pins it as `implements`.

## After

- Request 1: `src/lib/mcp.js` is second, and the hotspots lead with the registered tool names.
- Request 2: 82/100 (aligned). `converge.js` is a confirmed owner, scope and risk alignment are both 100, and nothing is drift.

The eval case is `registered-tool-implementation`, on `evals/fixtures/tool-registry`.
