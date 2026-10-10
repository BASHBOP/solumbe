# Changelog

All notable changes to this project are documented here.

This project follows SemVer.

## [Unreleased]

### Added

- **The gate delegates to gitleaks, Semgrep and osv-scanner when they are installed.**
  - Each runs over a temporary copy of the changed files as the gate read them (staged tree, head commit or working tree) and reports as its own check: `Secret scan (gitleaks)`, `Code patterns (semgrep)`, `Known vulnerabilities (osv-scanner)`.
  - gitleaks runs where the repository has a `.gitleaks.toml`, and a finding fails with the file, line and rule, never the secret. Semgrep runs only with the repository's own rules, never the registry; an `ERROR` finding fails and anything else warns. osv-scanner sends package names to the OSV API, so it runs only when named in `SOLUMBE_SCANNERS`, and a known vulnerability warns.
  - `SOLUMBE_SCANNERS` selects them (`off`, or a list such as `gitleaks,osv-scanner`), and `SOLUMBE_<SCANNER>_BIN` points at a binary. Nothing is installed or fetched, and the local and PR gates both run them. `solumbe calibrate --gate` does not.
  - A repository with none of these set up sees no change.

- **A scope contract: declare what a request will touch before the edit, and the gate fails a file that was never declared.**
  - `solumbe declare <repo> "<request>"` records the files Solumbe predicts for the request, the commit and a contract hash in `.solumbe/intent.json`. `solumbe amend <file...> --reason "<why>"` adds files, each amendment hashed onto the one before it.
  - `solumbe gate`, `pass`, `pass-pr` and `review` take `--intent <file>` and add a `Scope contract` check. A changed file is declared, amended, implied by a declared file under convergence's existing rules (its test, a new sibling, an importer, the changelog), or undeclared, which fails with "Touched `src/auth/session.ts`, which was never declared."
  - Over MCP no tool is added: `change_impact` takes `declare: true` and `amend`, and `review_gate`, `review_verdict` and `convergence_score` take `intent`. Declaring through a tool writes nothing.
  - With an intent, `--min-convergence` and `--receipt` score against the declared files, and the convergence receipt carries the contract hash. A record whose request, files or amendments were edited afterwards does not verify and fails the gate.
  - The check is opt-in. Without an intent the gate is unchanged.

### Changed

- **A request that predicts no owner file is `inconclusive`, with no convergence score.**
  - `solumbe converge` and the MCP `convergence_score` tool scored such a request about 20 and banded it `drift`, the same for a correct change and an unrelated one. They now return `band: "inconclusive"`, `convergence: null` and `null` sub-scores, and the report prints "inconclusive" where the number was. A client that reads `convergence` as a number, or `band` as one of three values, must accept the new ones.
  - The report lists the changed files as "changed, not predicted" rather than as scope drift, and still names any on a risk-sensitive path.
  - With `--min-convergence` above 0, the gate's `Convergence` check reports `WARN` for an inconclusive result where it reported `FAIL`. A pipeline that blocks only on `FAIL` no longer blocks an ungrounded request. A floor of 0 passes, and a receipt that does not match still fails.
  - `solumbe calibrate --gate` grades `inconclusive` as a fourth band. Its ordering claims still read `aligned`, `partial` and `drift`, and published band figures will move, since some `drift` commits were ungrounded.
  - The convergence engine is 0.6.0, so receipts from 0.5.0 do not recompute.

### Fixed

- **`Secret safety` stops flagging a placeholder in a source-file comment.**
  - The heuristic `hardcoded credential` rule no longer runs on a line that is only a comment (`//`, `/*`, a `*` continuation or `#`). It warned on `src/lib/secret-scan.js:16`, the comment that explains the rule with `accessToken: 'valid-access-token'`.
  - Known secret formats (AWS, Stripe live, GitHub, Slack and the rest) still fail on a comment line.
  - A trailing comment, `#name` (a private field), `*name()` (a generator method) and a line that closes a block comment before a statement are still code. Text scanned without a file name, such as redacted validation output, keeps the rule on every line.
  - A commented-out assignment of a real credential that has no vendor format no longer warns.

## [4.4.0] - 2026-10-10

A check the gate cannot run reports `SKIPPED` instead of `WARN`, so a clean change can return `PASS`, and `solumbe calibrate` grades the gate's verdict against what happened next. No command or field was removed. A check's `status` gains the value `SKIPPED` and the verdict `schemaVersion` moves to 3, so a client that reads `checks[].status` must accept it.

### Added

- **`solumbe calibrate --gate` grades the gate's verdict and the convergence band against history.**
  - It replays the real local gate and the real convergence score on each commit, checked out into a temporary worktree, and joins the result to the same `repaired` outcome `solumbe calibrate` uses for risk flags.
  - It reports the repair rate for PASS, WARN and FAIL, the alarm rate, the share of alarms on changes nothing repaired, a row for each check that warned, and the rate for each convergence band. Rates carry a Wilson 95% interval and are withheld under 30 commits.
  - On this repository: 111 commits, PASS repaired 16.0%, WARN 36.7%, with overlapping intervals, and an alarm on 27.0% of changes.
  - It shows whether a verdict separates repaired changes from the rest, not whether the gate prevents a repair. The optional analyzers are not run against historical trees.
- **`solumbe calibrate --follow-through` reports how often a warning had cleared on the next run.**
  - It reads the local usage log, pairs each WARN or FAIL with the next gate run on the same repository inside 60 minutes, and reports per check how often that check then passed. A convergence score below `aligned` is paired with the next score of the same task.
  - Gate and convergence events in the usage log now record each check's status under its name, whether the gate was local or a pull request, and hashes of the repository root, the changed-file set and the request. No path or request text is logged, and none of it is shared.
- **`SOLUMBE_CHECK_MODE=trial` runs a trial with a control arm on the checks an agent makes before it commits.**
  - Off by default. Each change falls in a shown or a withheld arm by a hash of the repository root and its head commit; `SOLUMBE_CHECK_SHOWN_SHARE` sets the split.
  - In the withheld arm the MCP `convergence_score` and local `review_gate` tools compute and log the result and tell the agent only that it was recorded. A blocking FAIL is shown in both arms. The command line, the pre-commit hook, CI and the pull request gate are unaffected.
  - `solumbe calibrate --trial` grades the arms on the first commit made on each head. `scripts/hooks/check-outcomes.mjs` grades them on corrections and rework in the same Claude Code session.

### Changed

- **A check that cannot run in the current mode is `SKIPPED`, not `WARN`, and never moves the verdict.**
  - Local `review_gate` reported `Review state` as a `WARN` on every run, and `Compliance controls` as a `WARN` whenever bouncer runs only in CI. A clean local change could never return `PASS`.
  - Both now report `status: "SKIPPED"` with a "Not checked locally" summary. `verdict` is still `PASS`, `WARN` or `FAIL`; only a check's `status` can be `SKIPPED`, so a client that reads `checks[].status` must accept the new value.
  - A configured bouncer whose binary cannot be found stays a `WARN`: that install is actionable. Staged mode still reports `Review state` as `PASS`.
  - The terminal, markdown, `review_verdict`, `solumbe pass-pr` and herdr trust-pane reports show a skipped check on its own line (info, not warning). A clean local run now ends "ready for a PR; skipped checks run there".
  - `solumbe eval --gate-effectiveness` accepts `SKIPPED` in `expectedChecks`.
  - The pull request gate reports it too, for evidence GitHub did not supply: `Review decision` when GitHub returns none, `CODEOWNERS` when the file cannot be read or an owner cannot be matched to a reviewer, and `Branch protection` when the base branch or the protection API is unavailable. A clean pull request ends "ready to merge once review decision is confirmed".
  - The `company` and `high-risk` profiles are unchanged: they require those checks to be `PASS`, so a `SKIPPED` one still fails them. An unprotected base branch, a missing CODEOWNERS file, missing status checks and a missing approval under solo governance still `WARN`.
  - The verdict `schemaVersion` is now 3, for the new check status.

### Fixed

- **`Release discipline` fires only when a `version` field changes.**
  - It read the version from the working tree and compared it with the base, so under `--head`, `--staged` or a PR whose checkout had moved on, any `package.json` edit looked like a version bump. 20 of the 22 `FAIL`s in a 495-PR backtest were dependency edits.
  - It now reads the version from the exact subject: the head commit tree, the staged index tree, or the PR head commit. It falls back to the working tree only when that copy is unavailable.
  - A `package.json` with no `version`, and a version mismatch or non-SemVer value the change did not introduce, no longer trip it.
  - In a Release Please repository (a `release-please-config.json` or `.release-please-manifest.json` at the base), a version change outside a release PR is reported as "Version bumped by hand in a Release Please repository", not as a missing changelog entry. A release PR is recognised by its `release-please--*` branch or by a change to the manifest.
- **`Secret safety` stops flagging placeholders.**
  - `.env.production.local.example` and every other `*.example`, `*.sample`, `*.template` or `*.dist` file are templates, not secret files. Only `.env.example` and its three siblings were exempt before.
  - The heuristic `hardcoded credential` rule no longer runs on test files (`*.spec.*`, `*.test.*`, `__tests__/`), documentation, fixture directories or templates, where `accessToken: 'valid-access-token'` is a made-up value.
  - Known secret formats (AWS, Stripe live, GitHub, Slack and the rest) still fail in every file, test files included.

## [4.3.0] - 2026-10-10

The MCP server tells every host which tool to call at each stage of a task, and `convergence_score` stops calling a change's own tests, changelog, fixtures and docs drift. It also follows `@/` alias imports and matches the joined spelling of a camelCase product name (`OpenPanel` → `lib/openpanel.ts`). No command, field or schema was removed. Convergence receipts move to engine `0.5.0`, and the index cache moves to version 12, so existing indexes rebuild once.

### Added

- **The MCP server sends its workflow to every host.** `initialize` now returns `instructions` that say which tool to call at each stage of a task: `context_pack` first, a `repo_search` retry when the pack is weak, `change_impact` before editing, `convergence_score` before each commit and `review_gate` before a pull request. The workflow used to live only in one host's instruction file, so an agent on another host never saw it. The text is defined once in `src/lib/agent-workflow.js`, and a test fails if it names a tool the server does not list.

### Fixed

- **`convergence_score` no longer calls a change's own tests, changelog and eval data drift.**
  - A test whose name adds a suffix to a confirmed file (`mcp-dispatch.test.js` for `mcp.js`) counts as its test.
  - With at least one confirmed owner, the changelog entry and fixture or eval data (`evals/fixtures/…`, `evals/corpus.json`) are in scope under the new `owner-changelog` and `owner-test-data` rules.
  - A ranking fix that added an eval fixture and recorded its changelog scored 52/100, with every fixture file listed as drift.
  - The convergence engine moves to `0.3.0`, so `0.2.0` receipts are not recomputed.
- **The gate no longer treats fixture files as risk-sensitive.** `isGateRiskPath` skips `fixtures`, `__fixtures__`, `testdata` and `test-data` directories, as it already did for tests and docs. A fixture repository's `middleware/admin-auth.ts` had made `review_gate` warn. Real code under an `eval/` or `evals/` folder still gates.
- **A repository deleted from disk no longer fails every search.**
  - `repo_search` lists it under `stale`, with a hint, instead of `errors`.
  - The next `solumbe index` drops it from the catalog and reports it under `pruned`.
- **A request that names a tool reaches the code that implements it.**
  - A registry names its tools as strings: `{ name: "convergence_score" }` in a tool table, and `case "convergence_score":` in the switch that dispatches it. The indexer only knew declarations, so `context_pack` missed `src/lib/mcp.js` for a request about MCP tools, and `convergence_score` called `converge.js` drift in a change to it.
  - Identifier-shaped strings in those two places are now indexed as `registered` symbols, together with the functions their entry calls.
  - A request naming one pins the module that exports the called function, through the registry's own imports (`converge.js` for `convergence_score`). The registry is surfaced as its definer.
  - Display names such as "Convergence Score" are not indexed.
  - The index cache moves to version 12, so existing indexes rebuild once.
- **A failing accuracy eval says FAIL instead of crashing.** The closing line called `.find` on the accuracy eval's cases, which are grouped by suite (`{ retrieval, risk }`), so a run below threshold threw `data.cases?.find is not a function`.
- **`convergence_score` reads what the change adds to place a file.**
  - A test or source file whose added lines import a confirmed file is in scope (`owner-test`, and the new `owner-import`). A source file still needs no risk flag that file lacks.
  - A doc whose added lines name a confirmed or inferred file is in scope (`owner-doc`).
  - #273 had four files wrongly called drift: `ast.js`, which now imports a helper from `text.js`; a test named `registered-names.test.js`; its gap note; and `docs/EVALS.md`. Its score moves from 59 to 70, with scope and risk alignment both at 100.
  - The convergence engine moves to `0.4.0`.
- **`convergence_score` follows root-alias imports.**
  - The `owner-import` rule, and tests placed by import, now resolve `@/…`, `~/…` and `#/…` specifiers from the repository root or `src/`, the form Next.js and Vite apps use. They only followed relative imports before.
  - On the bashbop-event-web analytics change (BASHBOP/bashbop-event-web#622), every screen wired to the confirmed `utils/analytics.ts` through `@/utils/analytics` counted as drift: 25 drift files, scope 16, 51/100. Now 10 drift files remain, scope is 68 and the score is 69/100. The ten that remain are six risk-flagged files, which still need their own review by design, and four that changed without adding an import.
  - The convergence engine moves to `0.5.0`, so `0.4.0` receipts are not recomputed.
- **A request naming a camelCase product reaches the file named after it.** "OpenPanel" splits into `open` and `panel`, while the file is `lib/openpanel.ts` and the package `@openpanel/react-native`. `context_pack` and `change_impact` now also weigh the joined spelling. On the bashbop-mobile-app request, `lib/openpanel.ts` rose from ninth to third in `context_pack`, and into `change_impact`'s top eight from outside its top twelve.
- **A user config from before the rename applies again.** The rename moved the user config from `~/.config/otito/config.json` to `~/.config/solumbe/config.json` with no fallback, so settings left in the old file, a telemetry opt-in among them, stopped applying and local usage capture went quiet with nothing reported. When the Solumbe file is missing, the old one is read; both honour `XDG_CONFIG_HOME`. The first `solumbe config set` or `solumbe telemetry` write starts from the old settings, and the old file is left in place. `solumbe doctor` warns while the old file is in use and prints the command that moves it, `solumbe config` names the file it read, and `doctor --json` carries a new `userConfig` field.
- **`solumbe route` starts one git process instead of six.** AX inspected the whole repository (a file listing plus four git metadata calls) for four fields it reads from `package.json` and the top-level directories, and `route` runs AX on every routed prompt. Where each process launch is slow, the six launches pushed `route` past the `UserPromptSubmit` hook's six-second budget, so the hook gave no tier and logged no decision. AX now reads those fields through `inspectRepoBasics`, which runs no git; its score is unchanged.

## [4.2.1] - 2026-10-06

Context packs rank by distinct request words, and a failing gate says what failed. No command or schema was removed. The gate check gains one optional field, and `gate --out` prints a verdict line.

### Fixed

- **A word the request repeats counts once.** "session replay / session playback … errors … error boundary, global error handler" counted `session` twice and `error` four times. Methods matching only `session` (`createSession`, a cache's `get` and `set`) then scored as two-word matches, led the hotspots, and pushed `app/global-error.tsx` out of the pack. A plural and its singular (`errors`, `error`) are also one word.
- **The words of a camelCase name count together.** "OpenPanel" splits into `open` and `panel`, and "PostHog" into `post` and `hog`, like any identifier. On its own, `open` made a seller checkout service a primary file, and `post` matched `postAiStream`. Each word now counts only when another word of the same name also matches, unless the request also uses it on its own.
- **The action verb counts only in a symbol's own name.** `add` from "add session replay…" matched a local variable inside `handleCheckoutSessionCompleted`. A symbol named for the action (`createOrder` for "create an order") still matches.
- **A failed validation command shows what failed.** `gate --run-validation` printed only `tests: failed (exit 1; stdout sha256 …; stderr sha256 …)`, so finding the failing test meant running the suite again. The check now lists the failing tests the runner announced (TAP and node:test, Jest, Vitest, pytest, Go) and shows up to 12 lines of output from the first of them. When no runner marker is recognised it shows each stream's tail instead. The excerpt appears in the terminal and markdown reports and as `excerpts` on the check in JSON. Lines are capped at 200 characters and stripped of terminal escapes, the deleted snapshot directory is shown as `.`, and any line the secret scanner would flag is withheld. The digests stay, and the validation evidence and its receipt still carry digests only.
- **`gate --out` and the pre-commit hook say FAIL.** Writing the report printed only `Pass report written: <path>`, which read as a pass while the hook refused the commit. `--out` now prints `Gate verdict: FAIL — blocked by <check>: <summary>` (or `WARN …` / `PASS`) and then `Gate report written: <path>`. The hook scaffolded by `solumbe init` also prints `FAIL — commit blocked by the staged safety gate`. Hooks scaffolded before this release show the verdict line without re-running `init`.

## [4.2.0] - 2026-10-04

Fixes from running Solumbe's review tools on three bashbop repositories and checking every answer against the code, and reviews that look into a repository's companions. No command, field or schema was removed; the verdict `schemaVersion` moves to 2 for one added field.

### Added

- **The gate reads what a migration does to existing data.** A new `Migration safety` check warns when a changed SQL migration rewrites rows (`UPDATE … SET`), deletes them, truncates or drops a table, or drops columns, and names the table and whether the statement has no `WHERE`. A migration that reset every verified organiser to unverified passed the gate as an ordinary schema file; the check now points at it. Comments are ignored, additive migrations pass, and the check runs in both the local and the GitHub PR gate.
- **`review_verdict` and `change_impact` point into companion repositories.** When a repository's `.solumberc.json` lists `companions` (`"companions": ["../api"]`), both rank the same request in each companion, without a diff, and name its top three files with their scores and risk flags: under `impactSummary.companions` in the verdict and `companions` in the impact report, with a line in `solumbe review` and a section in `solumbe impact`. A review of a web change whose rule the API also decides now names the API file. A dogfood review of bashbop-event-web, which decides "BVN required" from the user's location while bashbop-api decides from the profile country, never surfaced `src/paystack/paystack.service.ts`. The verdict carries the field only when companions are configured and a request is given. The leads do not change the verdict, its confidence, or what an attestation record stores.

### Changed

- **The verdict `schemaVersion` is now 2**, for the added `impactSummary.companions`. Attestation records written from now on carry `verdictSchemaVersion: 2`; earlier records verify unchanged.

### Fixed

- **Changed files are ranked by score.** With a diff base, `change_impact` listed changed files in path order, so a review of bashbop-event-web opened on an untracked dotfile README at score 0 and `review_verdict`'s top five were all unrelated. Changed files still lead the list, now highest score first.
- **`review_verdict --head` reviews exactly base..head.** `head` reached review context but not impact or the gate, which counted the working tree: a merged 51-file PR was reported as 88 files, untracked scratch output included. Impact and the gate now read the head commit's file set, and the MCP tool takes `head`. `change_impact` takes `includeUntracked` (default true) to review tracked changes only.
- **`.env.example` no longer fails the secret check on its name.** Committed env templates (`.env.example`, `.sample`, `.template`, `.dist`) name variables; removing two from one hard-failed a gate. They are still scanned, and a credential value inside one still fails.
- **A head-bound gate no longer tells you to unstage committed files.** Risk-review advice to run `git restore --staged` now appears only for a staged gate.
- **Prisma schemas and SQL migrations are mapped.** Both were outside the code map, so a migration that rewrote existing rows was "unmapped" in the change it belonged to. `schema.prisma` is a `schema` file indexed by its models, enums and fields; `.sql` under `migrations/` is a `migration` file indexed by its tables and columns. Other SQL, such as dumps and seeds, stays unindexed.
- **Go modules have validation commands, entrypoints and test guardrails.** `harness` lists `gofmt`, `go vet`, `go build` and `go test` for a module with `go.mod`, `main.go` and `cmd/<name>/main.go` are entrypoints, and AX counts `_test.go` files as tests. A file's extension no longer path-matches a request, so "port it to Go" stops matching every `.go` file.
- **A multi-repo context pack keeps the small repo.** A request about a 6-file Go service named it ("the Go fee server") and got five files of the 1,000-file API that calls it. A two-letter folder segment such as `go` now names a repo when the request writes it as a name (`Go`, not "go to settings"), and each repository with a strong match keeps one primary slot.
- **Inflected action words set the intent.** "reviewing", "fixed", "creating" and "debugging" read as review, fix, create and debug; `rename`, `remove` and `migrate` are actions. "only", "just", "also" and "via" no longer match code.
- **Money flow is flagged on the code that moves money.** `fee`, `pricing`, `payout`, `paystack` and `settlement` paths carry the flag, so `internal/pricing/pricing.go` does; a plan document or a golden fixture that mentions Stripe no longer raises the impact's money-flow risk on its own.
- **Related files are the most relevant imports.** A controller importing forty services listed the first eight in import order, so a Paystack change named affiliates and analytics modules as expected fan-out. Related files are now ordered by their own score.
- **The workspace report describes the repositories it was given.** Its notes named every workspace "Next frontend plus Nest/Prisma API" and ended on an internal TODO; they now list each repo with its main language and say which are behind their upstream.
- **A checkout behind its upstream says so.** Reports show `main @ ccbba9f (clean, 10 behind origin/main)`, as of the last fetch, and the context pack lists it as a conflict. The four copies of the git one-liner are now one.

## [4.1.0] - 2026-10-01

One command connects Solumbe to every agent host on the machine, and host configs now start under GUI hosts. No command, field or schema was removed.

### Added

- **`solumbe install --host` connects Solumbe to your agents in one step.** `--host all` finds Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Gemini CLI and Kimi Code CLI on the machine and adds a `solumbe` MCP server to each; name hosts instead (`--host claude-code,cursor`) to configure only those. Before writing anything it starts the server once and checks that it answers an MCP `initialize` request, so a host is never given a command that cannot start. JSON configs are merged in place with a `.solumbe.bak` backup, and a config it cannot parse is left untouched; Claude Code and Codex go through `claude mcp add-json` and `codex mcp add`. Leftover entries under another name that still launch Solumbe or Òtítọ́ are reported, never removed. `--dry-run` prints the plan, and `--canvas <url>` adds the Realtime Canvas variables. Re-running it repairs hosts still pointing at a pre-4.0.0 `otito` path.

### Fixed

- **Post-merge attestation keeps to main's first-parent line.** A PR into `develop` whose CI finished after it merged resolved to its `develop` merge commit, and reconciliation walked `develop`'s first-parent line into the main ledger (four records on 2026-09-29), so every main attestation since v3.4.0 failed with a coverage gap. The resolve step now attests a PR's merge commit only when the PR merged into `main`, and `reconcile-attestations.sh` refuses any target whose first-parent history does not pass through the ledger tip, before writing a record.
- **README Glama badges point at the Solumbe listing.** The score badge and the card linked the pre-rename `BASHBOP/otito` listing on Glama; both now use `BASHBOP/solumbe`, and `rebrand:check` no longer lets the old Glama URL through.
- **Host configs start under GUI hosts.** They now pin the absolute `node` binary and CLI path instead of a bare `solumbe` command. GUI hosts such as Claude Desktop, Cursor and VS Code do not inherit a shell `PATH`, so under nvm, Volta or Homebrew the documented `"command": "solumbe"` could not start. When run through `npx`, the installer starts the server through `npx` rather than pinning a path inside the npx cache.
- **The MCP setup guide has a Claude Code section.** The README linked to one that did not exist.

## [4.0.0] - 2026-09-30

Òtítọ́ is now Solumbe: the package, binary, MCP server, config files, evidence folders and environment variables all take the new name, with no fallback to the old ones. Behaviour is unchanged from 3.5.0.

### Changed

- **Òtítọ́ is now Solumbe.** Every name moves in one cut, with no fallback to the old ones:

  | Was | Now |
  | --- | --- |
  | npm `@bashbop/otito` | `@bashbop/solumbe` |
  | CLI `otito` | `solumbe` |
  | MCP Registry `io.github.BASHBOP/otito`, host key `otito` (`mcp__otito__*` tools) | `io.github.BASHBOP/solumbe`, `solumbe` (`mcp__solumbe__*`) |
  | Config `.otitorc.json`, gate config `otito.gate.json` | `.solumberc.json`, `solumbe.gate.json` |
  | Evidence `.otito/`, user state `~/.otito/` | `.solumbe/`, `~/.solumbe/` |
  | Environment `OTITO_*` | `SOLUMBE_*` |
  | Skills `otito-*`, secret marker `otito:allow-secret`, PR comment marker `<!-- otito-pr-review -->` | `solumbe-*`, `solumbe:allow-secret`, `<!-- solumbe-pr-review -->` |
  | Repository `BASHBOP/otito`, docs `bashbop.github.io/otito` | `BASHBOP/solumbe`, `bashbop.github.io/solumbe` |

  To upgrade, install `@bashbop/solumbe`; rename `.otitorc.json`, `otito.gate.json` and any `otito:allow-secret` markers; move `.otito/` and `~/.otito/`; rename `OTITO_*` variables; and point MCP host configs at the new package and server key. Two things keep the old name on purpose: telemetry sharing still posts to bashbop-api's `analytics/otito` route with an `otito_version` field, because both sides of that contract have to move together, and links to releases before 4.0.0 still point at `@bashbop/otito`, where those versions live.

- A manually run workflow, `retire-legacy-listing.yml`, marks every version of the pre-rename MCP Registry listing deprecated and points it at `io.github.BASHBOP/solumbe`. It refuses to run until the new listing is live.
- The Release workflow skips `npm publish` when npm already has the version, instead of failing and taking the GitHub Release and MCP Registry jobs down with it. A new package name's first publish has to be done by hand, because npm Trusted Publishing is configured per existing package; re-running a release after a later job failed also hits this.
- `scripts/rebrand.mjs` (`plan`, `apply`, `check`) made the rename from `.rebrandrc.json`: case-preserving, git-moved paths, idempotent. `npm run quality` now runs `rebrand:check`, which also flags accented spellings no alias covers, so the old name cannot creep back outside the CHANGELOG and the preserved links.

## [3.5.0] - 2026-09-30

Model routing can now make a share of requests follow the tier it picks instead of only recommending one, and on Claude Code the premium tier names the model that actually runs. No command, field or schema was removed.

### Added

- Enforce mode for model routing. `OTITO_ROUTE_MODE=delegate` puts a share of requests (`OTITO_ROUTE_DELEGATE_SHARE`, 0 to 1, default 0.5) in a delegate arm, where the Claude Code prompt hook tells the session to do the tool work in a subagent on the routed tier, the only model switch a session can make; the rest are the control. Arms are assigned by the prompt's hash, so the same prompt always lands in the same arm. Each logged decision records its arm, `route-outcomes.mjs --arm delegate|control|advisory` grades one arm, and `otito route` shows the arm and the subagent model in the terminal and as `enforce` in JSON. Without the variable, routing stays advisory and nothing changes.

### Fixed

- On the `claude-code` host, `otito route` and the route prompt hook name the premium model `claude-opus-5-5` instead of `claude-opus-5`. The Agent tool's `opus` alias runs Opus 5.5, so the old name was never the model that ran.

## [3.4.0] - 2026-09-29

One context pack can now span a web app and its API, change risk stops counting files that are only loose leads, and `otito route` shows each question's own confidence and says plainly when it has no recommendation. No command, field or schema was removed.

### Added

- `context_pack` and `otito context` read a repository's `companions` too: list sibling repositories in its `.otitorc.json` (`"companions": ["../api"]`, resolved against that file) and one pack covers them all, so a web bug whose cause is in the API response no longer gets a web-only pack. Explicit `paths` still win; a companion that is not checked out is skipped.
- `otito route` shows each Score question's own confidence (specificity, blast radius) next to its score, not only the weaker of the two. Display only: confidence still never moves the tier. `scoring.confidences` carries both.

### Fixed

- `change_impact` no longer raises a risk from a domain that only an advisory lead touches. An RSVP gallery fix ranked the RSVP payment-success page as a loose lead and warned of a money-flow change; risks now come from required and supporting files, plus any changed file.
- `otito route` and the route prompt hook say **no recommendation** when otito matched no files, instead of presenting a read of an empty set as a tier. The fail-safe tier is still named, and `tier` in JSON is unchanged (premium), so callers that read only `tier` behave as before.
- **`version:check` catches a stale docs site.** `docs/index.md` opens with a `**vX.Y.Z** is published` banner, which replaced the `**Status:** v` line the release sync and drift check looked for, so neither saw it: 3.3.0 was released on 2026-09-27 with `version:check` green while bashbop.github.io/otito still announced v3.2.0 and had no 3.3.0 entry under What's New. `syncPinnedDocVersion` now rewrites the banner, `findPinnedDocVersionDrift` reports it, and a new `findWhatsNewDrift` fails `version:check` when What's New has no `vX.Y.Z published` entry for the `package.json` version (it is written by hand, so the sync cannot add it). The site gets its v3.3.0 banner and entry.
- `context_pack` reads a request that says "bug", "broken", "crash" or "regression" as debugging instead of an ambiguous action, and in a multi-repo query that names one repository by a word from its folder name, that repository's files rank first.
- `change_impact` no longer drops a UI page (`page.tsx`, `layout.tsx`) from required owners because the request used no API wording; controllers, DTOs and API routes still need it. A query term that recurs across most of the repository counts for less, and utility-file owners compete on score with conventional owners instead of only being a last resort.

## [3.3.0] - 2026-09-27

The terminal output gets colour and shape it didn't have before. `otito` resolves one glyph set per run (plain Unicode by default, ASCII in CI, emoji opt-in) and builds tables, trees and coloured lists from shared string-building primitives instead of ad-hoc strings; every bullet and list item now dims its marker the way a box border is dimmed, matching the headers, boxes and closing line that already had colour. `otito install` prompts a human at a TTY for how to install, with a short personalized pitch first, while every non-interactive caller (`--yes`, `--json`, CI, agents) is unaffected. No command, field or schema was removed.

### Added

- **List and bullet items pick up the renderer's colour, not just headers, boxes and the closing line.** `bullet()` in `src/lib/render/fancy.js` and every formatter that built a line as `` `${renderer.glyphs.item} ${text}` `` by hand (the shared summary behind `install`/`init`/`discover`/`index`/`catalog`/`search`/`repo` in `src/lib/output.js`, `context_pack`'s Commands section, `change_impact`'s suggested tests and risk hotspots, and the Context evidence lines in `pass`/`pass-pr`) now dim the marker the same way a box border is dimmed, when colour is on. Colour off (piped output, `NO_COLOR`, CI) is unaffected. `tests/fixtures/render-fancy-golden.json` and `tests/fixtures/formatters-golden.json` were regenerated on purpose; every changed line is a bullet or list-item marker gaining `\x1b[2m...\x1b[0m`, nothing else moved.
- **`otito install` asks a human at a TTY how they want to install, with a personalized one-line pitch first.** No `--global`/`--link`/`--yes`/`--json` and a real terminal (`process.stdin.isTTY`) prompts once for plan-only, global (`npm install -g .`) or link (`npm link`), preceded by a greeting built from local `git config user.name` (no network, nothing sent anywhere) and three lines on why a grounded, deterministic local context layer is worth having. Any explicit mode flag, `--yes`, `--json`, CI, or an MCP/agent caller skips both the pitch and the prompt and gets the exact plan-driven output `install` already gave, unchanged. New `promptChoice` in `src/cli.js` mirrors the existing `promptYesNo` pattern from `init`; `getWelcomeMessage` lives in `src/lib/install.js`.
- **The renderer resolves one glyph set per run and offers a set of shared string-building primitives.** `createRenderer` now picks `emoji`, `ascii` or `unicode` once and exposes the choice as `renderer.glyphMode` with every mark it prints in `renderer.glyphs`: status and verdict marks, box drawing, tree branches, the flow arrow, bullets, the section and tip markers and the dashes. Nothing visible changes yet: the interactive default is still `emoji`, and `emoji: false`, `NO_EMOJI` and `CI` still give `ascii`. `unicode`, which prints `✓ ! ✗`, box drawing and arrows and nothing that matches `\p{Extended_Pictographic}`, is reached only through the explicit `glyphs: "unicode"` option; it becomes the default in a later release. New string builders sit beside `header` and `verdict`: `table` (borderless, left-aligned, measured in display cells, with a dim rule under the head row and a last column that wraps to the terminal width), `tree`, `flow`, `code`, `ref`, `list`, `phase` and `close`, plus `paint` and a palette with `magenta` and `blue`. `visualWidth`, `padRight` and `wrap` are exported.

### Changed

- **The default terminal look is plain Unicode, with no emoji.** An interactive terminal now gets `✓ ! ✗`, box drawing and arrows; the header boxes no longer carry a decorative emoji, and nothing in the default output matches `\p{Extended_Pictographic}`. CI logs, `NO_EMOJI=1`, `--no-emoji`, `emoji: false`, the `minimal` theme and, new in this release, `TERM=dumb` keep ASCII glyphs, so anything already reading otito's plain output sees no change. `--emoji`, `emoji: true` and `OTITO_EMOJI=1` opt back into the emoji look exactly as it was. The `high-contrast` theme keeps its bright palette and stops forcing emoji. `TERM=dumb` is detected in the renderer beside `CI` and `NO_EMOJI`, not in config, so the sources `otito config list` shows stay honest.
- **Every command that prints for a person ends with one closing line.** `Verified.`, `Tests pass.`, `Runs without errors.` or `Not verified — manual check needed: <what>.` (`-` in ASCII). Advisory commands (`repo`, `discover`, `index`, `catalog`, `search`, `ax`, `calibrate`, `converge`, `regret`, `map`, `matrix`, `pr`, `report`, `workspace`, `harness`, `data-access`, `structure`, `deps`, plain `eval`, `config list`, `config get`, `telemetry status`, `install` without a flag) end with `Runs without errors.`. Writers (`init`, `install --global|--link`, `config set`, `telemetry on|off|clear|share`, `dashboard`, `obsidian`, `attest`, `pr --comment`) end with `Verified.` once what they wrote re-reads, and name the file or step when it does not. Health checks (`attest --verify`, `eval --accuracy|--harness|--gate-effectiveness`) are verified when the chain is intact or the thresholds hold, and name the record or check that failed. `workspace-gate` ends the way a gate does: `Tests pass.` when `--run-validation` ran and passed, `Verified.` on PASS, otherwise the check that blocked or warned. `--json`, `--markdown`, `--mermaid`, the `--out` messages, `config get <key>`, `--version`, `help` and `mcp` carry no closing line. The gate, review, context, impact, route and doctor formatters get theirs in the next change.
- **Summaries, config and telemetry take otito's shared shape.** The summary behind `init`, `install`, `discover`, `index`, `catalog`, `search` and `repo` prints its facts as a table under "At a glance", file lists as a tree and every other section as a `- ` list. `otito config list` is a key, value and source table, `otito config get` a key and value table, `otito telemetry` a table followed by the commands that change it, and `otito deps` a header, a table and `path:line` matches.
- **Markdown tables in reports are aligned.** `renderDocument` pads the cells of a table, and extends the dashes of its rule row, so the columns line up. It aligns a table only when every row splits into the same number of cells after honouring `\|` and code spans, and leaves it untouched otherwise; nothing is removed, so every source character still reaches the terminal.
- **`otito help` documents `--emoji`, `--no-emoji`, `--color`, `--no-color` and `--theme` once, as global flags,** instead of on the few commands that happened to list them.
- **Every terminal formatter takes its marks from the renderer's glyph set.** About fifty `renderer.emoji ? "…" : "…"` ternaries across `context`, `impact`, `pass`, `pass-pr`, `review`, `route`, the shared summary and the section, rank, bar and detail helpers now read `renderer.glyphs` or ask `renderer.pick({ emoji, ascii, unicode })` for a mark, so the box, status and verdict sets, the list markers and every decoration follow the glyph mode instead of one boolean. `renderer.emoji` is no longer read outside the renderer, and a test keeps it that way. `otito report` builds a renderer from the same `--emoji`, `--color` and `--theme` preferences every other command honours. Nothing visible changes: `tests/fixtures/formatters-golden.json` records each formatter's output in emoji and ascii modes, with and without colour, before this change, and `tests/formatters-golden.test.js` compares byte for byte.
- **A version bump that reaches `main` is tagged and released without a hand-pushed tag.** The `Release` workflow runs only on a pushed `v*` tag, and pushing it was a manual checklist step. On 2026-09-26 the 3.2.0 release merged to `main` as 0766fe7 at 20:33 UTC with `otito CI`, the docs deploy and the post-merge attestation all green, and nobody pushed the tag, so npm, GitHub Releases and the MCP Registry stayed on 3.1.0, and the docs site with them, until `v3.2.0` was pushed by hand at 21:12. A new `Tag release` workflow runs when `otito CI` passes on a `main` push, reads the version from `package.json` at that commit and, when `vX.Y.Z` does not exist yet, tags the commit with `scripts/tag-release.sh` and starts the `Release` workflow on the tag. A tag pushed with `GITHUB_TOKEN` triggers no workflow, so `release.yml` now also accepts `workflow_dispatch`, which keeps it the workflow npm Trusted Publishing trusts; dispatched on a branch, it refuses before publishing. A `main` push whose version is already tagged, which is every push that is not a release, tags nothing. A version that is not newer than the latest release tag, or that `CHANGELOG.md` has no section for, fails the run instead of publishing a release nobody prepared. Pushing a tag by hand still works, and is how to release a commit CI did not run on.

### Fixed

- **`otito install`'s next steps no longer tell you to run `otito doctor` to verify the install.** `getDoctorReport` (`src/lib/doctor.js`) never checks the `otito` binary itself — it checks seven unrelated tools (`node`, `git`, `gh`, `rg`, `npx`, `opensrc`, `code-structure`), three of which its own output calls "optional accelerators". Whether `otito` landed on PATH is already verified inside `installOtito`/`handleInstall` via `commandExists`, surfaced as the summary's installed/not-verified close line, so the doctor pointer added a step that checked nothing the install itself hadn't already checked. `getInstallPlan().nextSteps` in `src/lib/install.js` now starts at `index --discover`.
- **`context_pack` and `change_impact` no longer rank translation catalogs, file extensions and test notes ahead of the code a request names.** Found reviewing otito's use on bashbop-event-web (2026-09-27), every rule shared by both engines in `src/lib/ranking-rules.js`. A translation catalog is demoted (×0.3) unless the request is about copy, wording, i18n or translation, and the locales of one catalog (`messages/en-GB.json`, `en-NG`, `en-US`, `fr`, `pcm-NG`) share one entry that lists the rest under `siblings`; before, two locales were Primary Files in every recorded pack, five took ranks 8 to 12 of an impact top 12 at an identical score, and every hotspot for "sync local main branch" was an i18n key matching `main`. A folded locale keeps its catalog's role, so changing it is not read as drift. The extension of a file named in the request (`event-service.ts`) no longer scores, where `ts` and `tsx` had matched every TypeScript file. A path or basename named in the request is pinned above every unnamed candidate as a required owner (`services/event-service.ts` was 40th), and a named symbol pins the definition that is exported and imported elsewhere (`utils/create-event.ts` for `combineDateAndTime`) above an unused duplicate that merely shares its name, while its other definitions get a bonus. Tests and suggested tests list only files a runner executes, not a README, suite summary or snapshot under `__tests__/`. `contextEngineVersion` and `impactEngineVersion` are now 4 because an entry can stand for a catalog and a named file is an owner whatever its kind. New fixture `evals/fixtures/multi-locale-web` and retrieval case `multi-locale-named-files-and-symbol`: the 21 earlier cases are unchanged, accuracy moves from p@5 0.867, mrr 0.975 to 0.873, 0.976 on the added case alone (the previous engine fails it at p@5 0.6).
- **Header and verdict boxes are as wide as their borders.** Content lines were padded to `width - 4` and then framed with `│  …  │`, six cells, so every content line came out two cells wider than the top and bottom border in every command. They are padded to `width - 6` now, and a test checks that every line of a box has the same display width in all three glyph sets, at 60, 78 and 120 columns, with wrapped content. The two golden fixtures were regenerated on purpose; in the formatter fixture every changed line of the gate, review, context, impact, route and doctor output is a box content line, two cells narrower, with the same text.
- **The route-prompt hook no longer routes what the harness submits itself, and `route-outcomes` leaves those rows out of the grade.** Claude Code delivers a finished background task through `UserPromptSubmit`, and `isRoutable` filtered only empty prompts, slash commands, turn-taking and very short prompts, so the hook routed the notice like a request. On 2026-09-27, 22 hours after the decision log began, 79 of the 146 decisions in `~/.otito/route-decisions.jsonl` were prompts the harness wrote, each matched by hash to the queue record in its session transcript: 75 `<task-notification>`, 3 `<bash-input>` (the record of a `!` shell command and its output) and 1 `<ci-monitor-event>`. A notice that `yarn test` had finished was routed premium with risk paths `data model` and `auth/security`. Each cost a hook run and put "otito routed this request" in front of a prompt nobody wrote. The hook now skips all three and logs nothing for them. A `<system-reminder>` the harness puts in front of a prompt is looked past rather than skipped, because all 22 logged prompts that opened with one had a request behind it; what is behind the reminder is judged as before, so `yes` after a reminder is turn-taking again. `<pasted_content>`, `<create-pr-command>` and `<cross-session-message>` reached the hook too and still route, because each carries a request. `<command-name>` and `<local-command-stdout>` matched no decision and get no rule. The rows already logged stay in the log. `route-outcomes` hashes the harness prompts it finds in each session's transcript, in user records and in queue records (33 of the 79 arrived mid-turn and exist only in the queue and as an attachment), leaves a decision with one of those hashes out of the grade, and reports the count: "146 logged, 79 excluded as harness prompts (task notifications, CI monitor events, shell records), 54 joined to a transcript prompt (13 not found)", and `excluded` under `--json`. A harness prompt in the transcript is no longer a prompt or a follow-up either. On those 146 rows the grader had graded 78 decisions, 36 of them harness prompts, and published two rates that were partly notifications (deterministic cheap 1.8% corrected on 55, offline mid 0.0% on 58); now 35 are graded and every lane is under the minimum sample. A decision whose transcript is gone cannot be identified and counts as not found. docs/18 has the table.
- **Box drawing, arrows and `✓` are measured as one cell.** `visualWidth` counted every code point from U+1100 upwards as two cells, so a padded header or verdict line holding `─`, `→` or `✓` came out one cell short per mark and its right border drifted. It now counts the East Asian wide and fullwidth blocks and emoji (`\p{Emoji_Presentation}`, the supplementary emoji blocks, and any character followed by U+FE0F) as two cells and everything else as one, still stripping ANSI escapes and skipping combining marks and zero-width joiners.
- **Long content wraps inside the header and verdict boxes.** `padRight` never truncates, so a `blocked by` reason or a path wider than the box pushed the right border out of line at 60 columns. `header` and `verdict` now wrap content to the inner width, split an unbroken run such as a path by cell, indent the continuation lines to the content column and keep a painted subtitle's colour on every line. Content that fits renders byte-for-byte as before; `tests/fixtures/render-fancy-golden.json` holds the pre-change output in emoji and ascii modes and the renderer tests compare against it.
- **The eval headers print the flask, not its source text.** `otito eval --accuracy`, `--harness` and `--gate-effectiveness` passed the header glyph as a double-escaped string, so in emoji mode the header box read `\u{1F9EA}  ACCURACY EVAL`. The three headers now print `🧪`, and a test scans `src/` for any string that spells a code point with a doubled backslash.
- **The generated pre-commit hook gates under `--policy standard`.** `otito init` wrote a hook that ran `otito gate . --staged` and so inherited the repository's `.otitorc.json` policy. A repository that sets `company` or `high-risk` there means it for merge time; on a commit that has not been pushed yet the company policy fails on review state alone, so the hook refused every local commit. The hook now passes `--policy standard`, and a test stages a change under a `company` policy and checks that the inherited gate fails while the hook's gate does not.
- **The generated workflow pins the action majors otito's own CI runs on.** The `otito init` template used `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4` while `.github/workflows/otito-ci.yml` had moved to `@v7`. The majors are now one constant in `src/lib/init.js`, the template reads them, and `tests/init.test.js` fails when they differ from the majors in `otito-ci.yml`.
- **A type check named `tsc:check` reaches the context pack, the PR review and the pre-commit hook.** The harness chose validation commands from a fixed list of script names and told a type check by `name.includes("type") || name === "tsc"`. On 2026-09-27 a context pack for a yarn web app whose type check is `"tsc:check": "tsc --noEmit"` listed `yarn lint`, `yarn test`, `yarn test:e2e` and `yarn build` and no type check, so an agent following the pack skipped it. `otito pr` had `tsc:check` on its list and dropped it for want of a reason, and the quality job and pre-commit hook written by `otito init` never saw it. The three now share `src/lib/package-scripts.js`. A script is a type check when its name, split on `:`, `-`, `_` and camelCase, holds `tsc`, `typecheck`, `type-check` or `check-types` as whole segments, as `tsc:check`, `check:tsc`, `tsc-check` and `tscCheck` do; `tsconfig:sync` and `prototype` do not. A package that has none of the type-check names the list already had now gets every type check it defines, in the list's type-check slot; one that has one of them gets the same list as before, so a monorepo with an aggregate `typecheck` does not run tsc again for each part. A name that says `watch` or `build` is left out, as is a type check whose command passes `--watch` (or `-w` to `tsc`): a watch never finishes and a build writes files.
- **The end-to-end command is the headless one when the package has it.** The same pack listed `yarn test:e2e`, which in that repository is `playwright test --headed` and opens browser windows an agent or a CI runner has no display for, while `test:e2e:headless` sat beside it. The harness and `otito pr` now list the headless sibling of an end-to-end script (`test:e2e:headless`, `test:e2e-headless`) in its place, and list it when it is the only one. A package with no headless sibling keeps `test:e2e`.

## [3.2.0] - 2026-09-26

The gates gate what they are given. `otito gate` and `otito review` take the repository from the positional or `--path`, in local and PR mode alike, and every CLI gate, `otito pass-pr` included, reads policy and governance from the `.otitorc.json` of the repository it gates, as the MCP gate tools now do too. The GitHub PR gate reads whether a PR is open, merged or closed and reports it as `pr.state` and `pr.mergedAt`, new report fields that make this a minor release. A `--pr` or selector that names no PR is refused on the command line rather than gating the wrong thing; over MCP a blank `pr` reads as no PR, and `pr_merge_readiness` with no selector gates the checked-out branch's PR again. Repair hints name the `@nugehs` packages that exist, and `otito help` no longer promises the legacy MCP tool names go away at 3.0. No command, field or schema was removed.

### Fixed

- **The compliance-controls gate names the bouncer package that exists.** When a repository has `bouncer.config.json` and no bouncer binary resolves, the local gate told you to run `npm install --save-dev @bashbop/bouncer`, which npm answers with a 404: bouncer is published as `@nugehs/bouncer`. The hint and the README link now name it. A repository that runs bouncer in CI instead, through a workflow under `.github/workflows` that references `@nugehs/bouncer` (such as `npx -y @nugehs/bouncer@latest check`), now gets a warning that says so and names the workflow line, rather than one that reads as a broken install. It stays a warning: the gate reads the workflow file but never runs npx or installs anything, so it has no evidence that the controls pass for the change it is looking at.
- **The contract-drift gate names the tieline package that exists.** When a repository has `tieline.config.json` and no tieline binary resolves, the local gate told you to run `npm install --save-dev @bashbop/tieline`, which npm answers with a 404: tieline is published as `@nugehs/tieline`. The hint and the README link now name it. The README's aiglare link had the same fault and now points at `@nugehs/aiglare`, where aiglare is published.
- **The GitHub PR gate knows whether a PR is open, merged or closed.** `otito gate --pr`, `otito pass-pr`, `otito review --pr` and `review_gate { pr }` never asked `gh` for the PR's state, so a merged or closed PR was gated as if it were still open. Once BASHBOP/otito#214 merged, GitHub reported its mergeability as `UNKNOWN` and the gate answered "GitHub mergeability is not settled yet"; the audit ledger's post-merge records for #195, #196 and #197 carry the same `PR state: WARN`. A closed PR was judged on the mergeability GitHub last reported, so #188 read as pending and #153 as conflicted. The gate now requests `state` and `mergedAt` and reports both under `pr`. A merged PR's state passes, "PR is already merged; there is nothing left to gate.", and the terminal verdict no longer names a check blocking it or calls it ready to merge. Its review decision, CODEOWNERS, conversation, branch-protection and status checks still run, because they describe what merged and post-merge attestation records them, so a PR merged without CODEOWNERS approval still fails that check. A closed PR's state fails: it cannot merge unless it is reopened.
- **docs/03 and CONTRIBUTING.md said otito runs team governance; it runs solo.** The Contributor Governance page called this repository a team repository and ended "Do not copy solo governance onto this repository", and CONTRIBUTING.md said code owners review changes under team governance, while the checked-in `.otitorc.json` has made solo the default for every otito command run here since BASHBOP/otito#193. Both now say the repository has one maintainer and what solo means for its gate: a missing separate review or CODEOWNERS approval is `WARN` evidence, not `FAIL`, requested changes still fail, and an explicit `--governance team` still overrides the file.
- **The MCP gate tools honour the repository's `.otitorc.json`, as the CLI does.** On 2026-09-26 `otito pass-pr 214` gated BASHBOP/otito#214 under solo governance and warned on CODEOWNERS ("solo-maintainer mode requires an explicit owner/admin merge decision"), while `review_gate { pr: "214" }` failed the same PR under team governance ("CODEOWNERS approval is missing"). This repository checks in `.otitorc.json` with `"governance": "solo"`. The CLI fills an omitted `--policy` or `--governance` from that file and the user config before any gate runs; the MCP server passed its arguments straight through, so a missing `governance` normalised to `team`. `review_gate` and `review_verdict`, and the `merge_readiness`, `pr_merge_readiness` and `review_pr` aliases that route to them, now fill an omitted or blank `policy` and `governance` from the same config, found from the repository at `path` rather than from wherever the MCP host started the server, and their schemas say so. An explicit argument still wins. Called from a server started outside the repository, `review_gate { pr: "214", path }` now reports `governance: solo`, CODEOWNERS `WARN` and verdict `WARN`, as `otito pass-pr 214` does, and `governance: "team"` still fails it. The lookup also walks up from a relative path now: `path.dirname(".")` is `.`, so a gate called with `path: "."` from a subdirectory stopped where it began and never reached the repository's `.otitorc.json`.
- **The CLI gates read the config of the repository they gate, not of the directory they run in.** `otito pass <repo>`, `otito review <repo>`, `otito gate` and `otito pass-pr <n> --path <repo>` filled an omitted `--policy` or `--governance` from the `.otitorc.json` found from the working directory. On 2026-09-26, run from outside this repository, `otito pass-pr 214 --path <checkout>` gated BASHBOP/otito#214 under team governance and failed it ("CODEOWNERS approval is missing for one or more changed files."), while `otito pass-pr 214` run inside it read the checked-in `"governance": "solo"` and warned; run from inside it, `otito pass <repo>` gated a repository with no config as solo. Each command now resolves both from the repository it gates, the positional for `pass` and `review`, `--path` for `pass-pr` and either for `gate`, through `gatePolicy` in `src/lib/config.js`, which the MCP gate tools now share: that repository's `.otitorc.json`, then the user config. An explicit flag still wins and a blank one (`--governance=`) counts as omitted, as it does for the MCP tools. From outside the checkout, `otito pass-pr 214 --path <checkout>`, `otito gate --pr 214 --path <checkout>` and `otito review <checkout> --pr 214` now report `governance: solo`, CODEOWNERS `WARN` and verdict `WARN`, and `--governance team` still fails the PR. `otito workspace-gate` gates every repository under one policy and one governance, which its parent receipt records once, so it now resolves each repository's own config and, when they disagree, refuses rather than gate one repository under another's setting: "workspace-gate runs every repository under one governance, and their configs disagree (…/web: team, …/api: solo); pass --governance to choose it". The flag settles it for all of them; repositories that agree, including through a shared `.otitorc.json` above them, need none. Emoji, color and theme still come from the directory otito runs in.
- **`otito gate` gates the repository it is given, in either mode.** The local gate read the repository only from the positional and the PR gate only from `--path`; each ignored the other without a word and gated the directory otito ran in. On 2026-09-26, run from this checkout, `otito gate --path <other-repo> --base HEAD~1 --json` reported `repo.root` as this checkout, and `otito gate <other-repo> --pr 214 --json` gated BASHBOP/otito#214, the PR with that number in this repository, under this checkout's `.otitorc.json`. The docs name the repository with `--path` (`otito gate --pr "$PR_NUMBER" --path .`), `otito help` with the positional (`otito gate <repo>`), and the `agent-tools` catalog with `--path` in both modes (`otito gate [--pr <selector>] --path <repo>`), so each documented form was silently dropped in one mode. Both modes now take the repository from the positional or `--path`, and resolve policy and governance from that repository's `.otitorc.json`. Naming it both ways is refused unless both name the same directory, compared by real path so `.` and a symlinked spelling of the same checkout agree: "gate was given two repositories (. and --path ../api); pass only one". A `--path` with no value is refused too. Rerun from this checkout, `otito gate --path <other-repo>` gates that repository under its own `high-risk` policy, `otito gate <other-repo> --pr 214` asks `gh` about that repository, which has no remote ("no git remotes found"), instead of gating #214, and `otito gate --pr 214 --path .` still gates #214. `otito help` lists `otito gate [repo | --path repo]` for the local gate and `otito gate --pr <selector> [repo | --path repo]` for the PR gate.
- **`otito review` reviews the repository named by `--path`.** `review` read the repository only from its first positional and took the positionals after it as the request, so it ignored `--path`, which the `agent-tools` catalog gives as the CLI form of the `review_verdict` MCP tool (`otito review --path <repo> --json`). On 2026-09-26, run from this checkout, `otito review --path <other-repo> --base HEAD~1 --json` reported `repo.root` as this checkout and gated it under this checkout's settings (the default `standard` policy), not the other repository's `.otitorc.json` (`high-risk`); `otito review --path <other-repo> "tweak a"` took the request for the repository ("repo path does not exist: …/tweak a"); and, run from another repository, `otito review --pr 219 --path <checkout>` asked `gh` about the repository it ran in ("no git remotes found") instead of BASHBOP/otito#219. `review` now reads its arguments as `impact` and `ax` do: with `--path`, that names the repository and every positional is the request; without it, the first positional names the repository and the rest is the request. Policy and governance come from the `.otitorc.json` of the repository reviewed, and a `--path` with no value is refused: "review --path needs a repository, e.g. `otito review --path .`". Rerun, the first two review the other repository under its `high-risk` policy, the second with the request "tweak a", and the third reviews #219 under this checkout's solo governance (`WARN`). `otito help` lists `otito review [repo | --path repo] [request]`.
- **`otito help` no longer says the legacy MCP tool names stop working at 3.0, and links a mapping that exists.** It said `pr_review`, `review_pr`, `merge_readiness`, `pr_merge_readiness`, `repo_catalog`, `repo_discover` and the `find_*` tools "keep working via tools/call until 3.0. See docs/MIGRATION-2.0.md.", and the comment on `LEGACY_TOOL_ALIASES` in `src/lib/mcp.js` made the same promise. The deadline was Repoctx's, set when its 2.0 folded 18 tools into 11. The rebrand to otito (a0f4f98, 2026-07-29) deleted `docs/MIGRATION-2.0.md`, and `docs/MIGRATION-3.0.md` with it, and its renaming turned the comment's "until repoctx 3.0" into "until otito 3.0". otito 3.0.0 and 3.1.0 shipped with all ten names still dispatching, as `tests/mcp-dispatch.test.js` checks, and with the help unchanged, so it described a removal that never happened and linked a page that did not exist. The help and the comment now say the names still work in 3.x and that no release is named to remove them. Both point at a new "Legacy tool names" table under "MCP Tool Surface" in docs/02-mcp-agent-workflows/README.md, restored from the deleted guide, which maps each name to its canonical tool and says how its arguments are translated; the help links it on the docs site. The help test now fails if that section disappears, and a new test fails if the table and `LEGACY_TOOL_ALIASES` disagree on a name or its target. No alias was removed.
- **The MCP gate tools read a blank `pr` as no PR, and `pr_merge_readiness` with no selector gates the checked-out branch's PR again.** Before 2.0, `pr_merge_readiness` gated "the current branch's PR" when its `selector` was left out, as its schema said and as `gh pr view` does. BASHBOP/otito#66 folded it into `review_gate` and mapped a missing selector to `pr: ""`, which `review_gate` reads as no PR, so the alias has run the local gate ever since, while the comment in `review_gate` said it did "exactly what the old pr_merge_readiness and merge_readiness did". `review_verdict` read `pr` differently again: `""` ran the local gate, but `" "` counted as a PR, and `gh pr view` drops a blank selector and answers with the checked-out branch's PR. On 2026-09-26, against a checkout of `fix/review-path-flag`, `pr_merge_readiness {}` and `review_gate { pr: " " }` each returned a local-gate report against `origin/main`, while `review_verdict { pr: " " }` gated BASHBOP/otito#220, which it never named ("PR is already merged; there is nothing left to gate."). The test meant to pin the route, "empty pr selector still routes to the PR gate and returns a payload", checked only that some text came back, so it passed on the local gate. `review_gate` and `review_verdict` now read a blank `pr` as omitted and run the local gate, as they already read a blank `policy` or `governance`: unlike `--pr "$PR_NUMBER"` on the command line, a JSON argument has no unset variable behind it. A `pr` that names a PR still gates it. `pr_merge_readiness` with no selector, or a blank one, gates the checked-out branch's PR, which `review_gate`'s own `pr` cannot ask for; a `selector`, or a `pr`, still names the PR. Both tools' `pr` schema descriptions say so, and the tests run each call against a fake `gh` that answers `pr view 42` and a bare `pr view` with different PRs, and assert which one, if either, was gated. Rerun, `pr_merge_readiness {}` gates #220 and `review_verdict { pr: " " }` runs the local gate.
- **`otito gate --pr` and `otito review --pr` refuse a `--pr` that names no PR, and `otito pass-pr` a blank selector.** The gate switched to the GitHub PR gate only when `--pr` carried a non-empty value. On 2026-09-26, `otito gate --path . --base HEAD~1 --pr= --json` and the same command with a bare `--pr` each returned a local-gate report, verdict `WARN`, exit 0 and no `pr` field, as if `--pr` had never been given. The documented CI form `otito gate --pr "$PR_NUMBER" --path .` fared worse with the variable unset: the parser reads `--pr ""` as a bare `--pr` and keeps the empty string as a positional, which the gate took for the repository, failing with "git rev-parse --show-toplevel: command failed" when run from the repository and "gate was given two repositories ( and --path …); pass only one" from anywhere else. `otito review --pr=` ran the local gate the same way, and `otito review . --pr "$PR_NUMBER"` with the variable unset asked `gh` for the PR of a branch named `true`. A blank selector that reached `gh` was dropped, so `gh pr view` fell back to the checked-out branch's PR: against a checkout of `fix/cli-gate-config-from-gated-repo`, `otito pass-pr "" --path <checkout>` and `otito gate --pr " " --path <checkout>` both gated BASHBOP/otito#217, which neither named. `gate` and `review` now refuse a `--pr` that is bare or blank before they read a repository, "gate --pr needs a PR number or URL, e.g. `otito gate --pr 123 --path .`" (`review` names `otito review . --pr 123`), and `pass-pr` refuses a blank selector: "pass-pr was given a blank PR selector; name the PR, e.g. `otito pass-pr 123 --path .`, or leave it out to gate the current branch's PR". Each exits 1, with the message as `error` under `--json`. Leaving `pass-pr`'s selector out still gates the current branch's PR, as `gh pr view` does, and `otito gate --pr 217 --path .` still gates #217.

## [3.1.0] - 2026-09-26

The router gets graded, and the answer so far is that nothing can grade it yet. `otito regret` replays a repository's history and grades the tier each half of the router would have given against the same `repaired` outcome `otito calibrate` uses; `--rescore` grades a new arithmetic on frozen model answers. On three repositories no variant orders outcomes, and an offline audit of the join and of a same-session outcome says why, so the route stays advisory. The route-prompt hook now keeps every decision it makes, so the router can be graded once enough real requests exist. Attestation moves into the CLI as `otito attest`, with versioned records and a reusable workflow. No command, field or schema was removed.

### Added

- **The How It Works page is tied to every change in the CLI, the tool catalog and the release.** Three new checks, each with a message that says where to make the fix. Every command `otito help` lists must be a card on the page or a row in `SUPPORTING_COMMANDS` (scripts/how-it-works/content.js) with the reason it is not a stage of the loop, so a new command cannot ship without deciding where it belongs, and a command that leaves the CLI has to leave the table too. Each MCP tool now carries a `summary` in `src/lib/mcp.js`, one or two plain sentences that the page and `otito agent-tools --json` print; the MCP description is unchanged and `summary` is not sent over `tools/list`. The page stamps the package version (`<meta name="otito:version">`) and the `version` lifecycle script re-renders it, so a release that skipped `npm run docs:diagram` fails `docs:diagram:check`.
- **"The gate never consults a model" is a test, not a sentence.** `tests/gate-imports.test.js` walks the static import graph from every verdict-producing module (`pass-local`, `pass-pr`, `pr-review`, `converge`, `review`, `impact`) and fails if any path reaches `jev.js`, `model-route.js` or `context-read.js`. The page's first guarantee is checked against the same test.
- **`otito attest` / `otito attest --verify`.** The post-merge attestation moves out of `audit-pilot/attest.mjs` and into the CLI. `otito attest <repo> --verdict <file> --merge <sha> [--prev <sha>] [--pr <n>] [--author <name>] [--committed <iso>]` appends a hash-chained record to `audit-pilot/ledger.jsonl` under the repository (or the file `--ledger` names); `--verify` recomputes the chain and exits 1 if any record was altered. Both take `--json`. `scripts/post-merge-attest.sh` and `scripts/reconcile-attestations.sh` call the command and honour `OTITO_LEDGER`.
- **`schemaVersion` on the verdict JSON and on every ledger record.** `otito review --json` now reports `schemaVersion: 1` beside `reviewEngineVersion`, and each attestation carries `schemaVersion: 1` and the `verdictSchemaVersion` it was built from. Records written before these fields existed verify unchanged.
- **Jev calls identify Otito.** Every call to TypeSafe goes out under `user-agent: otito/<version>`, with the client name and version only.
- **`otito regret`, the router graded against the repository's own history.** For each non-fix commit it checks the first parent out into a temporary worktree, scores the commit subject as the request, and grades three tiers side by side: the deterministic half alone (AX, containment and bumps, every model term at zero), the shipped offline heuristic, and the Jev read when `TYPESAFE_API_KEY` is set (`--offline` keeps a run keyless). Outcomes are the line-overlap `repaired` join `otito calibrate` uses, now exported from `calibrate.js` as `joinRepairs` and `readHistory` so both grade the same thing. Per tier: n, repaired, rate, lift, with rates withheld below `--min-sample`; per variant: whether cheap < mid < premium orders outcomes, and the regret count, a commit routed cheap that was repaired within the window. Per question: mean, min, max and spread of the answers across the corpus, so a question that cannot separate its inputs shows as a flat line. Never a saving: otito does not know which model a host used. Offline the run is a pure function of repository state with a receipt; with a key the receipt says the model's answers are not replayable. `--json`, `--out`, `--since`, `--max`, `--window`, `--quiet`. Run on this repository (150 gradable commits, 47 younger ones censored, 30-day window, `jev-1.13.0`): no variant is shown to order outcomes, every interval overlaps every other, and no variant routes premium often enough to grade the top tier. The deterministic half sits at the 17% base rate in both tiers it uses; the keyless heuristic runs the wrong way within noise (cheap repaired 20.3% against 14.8% for mid); the Jev read runs the right way within noise (cheap 14.7%, mid 17.9%) and its answers now separate their inputs, but the arithmetic funnels three quarters of commits into `mid`. The table, intervals and receipts are in docs/18 under "Measured, otito, 2026-09-26".
- **`otito regret --rescore <run.json>`, a change to the router's arithmetic graded on frozen model answers.** Jev's answers are not replayable, so two arithmetics graded on two runs also differ by the model's drift between them. Each regret row now keeps the signals `scoreDecision` reads (`containment`, `riskPaths` beside `ax` and `candidates`) and the answers exactly as scored under `inputs` (Score expectation, confidence and level distribution; Noul probability), and `rescoreRegret` / `--rescore` applies the current arithmetic to a saved run with no checkout and no model call. The rescore carries its own receipt, names its source in `method.rescoredFrom`, and keeps the source's `replayable: false`. Runs saved by regret 0.2.0 are refused rather than rescored on rounded answers. docs/18 records the bar the next arithmetic has to clear, written before any candidate was scored, and the three frozen runs it is graded on: each repository's whole history, `jev-1.13.0`, 2,385 answered calls, $0.20, every saved tier reproduced by a rescore. Against that bar the shipped arithmetic fails in two places. On bashbop-api the keyless tier is inverted (cheap repaired 22.5% against 10.1% for mid, intervals apart) while the Jev tier is ordered (4.8%, 12.1%, 38.6%) and its escalations out of the cheap lane are right (13.5% repaired against 4.8% for the commits it left cheap). On bashbop-event-web the Jev read routes 8 of 1,016 commits cheap, too few to grade. The first candidate under the bar, which charges each Score term from a centre so a read at the easy end earns a share of AX back, passed the tuning runs at one centre only (0.2, with its neighbours failing inside the intervals) and failed the confirmation run on criterion 3; it does not ship, and docs/18 records the sweep, the confirmation, and that a cheap-ward push found almost nothing to lift in this backtest. `regretEngineVersion` 0.3.0.
- **`otito regret` grades no release commits, and the bashbop-api findings above are withdrawn.** A commit written by release tooling (`chore(release): 2.26.5 [skip ci]`, `chore: bump version to 1.4.0`, a bare version, anything marked `[skip ci]`) is neither a request nor an outcome: no router saw it, and the join almost never reads one as repaired. They now leave the corpus the way fix commits do (`RELEASE_SUBJECT`), the corpus line prints how many, and `--rescore` applies the rule to runs saved before it, with a caveat naming how many rows left. On the frozen bashbop-api run they were 504 of 1,214 graded commits, 4 repaired, and 365 of the 474 in the deterministic cheap lane: that lane's 10.1% was the release commits, the keyless "inversion" was the heuristic moving them to `mid`, and the model's 186-commit cheap lane was 166 of them. Re-graded without them no variant orders outcomes on either bashbop repository, the human base rates are 41.7% (bashbop-api) and 50.5% (bashbop-event-web), and the centre candidate's tuning pass does not survive. docs/18 "Re-graded, 2026-09-26: without release commits" has the tables. `regretEngineVersion` 0.4.0.
- **The `repaired` join audited, and the fix rule widened.** Before any further arithmetic, the question the re-grade left open was put to the frozen runs offline: 7 and 14 day windows, eight stricter joins (2 or 3 overlapping lines, fix commits capped by files or lines), the share of repairs owed to the ten largest fixes, the unlabelled fixes, and the `Develop (#N)` and dependency-bump exclusions. The join reproduces every frozen row; on the bashbop repositories it is not a few sweeping fixes (204 and 284 distinct earliest fixes for 296 and 472 repairs); and no cut orders any graded variant. Commit history cannot grade the router on these repositories, and the next evidence has to come from live requests; docs/18 "Audited, 2026-09-26: the join" has the cuts and the record a live log should keep. One rule was wrong on its own terms: `FIX_SUBJECT` missed `hot-fix(...)`, `hot-fit`, `bug(...)`, `patch`, `fixes`, `fixed` and `fixing`, so 79 bashbop-api and 40 bashbop-event-web fix commits were graded as requests and invisible as repairs (joined, they add 6 and 9 repairs and move no tier). `calibrate` and `regret` now share `FIX_COMMIT_RULE`, and `--rescore` drops the rows the wider rule reads as fixes, counts them on the corpus line, and says their own repairs need a replay to join. `regretEngineVersion` 0.4.1.
- **The route-prompt hook keeps its decision, and `route-outcomes` grades it against the session.** A tier printed as context is gone when the turn ends, so every routed prompt now leaves one line in `~/.otito/route-decisions.jsonl` (`OTITO_ROUTE_LOG` moves it, `off` disables it): session id, timestamp, the prompt's hash and length (never the prompt), repository, branch and head at prompt time, the tier and route each half gave, the signals and the answers exactly as scored so `--rescore` can re-tier a live corpus, and the subagent model. `otito route --json` reports `deterministic: { tier, route }` beside the scored tier; `NEUTRAL_ANSWERS` moves to `model-route.js`. `node scripts/hooks/route-outcomes.mjs` joins the log to the Claude Code transcripts by session and hash and grades every variant per tier on two same-session outcomes, `corrected` (the next prompt is an interruption or pushback) and `reworked` (the next turn edits the same file), with regret's minimum-sample rule and Wilson intervals. Both proxies were audited before they were written, on twenty days of one machine's transcripts: pushback (8% of follow-ups) is mostly the user's own typos, deploy failures and interruptions to add information; rework (17% of editing requests) is iteration; 84 tiered requests put every lane under the minimum sample, and at about seven editing requests a day the corpus grows no faster than commits do. docs/18 "Audited, 2026-09-26: a same-session outcome" has the numbers and the caveats the grader prints. Wire the hook once in `~/.claude/settings.json` rather than per repository.
- **A reusable post-merge attestation workflow.** `.github/workflows/attest.yml` takes `workflow_call` with `target_sha`, `ledger_path`, `ledger_branch`, `otito_ref` and `reset_ledger`, checks the tool out beside the repository under attestation, attests every missing first-parent commit and persists the ledger to the ledger branch. otito's own post-merge workflow now calls it with the merged commit as the tool ref. `scripts/post-merge-attest.sh` and `scripts/reconcile-attestations.sh` take `OTITO_REPO`, `OTITO_BIN` and `OTITO_LEDGER` so they can attest a repository other than the one they ship in; the verdict is written beside the ledger.

### Changed

- **The How It Works page is redesigned around the loop, not the layers.** `docs/assets/otito-how-it-works.html` was a dark SVG of circles in six bands, unreadable on a phone and silent about everything that happened after the gate: `attest`, `calibrate` and `regret` did not appear, nor did the edit itself. It is now a responsive HTML timeline in the docs site's palette (light and dark) with six phases, Know the repository, Before the edit, The edit, Before the merge, After the merge and Over time, each naming who acts in it; otito is absent from exactly one. Every MCP tool is still a card generated from `getAgentTools()`, the CLI-only stages are cards the test checks against `otito help`, and the page closes on the four guarantees the rest of the docs argue for: no model inside the gate, nothing leaves the machine by default, same inputs same output, evidence not approval. `npm run docs:diagram` regenerates it; `--check` still runs in `npm run quality`.

### Fixed

- **docs/18 printed a Jev cost that did not follow from its own token count, and a token count 2.6× lower than the call that ships.** The "Cost and latency" section carried the pre-read measurement (728 to 845 input tokens) with a dollar range ($0.000019) that is not that count at $0.042/Mtok. Re-measured on 2026-09-26 against `jev-1.13.0` with the request read folded in: 2,059 to 2,165 input tokens, $0.000086 to $0.000091, 291 to 323 ms. The same page still described the confidence floor as a routing fail-safe; it is a display threshold only since the double-count fix, and the paragraph now says so. docs/19 rounds the per-call cost to "about a hundredth of a cent" instead of "under", which was wrong for a 24-file context read.

## [3.0.0] - 2026-09-25

The first major release since the Òtítọ́ cutover. It follows 1.15.0 directly: the `v2.x` tags belong to the Repoctx releases, so the version skips them.

### Migrating from 1.x

- **Context pack** (`otito context --json`, `context_pack`): `intent` is now `{ action, topics }`, and `intent.hints`, `patterns` and `agentPrompt` are gone. Read the ranked files and hotspots directly and let the model decide what the request means.
- **Impact** (`otito impact --json`, `change_impact`): `implementationPlan` is gone. Rank, risk flags and suggested tests are unchanged.
- **PR review** (`otito pr --json`, `review_context`): `reviewPrompts` and `nextSteps` are gone. Use `risk.flags` and `reviewTargets`, which carried the same information.
- **Convergence**: untracked files are no longer scored by default. Pass `--include-untracked` / `includeUntracked: true` for the 1.x behaviour. Receipts issued by engine `0.1.0` do not recompute under `0.2.0`; re-issue them.

### Added

- **`otito converge --head <ref>` / `convergence_score { head }`: score exactly `base..head`.** Convergence could only diff `base` against the working tree, so any dirty or untracked file was scope drift. Scoring a one-commit feature (`--base HEAD~1`) in a checkout with three edited `.claude/*` files and an untracked `dump.rdb` reported 29 changed files for a 25-file commit and listed all four extras as drift. `head` diffs the two trees directly (no merge base), builds the scoring map from the head commit's raw blobs, and binds a v2 receipt to a new `git-commit` subject (`baseSha`, `headSha`, `treeSha`) the way `--staged` binds to the index tree. `--head` and `--staged` cannot be combined.
- **`otito gate --head <ref>` / `review_gate { head }`.** The local gate's changed-path, risk, secret, and convergence checks read the head commit's tree, reported as a `Commit snapshot` check with `scope: "commit"`. A JSON receipt whose subject names a different mode or head than the gate measured now fails with the mode to rerun in (`--head <sha>`, `--staged`, `--pr <n>`) instead of a bare hash mismatch.

### Changed

- **Convergence counts a confirmed owner's own fan-out as in scope** (engine `0.2.0`). A file added beside a confirmed required owner (`owner-sibling`) and a test named after a confirmed file or inferred sibling (`owner-test`) move out of drift into `drivers.inferredRelated`, each with its rule and anchor. Siblings must be mapped, non-secret, and carry no risk flag the owner lacks; generic test stems such as `index` must sit beside their file. On the commit above, the new `PersonDialog.tsx`, `SendMessageCard.tsx` and three other components beside the `PeopleTable.tsx` owner, and five tests of confirmed files, stopped counting as drift: 55/100 (Scope 21, Risk alignment 15) became 84/100 (Scope 64, Risk alignment 85) with `--head HEAD`.
- **Working-tree convergence no longer scores untracked files by default.** They are listed under `untracked` with a recommendation; `--include-untracked` / `includeUntracked: true` restores the old behaviour. `change_impact` still counts untracked files.
- Receipts issued by convergence engine `0.1.0` do not recompute under `0.2.0`; re-issue them.

### Removed

- **BREAKING: otito stops interpreting the request; the model it serves does that better.** Several rankers and output fields tried to understand what a request meant using keyword rules. The agent reading the pack does that job better, so otito now returns the evidence and leaves both interpretation and ordering to the model. Removed:
  - Context pack: `intent.hints`, and the ranking boosts built on them (the MCP/CLI/tool/API/test hints, the signup-verification boost of +220, the RSVP-privacy boost of +120, the Handlebars template boost, and the CLI-entrypoint and agent-tool related-file boosts). Also the `patterns` and `agentPrompt` fields, and their Markdown and terminal sections. `intent` is now `{ action, topics }`.
  - `impact`: the `implementationPlan` field and its section.
  - `pr` / `review_context`: the `reviewPrompts` and `nextSteps` fields and their sections. They restated `risk.flags` and `reviewTargets`, which are unchanged.
  - Kept: `classifyImpactRoles`, because `converge` and `model_route` measure against its `requiredOwners`.
- **Measured against `main` on the 21 labelled retrieval cases.** p@5 stays at 0.867 and r@5 at 1.0, and 21/21 cases still pass. MRR drops from 1.0 to 0.975. Only the three cases the heuristics were written for changed rank, each by one place, and every expected file is still in the top three. Context packs are 18% smaller as JSON and 31% smaller as Markdown; `impact` output is 31% smaller as JSON. See [docs/EVALS.md](docs/EVALS.md#current-baseline).

### Fixed

- **Post-merge attestation attested whatever `main` was when the run started, not the commit it resolved.** The workflow passed its target to the scripts as `GITHUB_SHA`, which GitHub does not let a step override, so the scripts saw the runner's own value, the default-branch head. A run could attest a commit before that commit's CI had passed, and the ledger commit could name one commit while recording another: the reset meant to restart the chain at `b3f795d` recorded `fc0a7b9`. The target is now passed as `OTITO_TARGET_SHA`, and `GITHUB_SHA` is still honoured when the scripts run on their own.
- **The context pack reported a working tree that no longer existed.** Its uncommitted-changes warning, and `repos[].git`, came from the cached code map, which records git state once, when the repository is indexed. The index is only rebuilt when a file's size or mtime changes, and a commit changes neither, so a repository indexed with work in progress kept warning about "4 uncommitted git change(s)" and told agents to inspect a tree that was already clean. The pack now reads git state live on every call, which costs about 50 ms. Other reports already read it live, and the catalog keeps its snapshot from index time on purpose.
- **Nothing had been attested on `main` since 2026-09-20, and CI had no way to recover.** The durable ledger on `audit-ledger` holds 97 attestations whose commits are no longer in `main`'s history. So every post-merge run stopped in `reconcile-attestations.sh`, correctly, and named a reset that only worked from a local shell. The workflow's manual trigger now takes `reset_ledger`, the only way an Actions run can set `OTITO_ATTEST_RESET_LEDGER=1`; a run started by CI never can. The persist step also keeps the archived chain (`audit-pilot/ledger-orphaned-*.jsonl`) on `audit-ledger` and in the uploaded evidence. Before this, a reset in CI would have written the archive on the runner and discarded it.

## [1.15.0] - 2026-09-23

### Added

- **`model_route`, the router as an MCP tool.** `otito route` was CLI-only, so every MCP host (Cursor, VS Code, Claude Desktop, Codex, Gemini) could score AX but not ask for a tier. The tool takes `{ query, path?, host?, offline?, includeMarkdown? }` and returns the `otito route --json` payload. It calls TypeSafe only when `TYPESAFE_API_KEY` is in the server's environment and `offline` is not true, and declares `openWorldHint: true` because it may. The MCP surface goes from 13 to 14 tools. Host resolution is shared with the CLI through `hostModelFor`, so an unknown host fails with the same remedy on both.
- **A request read, folded into the route call.** Three more questions ride the same System One call as the route questions: what kind of work the request is (`read_intent`), which otito tool answers it (`read_capability`), and, per ranked file, whether the work needs it (`read_file_<n>`). They cost input tokens, not a round trip. In `route` the read is reported under `model.read` and in its own output section, and is never scored: a test holds that the tier is identical with and without it. The Claude Code prompt hook adds a line for any answer that cleared its floor. Measured: 2,056 input tokens, $0.000086, 345 ms for route and read together.
- **`otito context --online` / `context_pack { online: true }`.** Applies the read to a context pack in one call: an intent at confidence ≥ 0.5 replaces otito's action word and withdraws the ambiguity question; a file the model scores under 0.2 is demoted out of the ranked lists, with its hotspots, and kept under `modelRead.demoted`; the rest are re-ranked by relevance with their original rank kept. A read that rejects every primary file is not applied to them. Off unless asked, so a pack stays a pure function of repository state by default; a failed or unkeyed call returns the pack unchanged with the reason. On a question whose offline pack listed an RSVP eval fixture as related to MCP integration, the fixture was demoted at 0.17 and `src/lib/mcp.js` moved to first.
- **Every MCP host can appear on a local Realtime Canvas.** Set `OTITO_CANVAS_URL` (loopback `http` only) and `OTITO_HOST` in a host's MCP config and each request-bearing tool call is forwarded to the canvas's `/ingest`: the request text, the tool name and the host label, never a result, a path argument or file contents. Fire and forget, and the tool yields once so the loopback send flushes before a CPU-bound dispatch blocks the loop — so a canvas that is down or slow cannot delay an answer; a test with a canvas that never replies holds the response under 900 ms. Off unless set. See [MCP and Agent Workflows](docs/02-mcp-agent-workflows/README.md#realtime-canvas-and-model-routing-opt-in), which also adds Codex CLI and ChatGPT guidance.

### Fixed

- **The config tests read the developer's own config.** `loadConfig({ env: {} })` still falls back to `~/.config/otito/config.json`, so anyone who had run `otito config set telemetry true` failed `telemetry defaults to off` locally while CI, which has no such file, stayed green. Every config test now pins `XDG_CONFIG_HOME` to its temp directory.
- **The route hook's end-to-end test made a billed call on a keyed machine.** It spawned the hook with the developer's environment, `TYPESAFE_API_KEY` included. The key is now removed from the child's environment.

## [1.14.0] - 2026-09-20

### Added

- **`scripts/hooks/route-prompt.mjs`, a `UserPromptSubmit` hook that routes every request.** A skill only routes when the model remembers to invoke it, so the request most worth routing — a quick one — is the one least likely to trigger it. The hook scores the request before any work starts and returns the tier as context, every time. It is explicit about the ceiling, because the ceiling is low: no hook output carries a model, `PreModelSwitch` may only block a switch and `PostModelSwitch` is read-only, and a session cannot re-price its own turns. So the hook **advises the session and binds the subagent** — the Task/Agent tool takes a model, so delegated work genuinely runs on the routed tier — and says as much in the context it injects, because claiming the host switched models when it only recommended a tier is an anti-pattern the skill names. It never eats a prompt: every failure path exits 0 and writes nothing, the routing call is killed at six seconds, turn-taking prompts and slash commands are skipped, and a subagent never routes so a routed agent cannot launch another. See [model routing](docs/18-model-routing/README.md).

### Fixed

- **An offline workspace search trusted every stored index without checking any of it.** The capability signature above guards `getCachedCodeMap`, but `otito search --offline` never went through it: it read each catalogued repository's index file, took whatever map was inside, and searched it. So the fix landed for a single repository and not for the sweep across all of them — the surface where a stale index is hardest to notice, because one repository quietly contributing no Markdown records looks exactly like a repository that has none.
  - The acceptance rule is now one predicate shared by both readers, split along its cost. The repository fingerprint stays out of the offline path on purpose: it walks and stats every tracked file, and `--offline` is documented as using stored indexes _without refreshing fingerprints_, so re-fingerprinting every catalogued repository on every search is the regression this flag exists to avoid. The other three checks — cache version, capability signature, and the root the map names — are pure functions of an envelope already being parsed, they cost nothing, and they are the ones that catch an indexer mismatch. A repository whose index fails them is skipped with its reason recorded in the result's `errors`, naming the refresh, rather than being silently searched or unilaterally rebuilt.

- **A repository indexed before a capability change kept serving the old index.** The Markdown fix above changed which files the indexer admits, but not `cacheVersion`, the hand-maintained counter that decides whether an on-disk index is still trustworthy. The repository fingerprint could not catch it either: it summarises the files on disk, and those had not changed. So an untouched repository indexed before that release went on being served a map with no Markdown records — `route` on _"fix a typo in the README"_ found no candidates at all, the `no evidence` fail-safe fired on the empty set, and a one-line documentation edit was routed to the premium tier. The fail-safe was right; it was being handed a wrong answer.
  - The cache now also records a **capability signature**, derived by running the real eligibility and classification functions over a fixed corpus of representative paths and hashing the answers. Admitting a new extension, dropping one, or moving a path to a different kind each move the signature on their own, so an index written by an indexer that disagrees with today's is rebuilt without anyone remembering to bump anything. `cacheVersion` stays as the manual escape hatch for extraction changes the corpus cannot observe.

- **The code map never indexed Markdown, so no skill or docs page could be found.** `isSourceFilePath` admitted a fixed list of code extensions plus a special case for `CHANGELOG.md`; every other `.md` file in the repository was invisible to impact analysis, `route`, and convergence. A request naming a skill therefore ranked whatever library files happened to share its vocabulary: _"make the model-router skill layout-agnostic"_ returned `integrations/herdr/runtime.mjs` and `src/lib/model-route.js` at containment 18, and `codex/skills/model-router/SKILL.md` — the file the request names — appeared at no rank at all. The same blind spot hid every page under `docs/`. This is the failure class the empty-match fix addressed one release earlier: a confident answer resting on the wrong evidence.
  - Markdown is now indexed with two kinds. **`skill`** covers `SKILL.md` and its companion pages under a `skills/` directory — these are instructions the repository ships and asks contributors to edit, so they are implementation, not commentary. **`doc`** covers the rest, and keeps the existing `docs/` ranking demotion. Frontmatter keys and values, headings, and relative links become the file's symbols and imports; Markdown never reaches the TypeScript parser, and SQL quoted in a document is no longer mined as data access.
  - Both kinds own a change **only when the request is about them**. A skill can carry a coverage obligation for _"change the model-router skill"_, but `src/lib/model-route.js` still owns _"fix the model route scoring bug"_ — a skill whose path matches every term must not displace the code. The same request now ranks `codex/skills/model-router/SKILL.md` first at containment 90.
- **A document _about_ a risky area escalated the tier as if it were that code.** #175 made Markdown indexable, so prose became a routing candidate and, with it, risk evidence: `docs/AUTH_TOKEN_VALIDATION.md` classifies as `auth/security` on its "auth" and "token" path tokens, which fired the risk-path bump and forced `premium` for _"fix a typo in the README"_. The bump itself is sound — a change touching auth code should escalate — but a document about token validation does not validate tokens, and matching it on a path substring prices a doc edit as an auth change. `signalsFrom` now skips prose candidates when collecting risk evidence, using the code map's `kind` where the ranking supplied one and falling back to `isDocPath`. Scoped to the risk signal: `classifyPath` is unchanged, because impact uses it for _relevance_, and a doc about auth should still rank for an auth request.
- **Post-merge attestation died on `exit 128` and reported green when it had done nothing.** The audit ledger chains against repoctx's merge commits, and otito's `main` is a fresh history, so none of the 97 durable records are reachable from it. `reconcile-attestations.sh` ran its coverage-gap check first, walking `git rev-list FIRST..LAST` before anything established those commits were present, so every run that resolved a merged commit failed with `fatal: Invalid revision range` — the script already held the right message for this, in the ancestry check below, but control never reached it. The runs that looked green were not passing: they resolved no merged commit, skipped every step and reported success, so the workflow alternated green and red while never once reconciling. Reachability is now established before any range is walked, and a ledger that fails it is reported as what it is with the recovery named. Recovery is opt-in via `OTITO_ATTEST_RESET_LEDGER=1`, never automatic, archives the superseded chain rather than deleting it, and starts the new chain at the tip instead of backfilling every ancestor, which would mint verdicts for changes the gate never ran on.
- **The route call priced output tokens at the input rate.** `JEV_PER_MTOK` covers input tokens only, but `askJev` fell back to `total_tokens` — which also contains output — and `generateRoute` priced whatever landed there at the input rate, so a 900-total-token response and a 900-input-token response both printed `$0.000038` and the inflated figure was indistinguishable from the correct one. The count and the billable quantity now stay apart: the response's token count is reported along with which quantity it is, only an input count is priced, and the terminal line says when a count cannot be priced rather than printing a number the rate does not support. `priceRouteCall` also separates a measured zero from an absent measurement, which the old truthiness check collapsed into null.
- **The router escalated two thirds of requests, sending one-file changes to the premium tier.** `confidence` was `Math.min` of both Score answers, and a value under the floor bumped a tier. That discarded the confident answer: _"rename the variable `running` to `score` in model-route.js"_ scored specificity 1.00 at confidence **1.00** — Jev put the entire distribution on _"the request names the exact file, symbol, flag or user-visible string to change"_, which is exactly what that sentence does — while `blast_radius` put 0.80 on _"contained to a single file"_ at confidence 0.54. Both answers say trivial. The minimum kept 0.54, missed the floor by one hundredth, and routed a one-file rename to the premium tier. It also double-counted, because `score` is the expectation over that question's own level distribution, so a spread answer already pays through its own term; bumping on the spread as well charged for it twice. Confidence is now reported for a reader and not read by the router. Measured on this repository over nine requests: escalation 67% → 0%, premium 6/9 → 1/9. The remaining bumps, `no evidence` and `risk path`, are otito's own deterministic repository signals, which is the half of this pairing entitled to overrule a model; a vendor's self-reported certainty is not. See [model routing](docs/18-model-routing/README.md).

## [1.13.1] - 2026-09-20

### Changed

- **The documentation pack is written for a reader rather than for its author.** Nine of eighteen pages opened by saying they mapped an external source onto otito, seven built their main table around a video's claims, and eight carried a private backlog. Seven of those pages made one argument, that verification has to be computed from the repository rather than asked of the model that wrote the change, and they are replaced by a single [deterministic verification](docs/07-deterministic-verification/README.md) page that makes it once, for a reader who has watched nothing. Calibration and model routing are kept, because they carry original measurement rather than commentary. Priority tables are gone from public docs entirely.
- **Site navigation is grouped by what a reader is trying to do** rather than by an eighteen-slot numbering that implied an order it did not have. The model routing page was missing from the navigation entirely.
- **The model router skill can offer a realtime canvas**, at most once per session, only when `$OTITO_CANVAS_HOME` points at one, and only when that canvas is watching the repository being routed. A canvas is fixed to one repository at startup, so feeding it a request about a different codebase would score that request against a codebase that has never seen it.

### Added

- **`npm run skills:sync` and `npm run skills:check`.** The canonical skills in `codex/skills/` had drifted from the copies installed under host directories, and the repo copy, the one calling itself canonical, was the stale one. Syncing is now one-directional, and the check is local by design: a repository's CI cannot police files in a home directory, so it exits 0 where those directories do not exist rather than reporting a green tick for something it never examined.

### Fixed

- **A test that only passed on a machine without `TYPESAFE_API_KEY`.** `askJev` falls back to the environment, so the missing-key assertion was handing a real key to its own stub and asserting the wrong error. It now controls the variable instead of depending on it.

## [1.13.0] - 2026-09-20

### Added

- **`otito route <repo> "<request>"`, the model router, promoted out of `scripts/` into the CLI.** Score a coding task before any tokens are spent on it and recommend a cheap, mid, or premium tier. otito answers the repository half deterministically (AX, containment, canonical risk flags); a System One model answers the request half with calibrated probabilities over three narrow typed questions, in one call. `--tier-only` prints the tier for any host to map, `--host <id>` prints that host's model name, and maps live in `.otito/model-route.json`, so nothing about the scoring is specific to one IDE. `scripts/model-route.mjs` remains as a thin wrapper for the 1.12.0 prototype invocation.
  - **The router is not the gate and must never become one.** It runs before work starts and decides how much model to spend; the gate runs after the diff exists and decides whether a change may merge. A failed, unreachable, or unkeyed model call falls back to a local estimate that labels itself uncalibrated, and costs a tier, never a verdict. The gate never asks.
  - It stays **advisory**. The share weights and band thresholds were chosen by judgement and have never been compared to an outcome, the same critique [the calibration thesis](docs/17-calibration-thesis/README.md) makes of `inferRisk`. Promoting it past advisory needs a backtest measuring **regret**: tasks routed cheap that ended in a revert or a repair, weighed against the spend avoided.
- **An advisory routing footer** under commands that already hold an impact pass and an AX score. Offline by construction, an ordinary otito command still makes no network call.

### Changed

- **Nineteen report commands now get otito's shared document treatment.** Fourteen commands honoured colour and theme while nineteen printed raw Markdown and looked nothing like `review` or `impact`. `renderDocument` gives them all the same header box, headings that read as headings, and quiet rules, rather than a hand-written renderer per command.

### Fixed

- **The router read an empty match as a contained change.** Zero candidates is absence, not containment: when otito matches nothing, AX describes an empty set and `containment` reads high for the same reason there is nothing to spread across, so the arithmetic produced a confident-looking **cheap** tier for exactly the request the repository understood least. Found by dogfooding: _"fix scanning multi date event ticket"_, asked against a repository with no such code, scored containment 100 on zero files and routed `cheap`. The floor jumps straight to the ceiling rather than stepping one tier, a one-tier step would leave a high-AX empty read at `mid`, the same mistake one notch quieter. `scoring.evidence` carries the candidate count and a `sufficient` flag so a caller can say "no recommendation" instead of printing a tier that rests on nothing.
- **The offline router escalated on evidence it never measured**, in two ways, both through a fail-safe bump rather than the score. Fixture corpora no longer carry a risk flag: otito has no checkout of its own, so `add refund handling to checkout` ranked an eval fixture first and escalated to premium on money-flow evidence from a corpus that ships nothing. Test data still counts toward reach, it is a real file the change touches, but risk has to be about shipped code. And the offline estimator now reports **no** confidence rather than the peak of its own distribution: `distribute(0.6)`, the baseline for any request the keyword lists do not recognise, peaks at 0.40, under the 0.55 floor, so every unrecognised request was bumped a tier and the offline default was "spend more". A measured confidence below the floor still escalates.
- **A test that only passed on a machine without `TYPESAFE_API_KEY`.** `askJev` falls back to the environment, so the missing-key assertion was handing a real key to its own stub and asserting the wrong error. It now controls the variable instead of depending on it.

## [1.12.0] - 2026-09-19

### Added

- **Model routing (`scripts/model-route.mjs`) and [the routing doc](docs/18-model-routing/README.md).** Score a coding task before any tokens are spent on it and recommend a cheap, mid, or premium model tier. otito answers the repository half deterministically (AX, containment, canonical risk flags); a System One model answers the request half with calibrated probabilities over three narrow typed questions. Host agnostic by design: `--tier-only` prints the tier for any host to map, `--host <id>` prints that host's model name, and maps live in `.otito/model-route.json` so nothing about the scoring is specific to one IDE.
  - **The router runs before work starts and never touches the gate.** It decides how much model to spend; the gate decides whether a change may merge. A failed, unreachable, or unkeyed model call falls back to a local estimate that labels itself uncalibrated, and costs a tier, never a verdict. The gate never asks.
  - It ships **advisory**: it prints a recommendation and does not pick a model. The share weights and the band thresholds were chosen by judgement and have never been compared to an outcome, which is the same critique [the calibration thesis](docs/17-calibration-thesis/README.md) makes of `inferRisk`. Promoting it past advisory needs a backtest measuring regret, tasks routed cheap that ended in a revert or repair, against the spend avoided.
  - Dogfooded on a production Next.js application, where the first pass routed every request to premium and surfaced two defects worth recording. A question whose answer never moves carries no information however well calibrated it is: asked as a yes/no, "is this request ambiguous enough that a wrong reading produces the wrong change?" returned 0.57 to 0.81 for every request including a typo fix. And band thresholds belong to the quantity they were drawn for: subtracting flat points from AX while still banding at AX's own 45/75 is sufficient on its own to push a whole corpus into the most expensive tier.

### Changed

- **`docs/index.md` lists the calibration thesis.** Doc 17 shipped in 1.11.0 without its row in the documentation pack table.

## [1.11.0] - 2026-09-19

### Added

- **`otito calibrate <repo>`, grade the risk flags against the repository's own history.** Walks history, recovers which commits each later fix actually repaired, and reports per-flag hit rate and lift beside the weight that flag carries today. Local, offline, and a pure function of repository state, with a receipt over a canonical timestamp-free payload so a number quoted in a README can be traced to the run that produced it.
  - The join is line-overlap (SZZ): for each fix commit, blame the exact pre-image lines it modifies at its parent, and treat the commits owning those lines as the ones it repairs. Joining on "same file" instead measures co-change, on a 1,178-commit corpus that join calls 91.4% of commits repaired at a 90-day window against 30.7% for this one.
  - A minimum-sample rule withholds rate and lift for any row beneath the floor (default 30) rather than publishing noise, and reports band ordering as `unknown` rather than true or false when a band never cleared it. Pointed at this repository the command declines to answer most rows, which is the honest result for a corpus this small.
- **`dependency` risk flag**, reported for manifests and lockfiles. It is scored at **zero**: measured across two corpora it lifts 0.53x and 1.05x against the repair base rate, no consistent signal in either direction.

### Fixed

- **`configuration` fired on most changes and inverted the risk bands.** It was two signals under one name: commits touching only a manifest were repaired at 0.42x the base rate, commits touching a real config file at 2.03x, a 4.8x separation stable at every window from 7 to 90 days. Merged, the two cancelled out, and the +2 a lockfile bump carried pushed hundreds of low-risk commits into `medium`, making `medium` changes _less_ likely to be repaired than `low` at every window. Separating dependency churn restores monotonic ordering, confirmed independently on a third repository that had no part in the change.
- **`configuration` matched far more than configuration.** `"package.json"` matched as a raw substring of any path, so every nested manifest flagged, on this repository 14 of 17 matching manifests were eval fixtures. `"config"`, `"lock"` and `"env"` matched as bare word tokens, flagging `src/lib/config.js`, `src/lib/locks/advisory-lock.ts` and `src/env/index.ts`. Matching is now anchored to whole basenames, basename families, and whole directory segments; `"docker"` and `"tsconfig"` survive as tokens because across 3,455 commits in two repositories they produced no false positives.
- **A zero-weight flag could gate a merge on its own.** `isGateRiskPath` gated on any flag being present, so a lockfile bump demanded that a maintainer record explicit review of a "risk-sensitive scope" while the scorer weighed the same change at zero. Gating now requires a flag that scores; an unrecognised flag still gates, so adding one without a weight fails safe. Supply-chain concerns remain covered by the separate dependency audit check.
- **The high-risk policy profile contradicted its own run.** It called the unfiltered risk matcher, so a change touching only `tests/checkout.spec.ts` and `docs/auth-guide.md` produced `Risk review: PASS, No obvious risk-sensitive file paths changed` alongside `Policy profile: FAIL` naming those exact files as high-risk changes.
- **PR risk scored test files' flags.** A diff touching only `tests/checkout.spec.ts` scored `["money flow"]` and shipped a review prompt about idempotency, webhooks and refunds. Flags now come from non-test files; per-file `riskFlags` are unchanged, so a reviewer still sees why a spec was included. Measured over 2,294 commits: 3.8% change score, 1.0% change band.
- **Convergence weighted drifted files by the concept their name mentions.** `docs/auth-guide.md` cost 20 more risk-alignment points than `docs/setup-guide.md`, two documentation files separated by a substring, and appeared in the "Drift touches risk-sensitive paths" recommendation at the same weight as a genuine auth path. This restores the behaviour the convergence spec already documented: "a drifted README barely moves it".

### Changed

- Risk score weights are exported as `RISK_SCORE_WEIGHTS` and summed by `inferRisk`, replacing eight hand-written conditionals with the same numbers, so `otito calibrate` can report a measured lift beside the real weight instead of keeping a second copy in sync by hand.
- The risk eval corpus grows to 22 cases with guards for the dependency split, the anchored configuration matching, and the zero-weight gating rule. Its accuracy floor moves to 0.96 so that a single failing case still trips the gate at the new corpus size.

### Docs

- The [calibration thesis](docs/17-calibration-thesis/README.md) records the first measurement, the second corpus, and the first real calibration, including a claim it had to withdraw once a third corpus disagreed, and a note explaining why the same repository appears with two different scoreable-commit counts.

## [1.10.1] - 2026-09-15

### Docs

- **How It Works diagram generated from the live tool catalog.** `docs/assets/otito-how-it-works.html` was last touched at the v1.0.x rebrand and drifted from what ships in 1.10.0, it still named a removed tool (`repo_catalog`), was missing two shipped MCP tools (`agent_experience`, `convergence_score`), and never mentioned Convergence, the project's core evidence argument. The diagram is now generated by `scripts/generate-how-it-works.mjs` from the same `getAgentTools()` catalog `mcp.js` and `otito agent-tools` use, so it can no longer drift from the shipped tool list.
- **Glama discoverability.** Added `glama.json` and a `Dockerfile` so the server can be claimed, built, and released on [Glama](https://glama.ai/mcp/servers/BASHBOP/otito).

## [1.10.0] - 2026-09-12

### Added

- Content-aware secret detection in the merge gates. `Secret safety` previously matched only file _names_, so a live credential pasted into ordinary source (`src/config.js`) passed the gate. Both the local and GitHub PR gates now also scan the exact changed blob, the staged tree in staged mode, the working tree otherwise, the PR head for a PR gate, against high-precision vendor credential formats (AWS, Stripe live, GitHub, Slack, Google, Anthropic, OpenAI, npm, PEM private keys) plus one entropy-gated generic rule that warns rather than blocks. Findings report `file:line` and never echo the matched value. An `otito:allow-secret` marker on the matching line (or the line above) suppresses a reviewed false positive.
- `validation.advisoryChangedFiles` in `change_impact` output and `drivers.advisoryChangedFiles` in `convergence_score`: changed files that were ranked, but only as non-load-bearing advisory leads.
- Two gate-effectiveness corpus cases: `secret-value-in-source-is-blocked` and `aligned-change-to-source-kind-owner-converges`. The corpus now proves one valid control, one convergence control, and seven blocked changes.

### Fixed

- Convergence could never ground a task in a repository whose implementation files classify as `kind: "source"`, libraries, CLIs, and most utility code. `requiredOwners` stayed empty, `grounded` was always false, and an exactly-correct change scored identically to a wholly unrelated one, which made `--min-convergence` unusable on that shape of repository. Impact role classification now falls back to the strongest directly-matching non-test, non-doc candidate when no conventional owner kind matches, guarded by a minimum score so a weak incidental match never becomes a coverage obligation.
- `change_impact` could report `verdict: "missed"` while `missedChangedFiles` was empty, which reads as a contradiction. Advisory-ranked changed files now have their own bucket, and every changed file lands in exactly one reported bucket.
- A missing or broken `typescript` install surfaced as a bare `Cannot find package 'typescript'` from deep inside the code map. The CLI now explains that it is a runtime dependency and how to reinstall it.

### Changed

- README trimmed from 610 to 139 lines: it now leads with real `impact` and `gate` output, and the design theses live on the documentation site rather than in a sixteen-item link list.

## [1.9.3] - 2026-09-12

### Fixed

- **Stale version references in docs.** `RELEASE.md`'s verify-binary example was pinned to `@bashbop/otito@1.0.2`, six releases behind. Removed the stale `(v2.3+)` tags on `agent_experience`/`convergence_score` in `docs/02-mcp-agent-workflows/README.md`, since both have shipped in every release since 2.3.0.

### Chore

- **Automate release-doc version sync.** `scripts/sync-server-version.mjs` now also rewrites the pinned `@bashbop/otito@X.Y.Z` install/verify commands and the docs "Status" line in `docs/index.md` and `RELEASE.md` on every `npm version` bump, alongside the existing `server.json` sync. `scripts/check-version.js` now fails `version:check` if those pins drift from `package.json`. Logic lives in `src/lib/version-docs.js`, unit tested.
- Bumped `@types/node` and `eslint` (dev dependencies) via Dependabot.

## [1.9.2] - 2026-09-07

### Docs

- **mcpservers.org listing.** otito's submission to [mcpservers.org](https://mcpservers.org/servers/bashbop/otito) was approved; added the listing badge to the README.

## [1.9.1] - 2026-09-06

### Fixed

- **context_pack / repo_search relevance for field-tracing queries.** Hotspots and Primary Files no longer get dominated by generic single-token overlap (e.g. "date", "booking" in an events app). Queries that name a specific field ("where is date of birth collected?") now boost files whose own text literally contains the compound identifier (`dateOfBirth`), and weight token matches by how common they are across the repo so a handful of high-frequency domain nouns can't outrank the files that actually reference the field.

## [1.9.0] - 2026-09-06

### Added

- **Herdr model-route action.** `bashbop.otito.model-route` scores the selected task with Otito AX and recommends a cheap / mid / premium model tier before starting an agent. Optional `prefix+m` binding is documented in the Herdr plugin README.
- **Host-agnostic model-router skill.** `codex/skills/model-router` maps AX bands (and risk bumps) to the same tiers for Cursor, Codex, Claude Code, Herdr, and other hosts.

### Docs

- **Herdr integration.** Docs site and plugin README list model-tier routing beside context, impact, review, and staged gate.
- **Docs site current with v1.9.0.** Homepage status, install pins, and What's New now match the published package.

### Maintenance

- **Release metadata alignment.** npm package metadata, the package lockfile, and the MCP Registry manifest now agree on v1.9.0.

## [1.8.1] - 2026-09-03

### Changed

- **Owner-file agent prompt.** Context packs now tell hosts to keep the change in the smallest owner files.

### Docs

- **Clean code as a trust-layer principle.** New thesis page: [docs/07-deterministic-verification/README.md](docs/07-deterministic-verification/README.md). Contributor, agent, and context-pack guidance now name the smallest owner file instead of a cleaner agent.
- **Public contributor path.** Add `CONTRIBUTING.md`, Contributor Covenant `CODE_OF_CONDUCT.md`, and [Contributor Governance](docs/03-contributor-governance/README.md) so the README links resolve and GitHub community files are present.
- **Docs site current with v1.8.1.** Homepage status, install pins, and What's New now match the published package.
- **License copyright.** MIT copyright holder is Oluwasegun Olumbe, matching the documentation site.

### Maintenance

- **Otito readiness check name.** The required CI job, pull request template, and `main` branch protection use Otito naming instead of the old PullPass label.
- **Public pilot intake.** Replace the company-packet issue template with a sanitized public pilot feedback form.
- **Editor config stays local.** `.cursor/` is gitignored; checkout-local MCP setup is documented in CONTRIBUTING.md.
- **Release metadata alignment.** npm package metadata, the package lockfile, and the MCP Registry manifest now agree on v1.8.1.

## [1.8.0] - 2026-08-21

### Added

- **Herdr trust workspace integration.** Run Otito context, impact, review, doctor, and exact staged-tree validation from Herdr while keeping the two tools as separate authorities.
- **Interactive trust-status popup.** Scan repository, comparison base, verdict, confidence, change size, risk, and attention items in responsive terminal tables with semantic status colours and a `NO_COLOR` fallback.

### Safety

- **Explicit authority boundaries.** The plugin does not merge, push, commit, or approve changes, and its local evidence does not replace hosted CI, CODEOWNERS approval, unresolved-comment checks, or the human merge decision.

### Docs

- Added installation, local-development, action, popup, and agent-workspace guidance to the README and documentation site.

### Maintenance

- **Release metadata alignment.** npm package metadata, the package lockfile, and the MCP Registry manifest now agree on v1.8.0.

## [1.7.0] - 2026-08-17

### Added

- **Gate-effectiveness evaluation.** `otito eval --gate-effectiveness` runs the real staged local gate against a committed valid control and six adversarial change-sets, asserting both the overall verdict and named deterministic reason. `npm run eval:gate` is part of the release quality gate, and tarball smoke verifies the installed package can run the corpus.

### Safety

- **Fixture-only gate proof.** Gate eval cases create isolated temporary Git repositories from reviewed committed fixtures. Corpus entries cannot supply commands, redirect execution outside `evals/fixtures/`, or use path-like change-set names; customer repositories are never executed.

### Docs

- **Trust harness positioning.** Lead with independent merge evidence rather than a cheaper or smarter model loop. New thesis page: [docs/07-deterministic-verification/README.md](docs/07-deterministic-verification/README.md).

### Maintenance

- **Release metadata alignment.** npm package metadata, the package lockfile, and the MCP Registry manifest now agree on v1.7.0.

## [1.6.2] - 2026-08-15

### Changed

- **Faster CLI startup.** Commands now load their implementation modules only when invoked, so lightweight paths such as `otito --version` and `otito help` avoid loading the TypeScript analysis engine.

### Added

- **Repeatable CLI benchmarks.** `npm run benchmark:cli` measures version, help, and full context execution with human-readable or JSON output for same-machine comparisons.
- **Lazy-loading regression coverage.** Subprocess tests fail if lightweight commands begin importing the TypeScript analysis engine again.

## [1.6.1] - 2026-08-12

### Changed

- **Shared terminal summaries.** Catalog, init, install, and related CLI surfaces now use a compact human-first terminal summary helper. JSON and Markdown outputs stay on their dedicated serializers.

### Docs

- Expanded harness, dual-mode, and prompt-determinism thesis pages, plus executive-summary and site index updates.

### Maintenance

- Dev dependency minor and patch bumps.

## [1.6.0] - 2026-08-02

### Added

- **Template-aware convergence.** Handlebars templates, translations, feature-flag configuration, snapshots, and changelogs now participate in code maps and expected supporting-change fan-out.
- **Campaign email retrieval evaluation.** A generic, cross-repository fixture protects template and owner ranking learned from real Audience Studio work.
- **Versioned validation policy.** Otito can execute an approved base-committed validation plan against the exact staged tree and retain a bounded, privacy-preserving receipt.

### Changed

- **Actionable gate evidence.** Impact distinguishes required owners from supporting artifacts and advisory inspection leads; bouncer and production-configuration warnings state their exact repair or maintainer action.

## [1.3.0] - 2026-08-02

### Added

- **Workspace staged Gate.** `otito workspace-gate` binds two or more repositories' exact staged Git trees, local-gate checks, and validation receipts into one deterministic parent receipt for a product change.
- **Executed validation receipts.** `otito gate --staged --run-validation` runs a versioned base-committed validation plan against an isolated materialisation of the staged tree, pins package-manager script identity to the selected base (including npm, pnpm, Yarn, Bun, and Corepack forms), uses a scrubbed opt-in environment, and records bounded command outcomes and hashes without retaining raw output.
- **Trusted-agent workflow guidance.** The same local-first workflow is documented for Codex, Claude, Cursor, Gemini, Kimi, and structured handoffs; GitHub review, hosted CI, and mergeability remain separate authorities.

### Changed

- **More accurate change impact.** Handlebars templates, translations, feature-flag configuration, snapshots, and changelogs are indexed. Impact now distinguishes required owners from predictable supporting fan-out and advisory inspection leads.
- **Actionable risk and compliance warnings.** Production configuration warnings state the maintainer approval or safe unstage action; bouncer evidence includes its repair action and a reproducible recheck command.

## [1.2.1] - 2026-07-30

### Fixed

- **Standard CLI version flags.** `otito --version` and `otito -v` now print the exact installed package version and exit successfully. The packed-tarball smoke test protects the npm binary path against regressions.

## [1.2.0] - 2026-07-30

### Added

- **Explicit anonymous usage sharing.** Developers can opt in with `otito telemetry share on` and opt out again with `otito telemetry share off`. Otito sends a fixed nine-field command outcome event through the first-party Bashbop relay.

### Privacy

- **Off by default and shape only.** Usage sharing remains disabled until the developer opts in, and disabling local telemetry also disables sharing. Events exclude prompts, arguments, paths, repository names, source code, errors, receipts, user identities, and email addresses.

## [1.1.1] - 2026-07-29

### Fixed

- **Plain-English signup verification context.** Questions such as “where is email verification implemented during signup?” now prioritise the registration controller, OTP verification, and unverified-login flow ahead of generic email operations.
- **Readable terminal context reports.** `otito context` now presents its detailed report with colour-aware sections, emojis, ranked hotspots, focused route summaries, tests, commands, and an agent handoff. Markdown artifacts and JSON output remain unchanged.

### Added

- **Signup verification retrieval evaluation.** The scored corpus now protects the plain-English authentication query against future ranking regressions.

## [1.1.0] - 2026-07-29

### Added

- **Harness execution eval.** `otito eval --harness` now proves that Otito infers and can run the encoded install, test, typecheck, and build commands against an isolated, committed fixture. `npm run eval:harness` is part of the release quality gate.

### Safety

- **Fixture-only execution boundary.** Harness execution accepts only vetted package-manager command forms, disables install lifecycle scripts, applies a timeout, and rejects corpus entries outside Otito's committed `evals/fixtures` directory. It never executes a command inferred from a customer repository.

## [1.0.3] - 2026-07-29

### Fixed

- **Trustworthy impact evidence.** Change impact now surfaces every mapped file from the requested Git diff as exact evidence, preserves the heuristic-only scorecard, and reports unmapped files explicitly.
- **Read-only repository inspection.** Code-map caching now lives in a per-user external cache rather than creating `.otito/index.json` inside inspected repositories.
- **Composite review statistics.** Review summaries now report the actual additions and deletions from the PR comparison.
- **Generated artifact hygiene.** Formatting ignores legacy generated context reports so source validation reflects the checked-in source.

## [1.0.2] - 2026-07-29

### Fixed

- **MCP Registry ownership namespace.** The manifest and published package now use the exact GitHub OIDC namespace granted to Bashbop: `io.github.BASHBOP/otito`. This allows the signed release workflow to publish the server to the MCP Registry.

## [1.0.1] - 2026-07-29

### Fixed

- **Trusted npm publishing.** Releases now use GitHub Actions OIDC for provenance; the temporary bootstrap token path has been removed.
- **Colour-stable release validation.** Terminal colour settings no longer block the release test suite.

## [1.0.0] - 2026-07-29

### Changed

- **Clean product cutover to Òtítọ́.** The package is now `@bashbop/otito`, the CLI is `otito`, and the MCP server identity is `io.github.bashbop/otito`.
- **Fresh configuration and artifact namespaces.** Configuration uses `.otitorc.json`, `~/.config/otito/config.json`, and `OTITO_*` environment variables. Local evidence artifacts, indexes, catalog, and telemetry now live under `.otito/`.
- **Bashbop stewardship.** Repository, documentation, release, and MCP metadata now point to Bashbop Ltd. The public contributor programme material has been removed while the protected-review rule remains owned by the Bashbop team.

## [1.1.2] - 2026-07-30

### Fixed

- **Plain-language developer routing.** Context now caps dense type/export evidence, recognises QR check-in vocabulary, and retains form-control identifiers for privacy and configuration questions. This keeps behaviour-owning screens, controllers, and hotspots ahead of support-only declarations.

### Added

- **Exact change-subject convergence receipts.** Receipt v2 binds staged convergence to the resolved base, parent commit, and immutable Git index tree; GitHub PR convergence binds to the target repository, PR number, and exact base/head OIDs. Legacy subject-less receipt IDs remain unchanged.

### Changed

- `repoctx converge --staged` and the MCP `convergence_score` staged option now measure the captured index tree. Snapshot scoring streams raw Git blobs without executing checkout filters, caps exact-subject analysis at 5,000 source files or 64 MiB, ignores local replace refs, and preserves NUL-delimited paths. Diff comparisons force changed gitlinks to remain visible and fix rename detection at 50% with a 1,000-candidate ceiling. PR verification uses GitHub's merge-base-to-head file semantics and fails closed on missing OIDs, an incomplete file list, a mismatched local head, or a dirty checkout. Subject-bound enforcement uses the full SHA-256 inputs hash; the 12-hex `rcpt_` value remains a display handle.

## [2.6.0] - 2026-07-27

### Added

- **Automatic staged pre-commit Gate.** `repoctx gate --staged` now evaluates exactly the files already staged for commit, provides an opt-in Git hook installer, and records scope-aware receipts. The same staged safety check is available through the built-in MCP server for IDE and agent integrations.

## [2.5.0] - 2026-07-24

### Release note

- Version 2.4.0 was prepared in source but was never tagged or published. Version 2.5.0 is the first public package since 2.3.1 and includes the complete change set below.

### Added

- **Load-bearing convergence evidence in merge gates.** `repoctx gate` can now recompute a task-to-diff convergence score, enforce `--min-convergence`, and verify a supplied `--receipt`; the same options are available through the MCP review gate so agents and humans can require matching intent before merge.
- **Tieline contract evidence in local gates.** Repositories with `tieline.config.json` now receive deterministic frontend-to-backend contract-drift results as first-class Gate evidence.
- **Bouncer compliance evidence in local gates.** Repositories with `bouncer.config.json` now receive configured compliance-control findings with explicit pass, warning, or fail status.
- **Aiglare AI-governance evidence in local gates.** Setting `REPOCTX_AIGLARE=1` adds irreversible AI-surface checks to the Gate receipt, including blocking guardrail failures.
- **TypeScript/JavaScript class methods in the code map** so Nest services expose `sendX` / `resolveY` symbols (including arrow property methods), not only top-level classes/types.
- **Context engine v2 answer-shaped packs**: multi-token method hotspots, domain diversification in primary files, plural/British spelling token variants, and topic→domain implementation boosts so queries like email branding land on `email.service.ts` instead of flooding with booking controllers.
- **Index cache version bump to 5** so existing `.dev-context/index.json` files regenerate and pick up method symbols.
- **`repoctx-self-improve` skill** (gated self-eval loop): score context gaps, add corpus/fixture cases, fix ranking/extractors, verify with `score-gap.mjs`, commit/PR only when asked.

### Changed

- **Gate evidence engine v2** resolves configured, workspace-local, Repoctx-local, IDE-bundled, or PATH tool binaries without shell-composed commands and records their structured evidence in the durable Gate report.
- **Durable post-merge audit reconciliation** now runs after successful CI, recovers Dependabot auto-merges that suppress push workflows, validates and backfills missing first-parent commits, archives the incomplete pilot v1 ledger, and persists the verified canonical hash chain on an `audit-ledger` branch plus per-commit artifacts.
- **CI trigger and dependency maintenance policy** now runs branch validation once per PR, reserves push validation for `main`, adopts `actions/setup-node@v7`, and requires explicit migration work for TypeScript major upgrades.

### Fixed

- **Historical attestation metadata** now resolves the PR, author, and commit time from the commit being attested instead of whichever commit happens to be checked out.
- **Blocking audit verdicts** are now recorded faithfully instead of treating a valid nonzero `FAIL` result as unavailable and silently replacing it with diff fallback.
- **Release documentation** now matches npm and MCP Registry OIDC trusted publishing instead of referring to a removed `NPM_TOKEN` flow.

## [2.3.1] - 2026-07-01

### Fixed

- **Ship `evals/` in the npm package** so `repoctx eval --accuracy` works from a global install; tarball smoke now verifies it.
- **Consolidate accuracy eval fixtures under `evals/fixtures/`** so the published tarball is self-contained (no dependency on `codex/skills/.../evals/files`).
- **Sync MCP docs to 13 canonical tools** (`agent_experience`, `convergence_score` added in 2.3); README, migration doc, and MCP workflow guide updated.
- **Add project `.cursor/mcp.json`** so Cursor loads repoctx MCP from a local checkout without a global install.
- **Link audit-pilot** from the trust-layer demo walkthrough as the post-merge attestation example.
- **Post-merge attestation CI** on pushes to `main` via `scripts/post-merge-attest.sh`.
- **`tests/gh.test.js`** and **`tests/attest.test.js`** for `gh.js` and audit-chain verification.
- **Procedure skills** under `codex/skills/repoctx-{context,review,scope}/`.
- **`docs/MIGRATION-3.0.md`** pre-migration checklist for the v3.0 alias removal.

## [2.3.0] - 2026-06-20

### Deprecated

- **The `dev-context` command alias is deprecated and will be removed in v3.0.0.** Use `repoctx`. Invoking the CLI through the `dev-context` bin now prints a deprecation warning to stderr (never on `--json` stdout). The `.dev-context/` output directory is unaffected, it is not part of the deprecation.

### Added

- **`repoctx dashboard` renders a local usage & performance UI.** A new opt-in telemetry layer records one JSONL line per CLI run and per MCP tool call to `~/.dev-context/usage.jsonl` (command, arg _shape_, keys only, latency, outcome, and the value signals each command already produces). `repoctx dashboard` aggregates that log (plus existing `.dev-context` artifacts and recent git history) into ONE self-contained HTML file, no server, no chart library, no network, with interpretation tooltips on every tile and chart and a "what this can't show" honesty panel. Capture is **off by default** and strictly local: gated by the `telemetry` config key or `REPOCTX_TELEMETRY`, forced off under CI, never written to stdout or the MCP JSON-RPC channel (a determinism-firewall test enforces byte-identical output on/off), and error text is reduced to a code/class so no paths leak. Manage it with `repoctx telemetry status|on|off|clear`.
- **`repoctx ax "<task>" --path .` scores Agent Experience (AX).** A single 0–100 number for "how cheap and safe is it for an agent to make this change here?", blending Changeability (token cost), Containment (blast radius), Guardrails (tests/validation/CODEOWNERS/CI), and Clarity. Deterministic and composed from the existing `impact`, `tokens`, and `codeowners` engines, no new analysis. Supports `--json` and `--out`, and is exposed over MCP as the `agent_experience` tool (the MCP surface bumps from 11 to 12 tools). See [docs/07-deterministic-verification/ax-score-spec.md](docs/07-deterministic-verification/ax-score-spec.md).
- **`repoctx converge "<task>" --base <ref>` scores convergence.** A deterministic 0–100 measure of the distance between a stated task (intent) and the actual git diff (execution), with sub-scores for Coverage (did the intent happen?), Scope (did only the intent happen?), and Risk alignment (did unrequested drift land on risk-sensitive paths?). Emits a recomputable, timestamp-free receipt as durable evidence. Composed from the `change_impact` diff comparison and the shared risk vocabulary, no model, no new analysis. Supports `--json` and `--out`, and is exposed over MCP as the `convergence_score` tool (the MCP surface bumps from 12 to 13 tools). See [docs/07-deterministic-verification/convergence-score-spec.md](docs/07-deterministic-verification/convergence-score-spec.md).
- **`postinstall` runs `repoctx doctor` after a global install.** `npm install -g @nugehs/repoctx` now prints an environment readiness summary. The hook is guarded: it runs only for global installs (`npm_config_global=true`), skips in CI and when `REPOCTX_SKIP_POSTINSTALL` is set, and always exits 0 so it can never fail an install.

## [2.2.0] - 2026-06-17

### Added

- **ANSI color in the terminal renderer.** `createRenderer` now colorizes status lines (green/yellow/red), verdicts (bold + colored), tips (cyan), and dims box borders. Color is opt-in by detection and fully spec-compliant: `NO_COLOR` (any value) disables it, `FORCE_COLOR`/`CLICOLOR` force it, and it stays off when stdout is not a TTY (pipes, CI, test runners) so machine-readable output is never polluted. `visualWidth()` strips ANSI escapes before measuring, so box alignment is unaffected. New `--color` / `--no-color` flags.
- **Persistent configuration.** New `src/lib/config.js` loads merged settings with precedence defaults → user global (`~/.config/repoctx/config.json`, honoring `XDG_CONFIG_HOME`) → repo-local (`.repoctxrc.json`, walked up from the cwd) → environment (`REPOCTX_EMOJI`, `REPOCTX_COLOR`, `REPOCTX_THEME`, `REPOCTX_WIDTH`, `NO_COLOR`) → CLI flags. New `repoctx config get|set|list` command, with `set --local` writing to `.repoctxrc.json`. Known keys: `emoji`, `color`, `theme`, `width`, `policy`, `governance`.
- **Named themes** (`--theme <name>` or the `theme` config key): `default` (auto-detect), `color` (force color on), `minimal` (pure ASCII, no emoji or color), and `high-contrast` (bright ANSI palette). Themes set defaults that explicit `--color`/`--emoji` flags still override.
- **Mermaid diagram export** via `--mermaid` on `impact`, `map`, `workspace`, `data-access`, `review`, and `report`. Prints a fenced `mermaid` block to stdout, or writes a file with `--out`. Diagrams: impact concept/file flowchart, code-map domain distribution (`xychart-beta`), workspace repo-integration graph, data-access file→table flowchart, review gate-to-verdict flowchart, and a report language `pie` chart.

## [2.1.0] - 2026-06-12

### Added

- **`repoctx init` now scaffolds a real CI quality gate and an optional pre-commit hook**, derived from `repoctx harness`. The generated `repoctx-ci.yml` gains a `quality` job that runs the project's detected setup + validation commands (install → lint/typecheck/test/build/audit, with toolchain setup for npm/pnpm/yarn/bun) alongside the existing PR-review job. A dependency-free `.githooks/pre-commit` hook runs only the fast static checks (lint/format:check/typecheck), slow gates stay in CI. Repos with no detectable scripts are unchanged (review-only workflow, no hook).
- `init` prompts interactively only at a TTY; MCP, agents, CI, and `--json`/`--yes` callers stay fully non-interactive. New flags: `--no-gates`, `--no-precommit`, `--hooks-path` (sets `git core.hooksPath .githooks` with consent), and `--yes`. `initProject()` stays pure, all decisions arrive as explicit options.
- CI install steps use frozen lockfile installs only when the matching lockfile is present; lockfile-less repos keep a plain install command.

## [2.0.0] - 2026-06-10

Major version: the MCP tool surface changed. Every legacy tool name still works via `tools/call` (guaranteed until 3.0), see [docs/MIGRATION-2.0.md](docs/MIGRATION-2.0.md).

### Changed

- **MCP tool surface consolidated from 18 tools to 11.** `pr_review` → `review_context`, `review_pr` → `review_verdict`; `merge_readiness` + `pr_merge_readiness` → `review_gate` (a `pr` param selects local vs GitHub mode); the four `find_*` tools fold into `repo_map` (new `route` param); `repo_catalog` folds into `repo_search` (query now optional); `repo_discover` folds into `repo_index` (new `dryRun` param). `tools/list` advertises the 11 canonical tools; all 18 legacy names keep working through a back-compat alias layer.
- The whole `src/` tree is now type-checked: `checkJs` is enabled and the codebase carries JSDoc annotations (1393 → 0 errors), so `npm run typecheck` is a real type check rather than syntax-only. No runtime behavior changed.

### Added

- **Accuracy eval corpus.** `repoctx eval --accuracy` scores retrieval precision@5 / recall@5 / MRR and risk-classification accuracy against a 32-case labeled corpus, exiting non-zero below tunable thresholds. Wired into the quality gate so retrieval/risk regressions now block CI. Baseline: p@5 0.933, r@5 1.0, MRR 1.0, risk accuracy 1.0. See [docs/EVALS.md](docs/EVALS.md).
- `repoctx gate <repo>` (local) / `gate --pr <selector>` (GitHub), the canonical CLI merge-gate command; `pass`/`pass-pr` remain as aliases.

## [1.5.0] - 2026-06-10

### Fixed

- Risk classification precision: whole-token concept matching ('fix payload parsing' no longer flags money flow), singularized path tokens (`roles.guard.ts` now flags auth/security), basename-pattern secret detection (`dev.environments.ts` and docs no longer hard-fail the gate), and gate-mode filtering so test/doc-only changes stop drawing risk warnings.
- `repoctx pr` now uses the shared risk classifier, `pr` and `pass` agree on the same diff.
- Impact ranking: one stray concept can no longer halve every non-matching file's score.
- Index cache: atomic writes, warn-once on write failure, bounded in-process memo for repeated MCP calls.
- `init` adds `.dev-context/` to the target repo's `.gitignore`, so first-call index caching no longer dirties working trees.

### Changed

- MCP transport slimmed: compact JSON (no pretty-printing), duplicate `structuredContent` removed, `includeMarkdown` returns the markdown report as the response text; `repo_inspect`/`context_pack` payloads gate file lists, script bodies, and per-file evidence behind opt-ins. Tools declare `readOnlyHint` annotations; the review-family tool descriptions disambiguate each other; `repo_search` hints at `repo_index` when the catalog is empty.
- `agent-tools` catalog is derived from the MCP tools array (was a drifted hand-maintained copy), with a parity test.
- README leads with the deterministic merge gates; code-map docs reflect the multi-language extractors.

### Added

- `doctor` checks for the `gh` CLI (required by `pr_merge_readiness`).
- 72 new tests (242 total): gate fallback paths, cache staleness/corruption/atomicity, parser-path coverage, and pins on every fixed false positive/negative.

## [1.4.3] - 2026-06-10

### Note

- Published automatically by the tag-triggered release workflow when the `v1.4.3` tag landed; 1.5.0 followed minutes later with the review-findings batch.

### Fixed

- **Critical:** the npm-installed `repoctx` / `dev-context` bins were silent no-ops in 1.4.0–1.4.2. The invoked-as-script guard compared `import.meta.url` (realpath-resolved by the ESM loader) against `argv[1]` (the npm bin symlink), so `main()` never ran via `npx` or `npm i -g`. Realpaths are now compared on both sides.
- MCP server no longer responds to JSON-RPC notifications (e.g. `notifications/cancelled`); previously unknown notifications received a spec-violating `-32601` error with no id.
- MCP `initialize` now negotiates `protocolVersion`: a supported client revision (2024-11-05, 2025-03-26, 2025-06-18) is echoed back instead of always forcing the latest.

### Added

- Packed-tarball smoke test (`npm run smoke:tarball`, part of `npm run smoke` / the quality gate): packs the real tarball, installs it into a temp project, and runs the installed bin, the seam that let the broken bins ship undetected.

## [1.4.2] - 2026-06-10

### Added

- README: demo GIF.
- `version` lifecycle hook: `npm version` now syncs `server.json` with `package.json` automatically, so `version:check` can no longer block a release.

### Changed

- README badges use semantic colors instead of brand red.

### Note

- 1.4.1 was tagged but never published: `version:check` correctly blocked the npm publish because `server.json` still said 1.4.0. Superseded by 1.4.2.

## [1.4.0] - 2026-06-09

- **Fix `context_pack` returning zero primary files on small repos.** When task keywords match nothing in the index (common for broad queries like "improve SEO and performance" against a small Vite/React repo), `repoctx context` now falls back to a deterministic ranking of repo entrypoints, `main`/`app`/`index` files, and build configuration (`vite.config.*`, `webpack.config.*`, etc.), so `primaryFiles` is never empty while the repo has source files. An open question notes when the fallback was used; behavior for queries that do match the index is unchanged.
- **Soften release discipline for private repos under solo governance.** "Version metadata changed without a changelog update" is now `WARN` instead of `FAIL` when the repo's `package.json` has `"private": true` and `--governance solo` is active, a private site repo bumping its version is not a release. Public or publishable packages and team governance keep the hard `FAIL`, and version-file mismatches ("Version metadata files do not agree") remain `FAIL` in every configuration.
- Brand alignment: toolchain footer/badges.
- **GitHub Releases now cut automatically.** `.github/workflows/release.yml` gains a `github-release` job: after the npm publish succeeds, it extracts the matching version section from `CHANGELOG.md` and creates a GitHub Release for the pushed `v*` tag, so the Releases page stays in sync with npm.
- **README comparison section.** Add a factual "repoctx vs alternatives" table (Sourcegraph/Cody context, hand-written `CLAUDE.md` rules files, `grep`/`ripgrep`) so newcomers can place the tool quickly.

## v1.3.3 - 2026-06-05

- **Fix release-discipline false positive on dependency bumps.** `repoctx review`/`pass` no longer reports `FAIL` when a dependency or lockfile update touches `package.json`/`package-lock.json` without a changelog entry. Release discipline now compares the project version against the base ref and only requires a changelog when the version actually changes. This unblocks the `PullPass readiness` gate for Dependabot and other dependency PRs.

## v1.3.2 - 2026-06-05

- **Automated release pipeline.** Pushing a `vX.Y.Z` tag now publishes to npm with provenance, then publishes `server.json` to the MCP Registry via GitHub OIDC (`.github/workflows/release.yml`). A `prepublishOnly` gate runs the full quality suite before any publish.
- **Version drift guard.** `version:check` now fails the build unless `server.json` (manifest and package versions) matches `package.json`, so the npm package and the MCP manifest can never desync.
- **Real merge-readiness gate.** The required `PullPass readiness` status check is now produced by CI running repoctx's own `review` command (impact + PR review + local pass) on the diff, exiting non-zero only on a blocking `FAIL`. repoctx now dogfoods its own merge gate.
- **Trust signals.** Add `CODE_OF_CONDUCT.md`, README status badges (npm, CI, license, Node), and npm publish provenance.
- **Docs slimmed for the public site.** Remove internal go-to-market and historical pages (company demo/pilot material, dated proof/launch notes, the absorption study, the standalone roadmap, and the slide deck); the trust-layer section keeps a single conceptual overview.
- **Dependency hygiene.** Group Dependabot updates (GitHub Actions into one PR, npm minor/patch into another) and auto-merge low-risk patch/minor bumps once checks pass. Bump CI actions to current majors.

## v1.3.1 - 2026-06-02

- **Release-readiness cleanup.** Fix CI blockers by formatting the changelog and removing an unused `code-map` helper that tripped ESLint.
- **Version alignment.** Keep npm package metadata, `package-lock.json`, MCP registry manifest versions, and public docs aligned on v1.3.1.
- **Canonical impact workflow.** Update the builder-founder operating loop to use `repoctx impact` instead of the absorbed standalone `impact-map` analyzer.

## v1.3.0 - 2026-06-02

- **Documentation site brought current with v1.1 and v1.2.** Headline version stamps on `docs/index.md`, `docs/EXECUTIVE-SUMMARY.md`, and `docs/presentation.md` now reflect v1.2.0. Capability tables surface the `repoctx eval` token-savings suite, the `repoctx data-access` inline-SQL / Prisma surface, C# / Python / Java / Ruby / Rust code-map extractors, the vendor-bundle filter, and multi-domain file tagging (`domains: string[]`).
- **ROADMAP** gains Phase 2.6 (v1.1.0, eval, data-access, broader languages) and Phase 2.7 (v1.2.0, multi-domain discoverability), both marked complete.
- **MCP tool surface table** annotates `repo_map` with all eight supported languages, annotates `find_domain` with the multi-domain tag set, and adds two tools that were shipping but undocumented: `find_backend_route` and `find_frontend_api_client`.
- **`deploy-docs.yml` now triggers on `CHANGELOG.md`** so release commits redeploy the published site automatically, not just commits that touch `docs/**` or `mkdocs.yml`.

## v1.2.0 - 2026-06-01

- **Multi-domain discoverability.** Files in feature subdirs are now tagged under both their root domain _and_ the feature name. Previously `components/livestream/RecordingsPanel.tsx` lived only under `components`, so `find_domain('livestream')` returned zero. Now the same file matches both `components` and `livestream`. File records gain a `domains: string[]` field carrying the full tag set; the existing `domain` field keeps the primary classification for display and scoring. `find_domain`, `filterFiles` (kind/domain filter), `findFrontendApiClient`, and `context_pack` scoring (in both `catalog.js` and `context-engine.js`) all read from the full set. `summarizeDomains` now counts a file under each of its tags, so the per-repo domain summary on `repo_catalog` surfaces feature-level domains as first-class entries with their actual file counts.
- **Cache version bumped 3 → 4** because file records gained `domains`. On-disk `.dev-context/index.json` caches will rebuild on next access.
- **MCP registry manifest bumped to 1.2.0** so `server.json`, `package.json`, and `package-lock.json` publish the same release version.

## v1.1.0 - 2026-05-30

- **New: `repoctx eval` subcommand.** Runs a fixed task suite (`repo_overview`, `code_map`, `harness`, `context_pack`) on any target repo and reports tokens of repoctx output vs a deterministic naive-agent approximation. Includes a `coverage` column on `code_map` so a high savings% with low file coverage doesn't mask a language-adapter gap. `--json` output is CI-friendly for regression gating.
- **New: `repoctx data-access` subcommand.** Detects inline SQL strings (any language) and Prisma ORM calls; aggregates by source, operation, table, and file; produces a focused "data-access surface" report. New `dataAccess` field on file records; new `dataAccessFiles` / `dataAccessHits` summary keys; `context_pack` scoring boosts files that touch the DB by up to +15.
- **Language coverage: C#, Python, Java, Ruby, Rust.** Five new regex extractors following the Go-extractor precedent. C# captures `using`, `namespace`, `class`, `interface`, `struct`, `enum`, `record`, `method` with public/internal access. Python captures `import`/`from-import`, `class`, `def`/`async def`, with docstring/comment/string filtering. Java captures `import`, `package`, `class`, `interface`, `enum`, `record`, `method` with annotation-prefix tolerance. Ruby captures `require`/`require_relative`, `module`, `class`, `def`/`def self.x`, predicate/bang methods, with `=begin/=end` block-comment handling. Rust captures `use`, `mod`, `struct`, `enum`, `trait`, `fn`, `type` with `pub`/`pub(crate)` visibility.
- **Vendor-bundle filter for `context_pack` scoring.** New `isVendorFile` detector with four layers (vendor path segments, minified suffixes, library-name prefixes, line-length heuristic). Files marked `isVendor: true` are dropped from `context_pack` scoring so `js/Bootstrap.js`, `angular.min.js`, `jqueryv2.1.4.min.js` etc. no longer surface as primary or related files.
- **Cache version bumped 1 → 3** because file records gained `isVendor` and `dataAccess`. On-disk `.dev-context/index.json` caches will rebuild on next access.
- **`.gitignore`**: ignore Claude Code session state (`.claude/`) and Office lockfiles (`~$*`).

## v1.0.1 - 2026-05-29

- Add `mcpName: "io.github.nugehs/repoctx"` to `package.json`, required by the MCP Registry's ownership-proof check (the registry verifies that the published npm tarball declares the registry name it's claiming).
- Add `server.json` manifest at the repo root for publishing to the official MCP Registry at `https://registry.modelcontextprotocol.io/`. After this lands, `mcp-publisher publish` advertises `io.github.nugehs/repoctx` so any MCP host can discover and install repoctx as `npx -y @nugehs/repoctx mcp`.
- Round out `server.json` with `title`, `websiteUrl`, and `repository.id` so registry list views render a real display name + homepage and the registry can detect repo-resurrection attempts on the namespace.
- Trim the `server.json` description to fit the registry's 100-character cap (first publish attempt rejected at 272 chars).
- Track npm's normalization tweaks to `package.json` (relative `bin` paths, `git+`-prefixed `repository.url`) introduced by the v1.0.0 publish.

## v1.0.0 - 2026-05-29

- **Phase 1, shared risk vocabulary + fancy renderer.** New `src/lib/risk-paths.js` exports canonical risk flags (`auth/security`, `money flow`, `data model`, `request surface`, `frontend/backend contract`, `configuration`, `large file diff`, `secret risk`), `classifyPath()` with kind-aware matching, `conceptsFromQuery()` for closing the "Apple → auth" inference gap. New `src/lib/render/fancy.js` adds boxed headers, status glyphs, verdict blocks, and `--no-emoji` plain mode for CI logs.
- **Phase 2, `repoctx impact`.** Absorbs `impact-map`'s scoring formula and diff validation onto repoctx's AST code map. Concept-match boost, concept-mismatch penalty, path-token cap, owner-kind boost, and word-boundary risk classification fix the field-test regressions (Stripe refunds now ranks `stripe.processor.ts` #1, Apple sign-in now ranks `auth.controller.ts` #1).
- **Phase 3, `repoctx pass`.** Absorbs `pullpass`'s local merge gate. New `release-check.js`, `policy.js`, `pass-local.js` deliver the standard / company / high-risk policy profiles, team / solo governance, and the eight deterministic checks. Bashbop regression matches pullpass output exactly.
- **Phase 4, `repoctx pass-pr` + `repoctx review`.** Absorbs `pullpass`'s GitHub PR mode. New `codeowners.js`, `gh.js`, `pass-pr.js` deliver PR state, review decision, CODEOWNERS (with org/team membership), unresolved conversations (paginated GraphQL), branch protection, status checks (with annotation enrichment). New `review.js` ships the composite engine, impact + pr-review + pass in one call, with a derived confidence score.
- **New MCP tools.** `change_impact`, `merge_readiness`, `pr_merge_readiness`, `review_pr`.
- **Standalone repos.** `impact-map` and `pullpass` can be archived; repoctx is the canonical implementation.

## v0.3.2 - 2026-05-28

- Add Go source files to repoctx code maps.
- Classify Go `*_test.go` files as tests in code maps and PR review context.
- Keep deleted Go test files classified as tests through the PR fallback path.
- Suggest `go test ./...` for Go diffs in PR review context.

## v0.3.1 - 2026-05-28

- Add a public trust-layer demo walkthrough for repoctx plus PullPass.
- Add a dated trust-layer proof run with terminal captures for repoctx plus PullPass.

## v0.3.0 - 2026-05-28

- Add a MkDocs Material documentation site for repoctx.
- Add GitHub Pages deployment workflow for published docs.
- Add documentation sections for context foundation, MCP agent workflows, contributor governance, release readiness, roadmap, and glossary.
- Polish the docs home page card rendering and version labels.
- Add CI quality gates for format, lint, type/module validation, tests, coverage, audit, and smoke checks.
- Add governance docs for contributing, security reporting, code ownership, dependency updates, and releases.
- Add contributor issue/PR templates and document maintainer review before merge.
- Add SemVer release guidance and CI validation for package version consistency.
- Add a README design print and matching install identity print.
- Add local ESLint, Prettier, and TypeScript compiler configuration.
- Rename the canonical package/repository identity to `repoctx` while preserving the `dev-context` binary alias and `.dev-context/` artifact directory.
- Add a README usage examples table for common repoctx workflows.
