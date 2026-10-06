---
name: solumbe
description: Use when working with the solumbe repository, CLI, or MCP server; generating repository harnesses, repo maps, workspace reports, PR review context, route/client/domain lookup, token estimates, or installing/restoring solumbe from github.com/BASHBOP/solumbe. Works with any agent host that can use MCP, a terminal, or a structured handoff.
---

# solumbe

Use `solumbe` to generate concrete repository context for agents and reviewers before editing, reviewing, or planning work. Prefer its structured output over guessing repo scripts, routes, file kinds, or cross-repo contracts.

## Source

The canonical skill source is backed by this repository at:

```bash
codex/skills/solumbe
```

If the repo is missing, restore it from:

```bash
git clone https://github.com/BASHBOP/solumbe /path/to/solumbe
```

If the installed skill is missing or stale, run this from a `solumbe` checkout:

```bash
codex/skills/solumbe/scripts/sync-installed.sh
```

## Quick Workflow

1. Start with the smallest context artifact that answers the task.
2. Use JSON output when another tool or script will consume it.
3. Use Markdown artifacts under `.solumbe/` when a human or long-running agent needs a durable report.
4. For cross-repo product work, use `workspace` instead of inspecting each repo in isolation.
5. For PR review, use `pr` with an explicit base when possible.
6. If `solumbe` is unavailable as a command, run `node /path/to/solumbe/src/cli.js ...`.

## Trusted Agent Workflow

Use this sequence for coding work. It is deliberately independent of the model or host: Solumbe supplies the deterministic evidence; the human retains the merge decision.

1. **Understand.** Run `solumbe context "<task>" --path . --json` before planning or editing. Read the matched source and tests; a context pack is a map, not proof.
2. **Bound the work.** For unclear, broad, or risk-sensitive work, run `solumbe impact . "<task>" --json`. For a product change spanning repositories, start with `solumbe workspace <repo...> --out .solumbe/workspace.md`.
3. **Change narrowly.** Keep one purpose, inspect the diff, and add targeted validation or an explicit no-test rationale. Prefer the smallest owner files over a new helper or layer. Clean code is a focused, testable change, not a cleaner agent.
4. **Prepare review.** Run `solumbe pr . --base origin/main --out .solumbe/pr-review.md` and `solumbe gate . --staged --base origin/main` before handing work to a maintainer. When using `workspace-gate` for a multi-repository change, describe it only as local staged evidence; GitHub review state, hosted CI, and mergeability remain separate authorities.
5. **Hand off evidence.** State the intended change, changed scope, validation results, gate verdict, remaining risks, and the human decision required.

Use the lightest useful path for a trivial, low-risk documentation correction. Do not skip context, impact, or review merely because an agent authored the change.

### Over MCP

The MCP server sends this workflow to every host in its `initialize` result (`instructions`, from `src/lib/agent-workflow.js`). A host that shows server instructions gets it without any instruction file of its own. The stages, by tool:

| Stage                                                            | Tool                |
| ---------------------------------------------------------------- | ------------------- |
| New task, or the scope changes                                   | `context_pack`      |
| Weak result: intent unknown, or the top files don't fit the task | `repo_search`       |
| Before editing a specific change                                 | `change_impact`     |
| Delegating to another agent                                      | `context_pack`      |
| Before each commit                                               | `convergence_score` |
| Before opening a pull request                                    | `review_gate`       |

## Host Compatibility

The workflow supports three connection modes. Do not claim that a host has direct MCP support until its current vendor documentation confirms it.

| Host | Recommended Solumbe connection | Notes |
| --- | --- | --- |
| Codex, Claude Desktop, VS Code, Cursor | Local stdio MCP | Configure `solumbe mcp`, then use the agent workflow above. |
| Gemini CLI | Local stdio MCP | Add `solumbe` to `mcpServers` in `~/.gemini/settings.json` or `.gemini/settings.json`; verify with `gemini mcp list`. |
| Kimi Code CLI | Local stdio MCP | Add `solumbe` to `~/.kimi-code/mcp.json` or `.kimi-code/mcp.json`; verify with `kimi mcp list`. |
| Grok | Structured handoff today | Grok custom connectors require a publicly reachable remote MCP endpoint. Do not tunnel or expose a local Solumbe server without an approved remote deployment and security review. Generate a local `.solumbe/` artifact and share only a sanitised summary when direct MCP is unavailable. |

For every host, keep machine-specific paths, credentials, raw logs, and source content out of shared configuration and public evidence.

## CLI Commands

From the tool repo:

```bash
node src/cli.js help
node src/cli.js install
node src/cli.js i
node src/cli.js doctor
node src/cli.js repo /path/to/repo --json
node src/cli.js discover /path/to/workspace --depth 2 --json
node src/cli.js index /path/to/workspace --discover
node src/cli.js catalog --json
node src/cli.js search "events controller" --json
node src/cli.js context "add a new MCP tool" --path /path/to/repo --json
node src/cli.js map /path/to/repo --json
node src/cli.js harness /path/to/repo --out /path/to/repo/.solumbe/harness.md
node src/cli.js workspace /path/to/web /path/to/api --out .solumbe/workspace.md
node src/cli.js pr /path/to/repo --base origin/main --out /path/to/repo/.solumbe/pr-review.md
node src/cli.js report /path/to/repo --out /path/to/repo/.solumbe/report.md
node src/cli.js init /path/to/repo
node src/cli.js mcp
```

If installed as a package, the same commands can use `solumbe` instead of `node src/cli.js`.

Optional external tools:

```bash
npm install -g opensrc code-structure
```

Use these only when dependency-source lookup or TypeScript structure HTML is needed:

```bash
node src/cli.js deps zod --query parse --limit 20
node src/cli.js structure /path/to/repo --pattern "app/**/*.tsx" --out .solumbe/structure.html
```

## MCP Server

Run:

```bash
node /path/to/solumbe/src/cli.js mcp
```

MCP tools exposed by the server:

- `repo_inspect`: repository shape, scripts, package managers, entrypoints, git metadata
- `repo_map`: compact JSON code map with optional `domain`, `kind`, and `route` filters
- `repo_index`: local `.solumbe/index.json` generation and catalog registration; `dryRun:true` discovers read-only
- `repo_search`: local catalog search across paths, domains, routes, imports, exports, and symbols; omit `query` to list the catalog
- `context_pack`: task-aware local context packet with primary files, related files, tests, validation commands, and source evidence
- `change_impact`: rank files most likely to own a plain-English change request
- `agent_experience`: Agent Experience (AX 0–100) score for a change
- `model_route`: advisory model tier (cheap / mid / premium) for a request before work starts
- `convergence_score`: intent vs. execution score (0–100) with a recomputable receipt
- `review_context`: diff-aware PR review context (no verdict)
- `review_gate`: PASS/WARN/FAIL merge gate — local without `pr`, GitHub PR gate with `pr`
- `review_verdict`: composite verdict (impact + review context + gate)
- `workspace_report`: product-level context across multiple repos
- `repo_harness`: setup, validation, runtime, and context commands

## Interpretation Rules

- Treat generated context as a map, not proof. Confirm by reading the files before editing.
- Do not hardcode route, API-client, schema, or contract paths when `solumbe` can discover them.
- For dirty worktrees, report the state before writing generated artifacts.
- Use `.solumbe/` for generated reports in target repos; avoid mixing generated context into source directories.
- For PR review, lead with bugs, risky behavior changes, missing tests, and unclear contracts.

## Maintaining solumbe

When editing this repo, run:

```bash
npm run ci
npm test
npm run smoke
```

If CLI commands, MCP tools, or package scripts change, update this skill and its evals before syncing the installed copy.
