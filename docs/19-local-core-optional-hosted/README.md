# Local Core, Optional Hosted

> Solumbe never needs a server or an account. Everything it proves, it proves on your machine.

Solumbe installs from npm, runs on the machine where the checkout is, and reads only that checkout. There is no sign-up, no token, and no Solumbe server. Two things can be added to it, both opt-in and both with a local equivalent that works fully: a **hosted audit trail** for teams, and a **model read** from TypeSafe's Jev. Neither can touch the gate's verdict.

---

## The core

Three commands are the product. Everything else supports them.

| Step | Command | What it proves |
| --- | --- | --- |
| Before the edit | `solumbe context "<request>" --path .` | Which files, tests and validation commands the request actually needs, from the code, not from a rules file |
| Before the merge | `solumbe gate . --staged --base origin/main --request "<request>"` | A PASS / WARN / FAIL verdict on the **exact staged tree**, with a convergence receipt bound to base, parent and tree identity |
| For the reviewer | `solumbe pr . --base origin/main` | Risk flags, review targets and changed-file evidence a human can read before approving |

None of the three calls a model, opens a socket, or reads anything outside the repository. Run them twice and you get the same answer.

The supporting commands run the same way: `impact` and `converge` (the pieces `gate` is built from), `ax` and `route` (how well the repository serves an agent, and how much model the request deserves), `attest` (the post-merge record and its `--verify`), `map`, `repo`, `index` and `search` (repository shape), `harness`, `calibrate` and `regret` (how the gate's flags and the router's tiers have actually fared in this repository's history), `workspace-gate`, `init` and `doctor`. `solumbe help` lists all of them, and every one takes `--json`.

---

## What leaves your machine

| Feature | Sends | To | Default |
| --- | --- | --- | --- |
| The core commands and the 14 MCP tools | Nothing | — | On |
| `gate --pr`, `pass-pr`, `review --pr` | GitHub API reads through your own `gh` login: PR state, reviews, checks | GitHub | Only with `--pr` |
| `route`, `context --online`, `model_route` | The request text, the repository name, its AX and containment scores, the ranked file paths and any risk paths, under a `user-agent` of `solumbe/<version>`. Never file contents | TypeSafe's Jev, on your own `TYPESAFE_API_KEY` | Off; without a key the read is a labelled offline estimate |
| Delegated scanners: `gitleaks`, `semgrep` | Nothing. They run on this machine over a temporary copy of the changed files | — | Only when installed and the repository carries their config |
| Delegated scanner: `osv-scanner` | Package names and versions from the changed lockfiles, through your own `osv-scanner` | The OSV API | Off; only when named in `SOLUMBE_SCANNERS` |
| Realtime Canvas | The request text, the tool name and the host label | `127.0.0.1` only; any other address is ignored | Off |
| Telemetry | One JSONL line per run to `~/.solumbe/usage.jsonl` | Your disk | Off |
| Telemetry sharing | A smaller, allowlisted anonymous shape | Solumbe's public relay | Off, and a separate opt-in from local capture |
| Hosted audit trail | The attestation record: commit identity, verdict, and hashes. Never the diff or the source | Your organisation's store | Off; needs an org token |

---

## Delegated scanners

The gate's own secret rules and risk flags read paths, names and a short list of credential formats. They do not parse code or hold a vulnerability database, and they are not meant to grow into a scanner. When a specialist scanner is installed, the gate runs it and reports what it found as a check of its own.

| Scanner | Runs when | Check | A finding is |
| --- | --- | --- | --- |
| [gitleaks](https://github.com/gitleaks/gitleaks) | It is installed and the repository has a `.gitleaks.toml` | `Secret scan (gitleaks)` | `FAIL`. The report is redacted; only file, line and rule are repeated |
| [Semgrep](https://semgrep.dev) | It is installed and the repository has its own rules (`.semgrep.yml`, `.semgrep/`, `semgrep.yml`). The registry is never fetched | `Code patterns (semgrep)` | `FAIL` at `ERROR` severity, `WARN` otherwise |
| [osv-scanner](https://github.com/google/osv-scanner) | It is installed, a lockfile changed, and it is named in `SOLUMBE_SCANNERS` | `Known vulnerabilities (osv-scanner)` | `WARN`: it reports every known vulnerability in the lockfile, not only what the change introduced |

- **What a scanner sees.** A temporary copy of the changed files as the gate read them: the staged tree, the head commit, or the working tree. Not the whole checkout, so a finding is about this change.
- **`SOLUMBE_SCANNERS`** picks them. Unset runs each installed scanner the repository carries a config for. A list (`gitleaks,osv-scanner`) runs exactly those, config or not, and is the only way a scanner that uses the network runs. `off` runs none.
- **`SOLUMBE_GITLEAKS_BIN`, `SOLUMBE_SEMGREP_BIN`, `SOLUMBE_OSV_SCANNER_BIN`** point at a binary that is not on `PATH`.
- **Nothing is installed.** The gate never runs `npx` or downloads a scanner. One that is absent is simply not a check, unless it was named, which warns.
- **Not run** by `solumbe calibrate --gate`, which replays history with every optional analyzer off.

---

## The hosted audit trail

Every merge to `main` can leave a record of what shipped and under which review verdict. Each record hashes the one before it, so editing any stored field breaks every hash after it, and each is keyed to the exact merge commit, so a missing commit is visible.

**Locally, this is complete.** The [reusable post-merge workflow](https://github.com/BASHBOP/solumbe/blob/main/.github/workflows/attest.yml), which any repository can call with one `uses:` line, runs `solumbe attest` to append a record to a ledger branch in your own repository, and `solumbe attest --verify` walks the chain and exits non-zero if any record was altered. The evidence format is open JSON Lines with a `schemaVersion` on every record and on the verdict it came from, so an export is the file itself.

**Hosted adds what one repository cannot hold:** a ledger per organisation across every repository, chain verification and a list of missing commits on demand, an auditor-ready export, and retention you set once. It is opt-in per repository: nothing changes for a repository that never pushes, and a pushed record is a copy, never a move.

This is being piloted with teams that have SOC 2, ISO 27001 or regulated audits to pass. There is no published pricing. If that is your team, [open an issue](https://github.com/BASHBOP/solumbe/issues).

---

## The model read

Some properties of a request live in the sentence, not the code: how precisely it names what has to change, and how far the edits will reach. `solumbe route` asks TypeSafe's Jev those questions once, before work starts, and combines the answers with the repository's own deterministic half to recommend a cheap, mid or premium tier. `solumbe context --online` uses the same call to relabel a confident intent and demote files the model judges irrelevant.

It runs on your own TypeSafe key, billed by TypeSafe: about 2,000 to 2,800 input tokens and about a hundredth of a cent per call. Without a key, `route` still answers with a labelled offline estimate and `context` is unchanged.

Two limits hold by design. Solumbe recommends a tier; only the host can switch models, and Solumbe never claims one was switched. And nothing the model says reaches the gate: an unreachable or unkeyed model costs a tier, never a verdict. [Model Routing](../18-model-routing/README.md) has the measurements.

---

## The rules

These do not change with a paid plan.

1. Every hosted feature is opt-in and has a local equivalent that works fully.
2. The evidence format stays open and exports are lossless, so there is nothing to be locked into.
3. Nothing hosted touches the gate's local verdict.
4. Solumbe recommends a model tier; only the host can switch models.
5. No pricing is published until it has been set with the teams piloting the hosted trail.
