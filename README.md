# Solumbe

**Models generate the change. Solumbe proves whether it is safe to merge.**

Formerly **Òtítọ́** (`@bashbop/otito`), renamed in 4.0.0; the [CHANGELOG](CHANGELOG.md) maps every old name to its new one. <!-- rebrand-keep -->

[![CI](https://img.shields.io/github/actions/workflow/status/BASHBOP/solumbe/solumbe-ci.yml?style=flat-square&label=CI)](https://github.com/BASHBOP/solumbe/actions/workflows/solumbe-ci.yml) [![npm](https://img.shields.io/npm/v/@bashbop/solumbe?style=flat-square)](https://www.npmjs.com/package/@bashbop/solumbe) [![license: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A518.18-339933?style=flat-square)](https://nodejs.org/) [![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/bashbop/otito) [![Solumbe MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/BASHBOP/solumbe/badges/score.svg)](https://glama.ai/mcp/servers/BASHBOP/solumbe)

![solumbe demo](solumbe-demo.gif)

[![Solumbe MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/BASHBOP/solumbe/badges/card.svg)](https://glama.ai/mcp/servers/BASHBOP/solumbe)

Solumbe is a local-first, deterministic, model-agnostic trust layer for AI-assisted development. It builds task-aware repository context before an agent edits, scores how much a change actually touches, and gates merge readiness against the exact staged tree, with no server, no account, and no code leaving the machine.

It does not replace Claude Code, Codex, Cursor, Gemini, or any native agent harness. It runs beside them and keeps working as the models change underneath.

A passing local gate is never an automatic merge approval: hosted CI, GitHub review, CODEOWNERS, and the human release decision remain separate authorities.

## Install

```bash
npm install -g @bashbop/solumbe
solumbe doctor
solumbe install --host all
```

The last command connects Solumbe's MCP server to every agent host it finds: Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Gemini CLI and Kimi Code CLI. Add `--dry-run` to see the plan first, or name hosts with `--host claude-code,cursor`. Restart each host afterwards.

Or without installing: `npx -y @bashbop/solumbe doctor`.

## What it does

**Rank what a change actually touches**, from the request alone, with no model, no embeddings, and no network:

```console
$ solumbe impact . "add refund handling to checkout" --top 3

  concepts: money flow

   1.  src/payment/checkout.service.ts    score 155
       |- role: required
       |- path matches: checkout
       |- symbol matches: checkout, refund
       |- concept match: money flow (×1.4 + 6.0)
       |- risk: money flow

   2.  src/payment/stripe.webhook.ts    score 6
       |- role: advisory
       |- concept match: money flow (×1.4 + 6.0)
```

**Gate the exact staged tree**, and say precisely why:

```console
$ solumbe gate . --staged --base origin/main --request "add refund handling to checkout" --min-convergence 80

  [OK]    Changed files          1 changed file found.
  [OK]    Staged snapshot        Changed-file scope and convergence evidence are captured from the exact staged Git tree.
     |- Tree: 7d0b513dd256877d6bd309a6406468a9b1eaeedc
     |- Base: b776f04fcfbd02c8ce8d63e1a0c2450be58de039
  [OK]    Secret safety          No secret file paths and no credential values found in the changed content.
  [WARN]  Risk review            Risk-sensitive files changed; maintainer review should be explicit.
     |- src/payment/checkout.service.ts
  [OK]    Convergence            Task and diff satisfy the convergence requirement.
     |- Score: 100/100 (aligned)
     |- Receipt handle: rcpt_a8d31efae06e
     |- Subject tree: 7d0b513dd256877d6bd309a6406468a9b1eaeedc

  VERDICT  WARN
```

The convergence score is the part a model cannot grade for itself: it compares the stated intent against the files the diff actually changed, and produces a receipt bound to the exact base, parent, and staged-tree identity.

**Hold the change to what was declared.** Record the files a request is expected to touch before the edit, and the gate names any file that was never declared:

```console
$ solumbe declare . "add refund handling to checkout"
$ # ... the agent edits ...
$ solumbe gate . --staged --base HEAD --intent .solumbe/intent.json

  [FAIL]  Scope contract         Touched `src/auth/session.ts`, which was never declared. Amend the intent with the reason it belongs (`solumbe amend <file> --reason "<why>"`), or take it out of the change.
     |- Request: "add refund handling to checkout"
     |- Contract: fe655c2af2b31b7e3edec6aedd248b379235811d1228c829f87ff73796ace487
     |- Changed files: 3 (1 declared, 0 amended, 1 implied, 1 undeclared)
     |- Implied: tests/checkout.service.test.ts (owner-test of src/payment/checkout.service.ts)
     |- Undeclared on a risk-sensitive path: src/auth/session.ts [auth/security]
```

An amendment adds a file with its reason, hashed onto the contract, so a reviewer reads why the scope grew. Over MCP it is `change_impact` with `declare: true`, and `review_gate` with `intent`.

## The core

Three commands are the product. They call no model, open no socket, and read nothing outside the repository.

| Step             | Command                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| Before the edit  | `solumbe context "add refund handling" --path .`                             |
| Before the merge | `solumbe gate . --staged --base origin/main --request "add refund handling"` |
| For the reviewer | `solumbe pr . --base origin/main --out .solumbe/pr-review.md`                |

Nothing hosted is required, and nothing hosted can change a verdict. [Local Core, Optional Hosted](https://bashbop.github.io/solumbe/19-local-core-optional-hosted/) lists exactly what the optional pieces send, and where.

## Supporting commands

| Goal                               | Command                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Rank change blast radius           | `solumbe impact . "add refund handling" --top 12`                               |
| Score intent vs. execution         | `solumbe converge "add refunds" --path . --base HEAD --staged`                  |
| Score a committed change exactly   | `solumbe converge "add refunds" --path . --base HEAD~1 --head HEAD`             |
| Gate a product change across repos | `solumbe workspace-gate ../web ../api --request "ship change"`                  |
| Grade risk flags against history   | `solumbe calibrate . --window 30`                                               |
| Grade route tiers against history  | `solumbe regret . --window 30 --offline`                                        |
| Regrade a saved run, same answers  | `solumbe regret --rescore run.json`                                             |
| Score Agent Experience             | `solumbe ax . "add a new MCP tool"`                                             |
| Recommend a model tier             | `solumbe route . "add a new MCP tool"`                                          |
| Sharpen context with a model read  | `solumbe context "add a new MCP tool" --path . --online`                        |
| Inspect one repo                   | `solumbe repo . --json`                                                         |
| Build a code map                   | `solumbe map . --json`                                                          |
| Index and search local projects    | `solumbe index ~/projects --discover` then `solumbe search "events controller"` |
| Generate an agent harness          | `solumbe harness . --out .solumbe/harness.md`                                   |
| Run the MCP server                 | `solumbe mcp`                                                                   |

Every command takes `--json`, and `solumbe help` lists the full set with flags.

## MCP

Solumbe ships a stdio MCP server exposing **14 tools**: `repo_inspect`, `repo_map`, `repo_index`, `repo_search`, `context_pack`, `change_impact`, `agent_experience`, `model_route`, `convergence_score`, `review_context`, `review_gate`, `review_verdict`, `workspace_report`, and `repo_harness`.

```json
{
  "mcpServers": {
    "solumbe": {
      "command": "npx",
      "args": ["-y", "@bashbop/solumbe", "mcp"]
    }
  }
}
```

`solumbe install --host all` writes this entry for you, using absolute paths so hosts that do not inherit your shell `PATH` can still start it. Published in the MCP Registry as `io.github.BASHBOP/solumbe`. Repo-map lookups use an external per-user cache and never write into the inspected repository. Host-specific setup for Claude Code, Claude Desktop, Codex, Cursor, VS Code, Gemini CLI, and Kimi Code is in [MCP and Agent Workflows](https://bashbop.github.io/solumbe/02-mcp-agent-workflows/).

## How it compares

| Approach | Strengths | Where solumbe differs |
| --- | --- | --- |
| Sourcegraph / Cody context | Powerful hosted code search and embedding-based context across an org | Local-first and deterministic: no server, no account, no code leaves the machine, and the same query always yields the same packet |
| Hand-written `CLAUDE.md` / rules files | Curated, intent-rich guidance | Hand-written context goes stale; solumbe regenerates context from the actual code (symbols, imports, routes, tests) on every run and complements a short `CLAUDE.md` |
| `grep` / `ripgrep` | Fast, universal text matching | solumbe ranks whole files by task intent across paths, symbols, exports, and tests, then adds patterns and validation commands, producing a context packet rather than a list of matching lines |

## Documentation

Full command reference, agent workflows, release process, evaluation method, and the design theses behind the trust layer:

**[bashbop.github.io/solumbe](https://bashbop.github.io/solumbe/)**

## Contributing

```bash
git clone https://github.com/BASHBOP/solumbe.git
cd solumbe && npm ci && npm run ci
```

`npm run ci` is the full gate: format, lint, typecheck, version check, tests, coverage floors (70% lines / 60% branches / 75% functions), three evaluation corpora, dependency audit, and a packaged-tarball smoke test. Run it before requesting review.

Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). All changes need maintainer review; `main` requires passing gates and resolved conversations. Solumbe follows Semantic Versioning, so say whether a PR is no-impact, patch, minor, or major.

---

## Part of the toolchain

**solumbe** is one of four tools that form a deterministic trust layer for AI-assisted development. Each uses static analysis to answer a question people keep handing to an LLM.

- **solumbe** (this tool), for context: what does this change actually touch?
- [tieline](https://www.npmjs.com/package/@nugehs/tieline), for contracts: did the front end and back end quietly stop agreeing?
- [bouncer](https://www.npmjs.com/package/@nugehs/bouncer), for compliance: could you defend this to Ofcom?
- [aiglare](https://www.npmjs.com/package/@nugehs/aiglare), for governance: where can the model do something you can't undo?

More at [segunolumbe.com](https://segunolumbe.com). _static analysis, never the model._
