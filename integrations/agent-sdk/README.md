# Case study: a trust layer for an AI coding agent

An example orchestrator built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`), with solumbe as its guardrail. It takes a coding task, has two subagents make and test the change, and stops at a proposed merge. It never commits, pushes or merges.

This folder is an example, not part of the published `@bashbop/solumbe` package: the package's `files` list does not include `integrations/`, and the SDK is a dependency of this folder only.

## The problem

A coding agent can write a plausible diff quickly. What it cannot do on its own is answer the questions a reviewer asks before merging: did it touch only what the task needed, are the risky paths covered, and does the change pass the same gate a human change would? Asking the model to check itself puts the check inside the thing being checked.

The design rule here: **the model decides how to make the change; code decides whether the change is in scope and mergeable.**

## Architecture

```
            task
              │
   ┌──────────▼───────────┐   solumbe (MCP, called from code)
   │     orchestrator     │──► 1. context_pack     plan: owner files, tests, commands
   │  (deterministic JS)  │──► 2. model_route ×2   one model per subagent role
   │                      │──► 3. change_impact    declare: true → scope contract
   │                      │
   │  4. SDK query() ─────┼──────────────────────────────────────────┐
   │                      │   lead agent (reads, delegates, no edits)│
   │                      │     ├─ implementer   Read/Glob/Grep/Edit/Write, routed model
   │                      │     └─ test-writer   Read/Glob/Grep/Edit/Write/Bash(tests), routed model
   │                      │   every tool call ─► PreToolUse hook ─► allowedTools / canUseTool
   │                      │◄─────────────────────────────────────────┘ result: cost, turns, subtype
   │                      │──► 5. review_gate      against the declared intent
   └──────────┬───────────┘
        PASS / WARN / withheld ─► propose merge (PR body)
        FAIL / run error        ─► escalate to a human with the reasons
```

| Step | Owner | Why it is code, not prompt |
| --- | --- | --- |
| Plan (`context_pack`) | orchestrator | The ranked files go into the lead's prompt; the subagents can re-query solumbe read-only. |
| Route (`model_route`) | orchestrator | One call per role, so writing tests does not inherit the implementer's tier. The tier maps to the host model id solumbe returns (`host: "claude-code"`), else to `haiku`/`sonnet`/`opus`. |
| Declare (`change_impact`, `declare: true`) | orchestrator | Frozen before the first edit. With no intent the run stops before the SDK is called. |
| Delegate (`query()`) | Agent SDK | The only open-ended step. Bounded by the guardrails below. |
| Gate (`review_gate`) | orchestrator | Agents cannot call it (`disallowedTools`), so they cannot gate their own work. |

## Guardrails

Four layers, coarse to fine, plus run limits. All of them are in [guardrails.mjs](guardrails.mjs) and [orchestrator.mjs](orchestrator.mjs).

| Layer | SDK option | What it does here |
| --- | --- | --- |
| Tool surface | `tools`, per-agent `tools`, `disallowedTools` | Each role sees only its tools. Nobody gets web access or the gate. |
| Auto-approve | `allowedTools` | Read-only tools only (`Read`, `Glob`, `Grep`, solumbe `context_pack` / `repo_search`). `Edit`, `Write` and `Bash` are never auto-approved. |
| Permission callback | `canUseTool` | Decides every other call: writes must be inside the repo and the declared scope; Bash must be a test command (`npm test`, `node --test`). |
| Hard deny | `hooks.PreToolUse` | Runs for the lead and every subagent, before permission rules: denies `git push/merge/reset`, `gh pr merge`, `npm publish`, `rm -rf`, shell chaining, writes to `.git`, and writes outside the declared scope. |
| Run limits | `maxTurns`, `maxBudgetUsd` | Defaults 40 turns and $5. Hitting either ends the run with `error_max_turns` / `error_max_budget_usd`, which escalates. |
| Isolation | `settingSources: []`, `permissionMode: "default"` | No user or project settings can widen the rules; no bypass mode. |

"In scope" means a declared owner or supporting file, a file under a declared module, an amended file, or a test file. The hook is slightly looser than the gate on tests (any test file, where `convergence_score` counts tests of in-scope files), so the gate stays the final word.

## The gate and escalation

`review_gate` runs locally against the base ref with the declared intent, so a changed file that was never declared fails its Scope contract check.

- **PASS / WARN**: the orchestrator returns `status: "proposed"` and a PR body carrying the verdict, the WARN reasons, each subagent's model and the run's cost. Opening and merging the PR stays with a human.
- **FAIL**: `status: "escalated"`. The `escalate` callback gets the failing checks (`Scope contract: src/billing.js was never declared.`) and nothing is proposed.
- **Withheld**: solumbe's check trial (`SOLUMBE_CHECK_MODE=trial`) withholds about half of local gate results to measure whether showing them changes outcomes. A withheld answer is recorded and non-blocking (a blocking FAIL is always shown), so the orchestrator proposes the merge and says the verdict was withheld. It does not fetch the result another way: that would spoil the trial.
- **Run error** (budget, turns, execution error): escalated before the gate, with the limit that was hit.

## Run it

```bash
cd integrations/agent-sdk
npm install
node run.mjs --repo /path/to/repo --base origin/develop --budget 3 "add a --json flag to the status command"
```

It needs Claude credentials for the Agent SDK and `solumbe` on `PATH` (or `SOLUMBE_COMMAND="node /path/to/solumbe/src/cli.js"`). Exit code 0 means a merge was proposed; 1 means it escalated.

## Tests

[tests/agent-sdk-example.test.js](../../tests/agent-sdk-example.test.js) runs in the repository's `npm test` with no network and no SDK install:

- `query()` is a scripted fake that drives each tool call through the configured hook, `allowedTools` and `canUseTool`, then yields an SDK result message.
- solumbe is a fake for the orchestration paths (PASS, FAIL, withheld, missing intent, budget cap), and solumbe's real MCP server on in-process streams for the client.

The option shapes were also type-checked against the SDK's own `Options`, `CanUseTool` and `HookCallback` types (v0.3.302).

## What this shows

- **Workflow vs agent.** The outer loop is a fixed workflow; only the delegate step is agentic. Most of the reliability comes from keeping it that way.
- **Hub-and-spoke delegation.** The lead holds the task and the scope; subagents get narrow tools, their own model and a short prompt, and report back. They do not talk to each other.
- **Enforcement belongs in hooks and code.** A prompt that says "don't push" is a request; a PreToolUse deny is a rule. Prompts carry intent, hooks carry policy.
- **Human in the loop at the irreversible step.** The agent can propose; merging stays with a person, and a FAIL arrives with reasons a person can act on.
- **Cost is a routing decision.** Each role is priced separately, and a budget cap turns a runaway loop into an escalation instead of a bill.
