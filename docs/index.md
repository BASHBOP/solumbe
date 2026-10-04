# :material-source-branch: Solumbe

## Independent trust infrastructure for agents and reviewers

> For teams that want any coding agent to produce evidence a human can trust before merge.

**v4.2.0** is published to npm, GitHub Releases, and the official MCP Registry. Solumbe is a Bashbop Ltd product, MIT licensed.

Formerly **Òtítọ́** (`@bashbop/otito`), renamed in 4.0.0. <!-- rebrand-keep -->

---

!!! info "About Solumbe"
    Solumbe is a local-first trust harness for coding agents. It maps repository context before a change, then produces deterministic impact, validation, ownership, and review evidence before merge. It complements model-native agent loops instead of replacing them.

    Its command-line and package identity is `solumbe`.

    :material-animation-play: See the [**How It Works** visual walkthrough](assets/solumbe-how-it-works.html): the loop from context before the edit, to a verdict before the merge, to an attestation after it, with every shipped MCP tool in its place.

---

## What's New

!!! tip "v4.2.0 published (2026-10-04)"
    Reviews look into a repository's companions and read what a migration does to existing data. No command, field or schema was removed.

    - `review_verdict` and `change_impact` name the top files in each companion repository listed in `.solumberc.json`, so a web change whose rule the API also decides points at the API file. The verdict `schemaVersion` is now 2 for that one added field.
    - A new `Migration safety` gate check warns when a changed SQL migration rewrites, deletes, truncates or drops existing data. Prisma schemas and SQL migrations are now mapped.
    - `review_verdict --head` reviews exactly base..head, changed files rank by score, and `.env.example` no longer fails the secret check on its name.
    - Go modules get validation commands, entrypoints and test guardrails, a multi-repo context pack keeps the small repo, and a checkout behind its upstream says so.

    [npm v4.2.0](https://www.npmjs.com/package/@bashbop/solumbe/v/4.2.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v4.2.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fsolumbe)

!!! tip "v4.1.0 published (2026-10-01)"
    One command connects Solumbe to your agents. No command, field or schema was removed.

    - `solumbe install --host all` adds the `solumbe` MCP server to Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Gemini CLI and Kimi Code CLI, wherever it finds them; `--host claude-code,cursor` names hosts instead, and `--dry-run` shows the plan. It checks that the server answers before writing anything, keeps a `.solumbe.bak` of each config it changes, and lists leftover entries from the 4.0.0 rename for you to remove. [docs/02](02-mcp-agent-workflows/README.md#connect-your-agents) has the detail.
    - Host configs pin the absolute `node` and CLI path, so Claude Desktop, Cursor and VS Code start the server under nvm, Volta or Homebrew, where a bare `solumbe` command could not be found.
    - The MCP setup guide has its Claude Code section, and post-merge attestation stays on `main`'s first-parent line.

    [npm v4.1.0](https://www.npmjs.com/package/@bashbop/solumbe/v/4.1.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v4.1.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fsolumbe)

!!! tip "v4.0.0 published (2026-09-30)"
    Òtítọ́ is now Solumbe. Behaviour is unchanged from 3.5.0; every name moves, with no fallback to the old ones. <!-- rebrand-keep -->

    - Install `@bashbop/solumbe` and run `solumbe`; the MCP server is `io.github.BASHBOP/solumbe`, so point host configs at the new package and name the server `solumbe` (tools become `mcp__solumbe__*`).
    - Rename `.otitorc.json` to `.solumberc.json` and `otito.gate.json` to `solumbe.gate.json`, move `.otito/` and `~/.otito/` to `.solumbe/` and `~/.solumbe/`, and rename `OTITO_*` variables to `SOLUMBE_*`. <!-- rebrand-keep -->
    - The [CHANGELOG](https://github.com/BASHBOP/solumbe/blob/main/CHANGELOG.md) has the full rename map. Releases before 4.0.0 stay on npm as `@bashbop/otito`. <!-- rebrand-keep -->

    [npm v4.0.0](https://www.npmjs.com/package/@bashbop/solumbe/v/4.0.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v4.0.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fsolumbe)

!!! tip "v3.5.0 published (2026-09-30)"
    Model routing can make a share of requests follow the tier it picks, not only recommend it. No command, field or schema was removed.

    - `SOLUMBE_ROUTE_MODE=delegate` turns on enforce mode: a share of requests (`SOLUMBE_ROUTE_DELEGATE_SHARE`, default 0.5) is told to do its tool work in a subagent on the routed tier, and the rest are a control. `solumbe route` shows the arm and the subagent model, and `route-outcomes.mjs --arm` grades each arm separately.
    - On Claude Code, the premium tier names `claude-opus-5-5`, the model that actually runs.

    [npm v3.5.0](https://www.npmjs.com/package/@bashbop/otito/v/3.5.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.5.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v3.4.0 published (2026-09-29)"
    One context pack can span a web app and its API, and the router says when it has nothing to go on. No command, field or schema was removed.

    - `context_pack` and `solumbe context` read `companions` from a repository's `.solumberc.json` (`"companions": ["../api"]`), so a web bug whose cause is in the API gets one pack covering both. Explicit `paths` still win; a companion that is not checked out is skipped.
    - `change_impact` raises risk only from required and supporting files, plus any changed file, not from a domain that only an advisory lead touches.
    - `solumbe route` shows each Score question's own confidence next to its score, display only, and says **no recommendation** when solumbe matched no files, while still naming the fail-safe tier. [docs/18](18-model-routing/README.md) has the detail.
    - `context_pack` reads "bug", "broken" or "crash" as debugging, and ranks the repository a multi-repo request names first; `change_impact` keeps a UI page as a required owner without API wording.
    - `version:check` fails when the site banner or What's New lags the released version.

    [npm v3.4.0](https://www.npmjs.com/package/@bashbop/otito/v/3.4.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.4.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v3.3.0 published (2026-09-27)"
    The terminal output gets colour and shape it didn't have before. No command, field or schema was removed.

    - The default terminal look is plain Unicode (`✓ ! ✗`, box drawing, arrows) with no emoji; CI, `NO_EMOJI`, `--no-emoji` and `TERM=dumb` keep ASCII, and `--emoji` opts back in. Tables, trees and lists come from shared primitives, and every command that prints for a person ends with one closing line such as `Verified.` or `Runs without errors.`
    - `solumbe install` asks a person at a terminal how to install, while `--yes`, `--json`, CI and agents get the same output as before.
    - `context_pack` and `change_impact` stop ranking translation catalogs, file extensions and test notes ahead of the code a request names; a path or symbol named in the request is pinned as a required owner.
    - A version bump that reaches `main` is tagged and released by the new `Tag release` workflow, without a hand-pushed tag.

    [npm v3.3.0](https://www.npmjs.com/package/@bashbop/otito/v/3.3.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.3.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v3.2.0 published (2026-09-26)"
    The gates gate what they are given. No command, field or schema was removed.

    - `solumbe gate` and `solumbe review` take the repository from the positional or `--path`, in local and PR mode alike, and every gate, CLI or MCP, reads policy and governance from the `.solumberc.json` of the repository it gates, not the directory it runs in.
    - The GitHub PR gate reads whether a PR is open, merged or closed and reports it as `pr.state` and `pr.mergedAt`, so a merged PR is no longer gated as if it were still open.
    - A `--pr` or selector that names no PR is refused rather than gating the wrong thing. Over MCP a blank `pr` reads as no PR, and `pr_merge_readiness` with no selector gates the checked-out branch's PR again.
    - Repair hints name the `@nugehs` packages that exist, and `solumbe help` no longer says the legacy MCP tool names stop working at 3.0; [docs/02](02-mcp-agent-workflows/README.md#legacy-tool-names) maps each one to its canonical tool.

    [npm v3.2.0](https://www.npmjs.com/package/@bashbop/otito/v/3.2.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.2.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v3.1.0 published (2026-09-26)"
    The router gets graded, and the answer so far is that nothing can grade it yet. Nothing was removed or renamed.

    - `solumbe regret` replays a repository's history and grades the tier each half of the router would have given against the same `repaired` outcome `solumbe calibrate` uses; `--rescore` grades a new arithmetic on frozen model answers, with no checkout and no model call.
    - On three repositories no variant orders outcomes, and offline audits of the join and of a same-session outcome say why, so `solumbe route` stays advisory. [docs/18](18-model-routing/README.md) has the tables.
    - The route-prompt hook now keeps every decision it makes (`~/.solumbe/route-decisions.jsonl`, never the prompt text), so the router can be graded once enough real requests exist.
    - `solumbe attest` and `solumbe attest --verify` move post-merge attestation into the CLI, with versioned records and a reusable workflow.

    [npm v3.1.0](https://www.npmjs.com/package/@bashbop/otito/v/3.1.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.1.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v3.0.0 published (2026-09-25)"
    The first major since the Solumbe cutover. It follows 1.15.0 directly; the `v2.x` tags belong to earlier solumbe releases, from before the cutover.

    - **Breaking:** solumbe stops interpreting the request and leaves that to the model. `intent.hints`, `patterns` and `agentPrompt` leave the context pack, `implementationPlan` leaves impact, and `reviewPrompts` and `nextSteps` leave PR review. The ranked files, hotspots, risk flags and review targets they were derived from are unchanged. See [Migrating from 1.x](https://github.com/BASHBOP/solumbe/blob/main/CHANGELOG.md#migrating-from-1x).
    - `solumbe converge --head <ref>` and `solumbe gate --head <ref>` score exactly `base..head`, so a dirty checkout no longer counts as scope drift. A confirmed owner's own siblings and tests are in scope, not drift; on a 25-file commit that moved convergence from 55 to 84.
    - Working-tree convergence no longer scores untracked files by default (`--include-untracked` restores it).
    - Fixed: post-merge attestation attested the wrong commit, the context pack reported a working tree that no longer existed, and a manual run can now reset an orphaned audit ledger.

    [npm v3.0.0](https://www.npmjs.com/package/@bashbop/otito/v/3.0.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v3.0.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v1.15.0 published (2026-09-23)"
    - `model_route` is now an MCP tool, so every MCP host (Cursor, VS Code, Claude Desktop, Codex, Gemini) can ask for a tier, not only the CLI.
    - A request read rides the same System One call: what kind of work it is, which solumbe tool answers it, and which ranked files it needs. It is reported, never scored; the tier is identical with and without it.
    - `solumbe context --online` / `context_pack { online: true }` applies that read to a context pack: it relabels a confident intent and demotes files the model judges irrelevant. Off unless asked.
    - Any MCP host can appear on a local Realtime Canvas via `SOLUMBE_CANVAS_URL` and `SOLUMBE_HOST`, sending the request text only.

    [npm v1.15.0](https://www.npmjs.com/package/@bashbop/otito/v/1.15.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v1.15.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v1.14.0 published (2026-09-20)"
    - A `UserPromptSubmit` hook routes **every** request before any work starts, not only the ones a skill remembers to route. It advises the session and binds the model on delegated subagents; it cannot switch the session's own model, and says so.
    - Markdown is now indexed, so skills and docs pages can be found. A request naming a skill used to rank unrelated library files; it now ranks the skill first.
    - Fixed: a stale stored index kept serving after the indexer changed, including on offline workspace search. Indexes now carry a capability signature and are rebuilt when it moves.
    - Fixed: a doc *about* an auth-like area escalated a typo fix to premium; the router escalated two thirds of requests because it bumped on a model's self-reported confidence (now 0% escalation over nine requests); post-merge attestation died on `exit 128` and reported green when it had done nothing.

    [npm v1.14.0](https://www.npmjs.com/package/@bashbop/otito/v/1.14.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v1.14.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v1.13.1 published (2026-09-20)"
    - The documentation pack is rewritten for a reader rather than its author: seven overlapping pages become one [deterministic verification](./07-deterministic-verification/README.md) page, and navigation is grouped by what you are trying to do.
    - The model router skill can offer a realtime canvas, at most once per session.

!!! tip "v1.13.0 published (2026-09-20)"
    - `solumbe route <repo> "<request>"` scores a coding task **before** tokens are spent on it and recommends a cheap, mid, or premium tier. solumbe answers the repository half deterministically; a System One model answers the request half with calibrated probabilities. It ships **advisory**, because the weights have never been graded against an outcome.
    - The router is not the gate and cannot become one. It runs before work starts; the gate runs after the diff exists. An unreachable or unkeyed model costs a tier, never a verdict.
    - Fixed: zero matched files read as a *contained* change, so the request a repository understood least was routed to the cheapest model. Absence now fails safe to the ceiling.
    - Nineteen report commands moved onto the shared document renderer, so every command reads like `review` and `impact`.

    [npm v1.13.0](https://www.npmjs.com/package/@bashbop/otito/v/1.13.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v1.13.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v1.12.0 published (2026-09-19)"
    - Model routing arrived as a prototype alongside [the routing doc](./18-model-routing/README.md), dogfooded on a production application where the first pass routed *every* request to premium and surfaced two defects worth recording.
    - A question whose answer never moves carries no information however well calibrated it is: asked as a yes/no, "is this request ambiguous?" returned 0.57 to 0.81 for every request including a typo fix.

    [npm v1.12.0](https://www.npmjs.com/package/@bashbop/otito/v/1.12.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v1.12.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

!!! tip "v1.11.0 published (2026-09-19)"
    - `solumbe calibrate <repo>` grades the risk flags against the repository's own history, joining fix commits to the commits they repair by line overlap rather than by filename. Pointed at a small corpus it declines to answer most rows, which is the honest result.
    - `configuration` was two signals under one name: manifest-only commits were repaired at 0.42x the base rate, real config files at 2.03x. Merged, they cancelled out and inverted the risk bands, leaving `medium` changes *less* likely to be repaired than `low` at every window.
    - A zero-weight flag could gate a merge on its own; gating now requires a flag that scores.

    [npm v1.11.0](https://www.npmjs.com/package/@bashbop/otito/v/1.11.0) · [GitHub Release](https://github.com/BASHBOP/solumbe/releases/tag/v1.11.0) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.BASHBOP%2Fotito)

See [CHANGELOG.md](https://github.com/BASHBOP/solumbe/blob/main/CHANGELOG.md) for the full history.

---

## :material-file-document-multiple: Documentation

### Getting started

| Document | What it covers |
| --- | --- |
| [Local Core, Optional Hosted](./19-local-core-optional-hosted/README.md) | The three core commands, what the optional hosted pieces send and where, and the rules that do not change with a paid plan |
| [Context Foundation](./01-context-foundation/README.md) | Repository inspection, maps, search, context packs, and harnesses |
| [MCP and Agents](./02-mcp-agent-workflows/README.md) | MCP tools and agent-facing workflows |
| [Publishing to npm and the MCP Registry](./02-mcp-agent-workflows/publishing.md) | How Solumbe itself is released |
| [Codespaces and Tutorials](./08-tutorials-integration/README.md) | Setup and MCP onboarding alongside a tutorials repository |
| [Herdr Integration](./15-herdr-integration/README.md) | Context and merge evidence inside persistent agent workspaces |

### Using it

| Document | What it covers |
| --- | --- |
| [Trust-Layer Demo](./05-trust-layer-demo/README.md) | Solumbe as a repeatable review workflow |
| [Contributor Governance](./03-contributor-governance/README.md) | Protected review, CODEOWNERS, required checks, and merge authority |
| [Release Readiness](./04-release-readiness/README.md) | SemVer, changelog discipline, CI, and release gates |
| [Usage Dashboard](./10-usage-dashboard/README.md) | Local usage logging and performance trends |
| [Builder-Founder Loop](./06-builder-founder-operating-loop/README.md) | Session rhythm, evidence ledger, and governance ladder |

### How it works

| Document | What it covers |
| --- | --- |
| [Deterministic Verification](./07-deterministic-verification/README.md) | Why merge evidence is computed from the repository, never from the model that wrote the change |
| [AX Score Spec](./07-deterministic-verification/ax-score-spec.md) | How agent experience is scored |
| [Convergence Score Spec](./07-deterministic-verification/convergence-score-spec.md) | How intent is measured against the diff that appeared |

### Measurement

| Document | What it covers |
| --- | --- |
| [Calibration](./17-calibration-thesis/README.md) | Grading risk flags against a repository's own history |
| [Model Routing](./18-model-routing/README.md) | Spending a calibrated model on the request side without touching the gate |

### Reference

| Document | What it covers |
| --- | --- |
| [Evaluation Guide](./EVALS.md) | The accuracy, harness, and gate-effectiveness evals |
| [Glossary](./GLOSSARY.md) | Terms used across these pages |

---

## :material-graph: Context Flow

```mermaid
flowchart LR
    A[Repo or workspace] --> B[Inspect shape]
    B --> C[Map files and symbols]
    C --> D[Build context pack]
    D --> E[Agent or reviewer]
    E --> F[Change]
    F --> G[PR review context]
    G --> H[Solumbe gate]
```

## Quick Start

=== "Install"

    ```bash
    npm install -g @bashbop/solumbe@4.2.0
    solumbe doctor
    solumbe context "review this change" --path .
    ```

=== "No Global Install"

    ```bash
    npx -y @bashbop/solumbe@4.2.0 doctor
    ```

=== "Source Checkout"

    ```bash
    git clone https://github.com/BASHBOP/solumbe.git
    cd solumbe
    npm ci
    npm run ci
    node src/cli.js doctor
    ```

=== "MCP"

    ```bash
    solumbe mcp
    ```

Prove the deterministic merge gate against the committed valid and adversarial corpus:

```bash
solumbe eval --gate-effectiveness
```

---
