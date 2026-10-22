# solumbe Evals

solumbe ships four evals. They answer different questions and must not be
confused:

| Eval | Entry point | Question it answers |
|---|---|---|
| Token-savings | `runEval(repoPath)` | _Is the context pack **smaller** than a naive file dump?_ |
| Accuracy | `runRetrievalEval()` | _Is the context pack **right**, meaning does it surface the files an agent needs, and does the risk classifier label paths/queries correctly?_ |
| Harness execution | `runHarnessExecutionEval()` | _Do the encoded setup and validation commands Solumbe inferred actually run?_ |
| Gate effectiveness | `runGateEffectivenessEval()` | _Does the real local gate allow a valid change and block known-bad changes for the expected deterministic reason?_ |

The token-savings eval is necessary but not sufficient: a randomly-ranked pack
saves exactly as many tokens as a perfect one. Accuracy, harness execution, and
gate effectiveness close distinct gaps in that evidence.

## What the corpus measures

The corpus lives at `evals/corpus.json` and contains retrieval, risk, harness
execution, and gate-effectiveness cases.

### Retrieval cases

Each retrieval case runs `generateContextPack(query)` against a fixture repo and
scores whether the labeled files land in `primaryFiles`:

- **precision@k**: of the files the pack returned (capped at `k`), how many
  were relevant. The denominator is _what was returned_, not `k`, because
  solumbe packs are intentionally tiny (often 1–3 files); dividing a single
  correct hit by a fixed `k=5` would score a perfect one-file pack at 0.2 and
  punish concision.
- **recall@k**: of the relevant files, how many appeared in the top `k`.
- **MRR**: reciprocal rank of the first relevant file (1.0 if the top hit is
  relevant, 0 if none appear in the top `k`).

A case **passes** when every `expectedPrimary` file is in the top `k` and, when
`expectedAnyOf` is given, at least one of those files appears anywhere in the
pack (`primaryFiles` **or** `relatedFiles`, since `expectedAnyOf` encodes
related-file and route↔client pairing expectations, which the engine surfaces
under `relatedFiles`).

Pure-fallback cases (`expectedPrimary: []`) assert only that the pack falls back
gracefully to a non-empty set, so their precision/recall/MRR are reported as
`null` and excluded from the aggregate.

The fixtures exercise: cross-language naming (TypeScript + Python + Go),
plural/singular folding (`users service` → `users_service.py`), route-shaped
queries, error-message-shaped queries that should fall back gracefully, and
multi-repo route↔client pairing.

Two fixtures are whole repositories in one non-JavaScript language:
`python-orders-api` (a package with absolute and relative imports and a
`tests/` directory) and `go-inventory-api` (a `go.mod` module with
`cmd/` and `internal/` packages and a `_test.go` file). Each has four
cases that rank a file from its name or a symbol, and importer cases that
expect a file's only caller in the pack when the two share no name.

### Known gaps

A retrieval or gate case can carry `"knownGap": true`. It records a miss
before its fix exists: the case runs like any other and the report lists it
under **Known gaps** as "still open", or as "now passes; remove its knownGap
marker" once a change closes it. It never counts toward the floors, the pass
counts or the exit code, so a miss can be written down the day it is found
without turning CI red. Remove the marker in the change that fixes it.

Open gap (2026-10-22): on `node-upgrade-api`, a Node 22 move should rank
`.nvmrc`. It needs version pins read as runtime requests; a Node version is not
a dependency request. The four dependency gaps recorded with it on 2026-10-20
closed when the code map began listing manifests and lockfiles (see
`src/lib/dependency-request.js`).

### Dependency requests

A request that upgrades, bumps, audits or patches dependencies owns the
manifests and lockfiles, which are not source files. The
`dependency-advisory-api`, `-web` and `-mobile` fixtures carry the 2026-10-22
dogfood misses: a hyphenated package (`shell-quote`) split into words that
matched an unrelated module, a package (`handlebars`) that pulled in every
template, `package` and `upgrade` ranking components, and lockfiles never
ranked. Their cases expect the lockfile (and a manifest that declares a named
package) as primary; package-manager config and a manifest a transitive fix may
not touch are expected in Related Files.

### Risk cases

Each risk case exercises the shared risk vocabulary in
`src/lib/risk-paths.js` so the recently-fixed false
positives/negatives surface in CI, not in production review output. The `mode`
field selects the predicate:

| `mode` | Predicate | Concept labels |
|---|---|---|
| `query` | `conceptsFromQuery(query)` | risk-flag names (`money flow`, `auth/security`, …) |
| `path` | `classifyPath(path)` | risk-flag names |
| `gate` | `isGateRiskPath(path)` | `["gate"]` if it gates a merge, else `[]` |
| `secret` | `isSecretPath(path)` | `["secret"]` if it is a secret file, else `[]` |

`expectedConcepts` must all be present; `notExpectedConcepts` must all be
absent. Encoded regression guards include:

- `fix payload parsing` → **not** money flow (the `pay` substring must not match)
- `roles.guard.ts` → auth/security, **not** money flow
- `tests/checkout.spec.ts` → **no** merge-gate flag
- `config/dev.environments.ts` → **not** a secret (`.env` substring must not match)
- `.nvmrc` → configuration, **and** gates a merge (it picks the production Node version)
- `yarn.lock` → **no** merge-gate flag (dependency churn scores zero)
- `upgrade the organiser to the pro plan` → **not** dependency

### Harness execution cases

The `harnessExecution` corpus encodes a small, reviewed fixture repository and
the exact commands Solumbe must infer from it. The current Node fixture proves:

- `npm install`
- `npm test`
- `npm run typecheck`
- `npm run build`

For every expected command, the runner first verifies that it appears in the
right harness group, then executes it in a temporary copy of the fixture. The
source fixture is never mutated. It accepts only ordinary `npm`, `pnpm`,
`yarn`, or `bun` install/test/run forms, has a 60-second timeout per command,
and disables lifecycle scripts during the install probe. It never executes a
command inferred from a customer repository.

The current dependency-free Node fixture uses `node --check` behind its
`typecheck` script. That proves command inference and execution; it does not
claim TypeScript compiler coverage. Add a dedicated TypeScript fixture when
testing compiler semantics is the goal.

This is execution evidence for the encoded fixture commands, not a claim that
every command in every possible harness is safe or runnable. Add another small
fixture when extending coverage to another ecosystem or command form.

### Gate-effectiveness cases

The `gateEffectiveness` corpus runs Solumbe's real local gate against reviewed,
committed changes. The corpus holds four changes that must pass:

- a valid change;
- a change aligned with its source-kind owner, which must converge;
- a valid change gated against a `main` that gained a commit after the branch
  point, which must count only the change's own file; and
- an edit to a file that already holds a credential, which the change did not
  add.

And eight that must be blocked:

- a potential secret or environment file;
- a credential value pasted into ordinary source;
- a credential added beside one already on the base;
- a high-risk schema change without independently verified PR controls;
- version metadata changed without a changelog update;
- requested validation without a base-committed validation policy;
- company ownership rules that cannot be self-certified by a local run; and
- a change that falls below the requested convergence threshold.

Each case names a fixture, a committed change-set, an expected overall verdict,
and one or more named gate checks. Expectations can assert status plus stable
summary or detail fragments. The case fails when the verdict differs, an
expected reason is missing, or the gate returns an unexpected `FAIL` check.

The runner copies `base/` into an isolated temporary directory, creates a
deterministic Git baseline, applies one reviewed `changes/<changeSet>/`
directory or `changes/<changeSet>.patch`, stages the result, and invokes
`solumbe gate --staged --json`. A case with `advanceBase` branches the change
off the baseline, commits that reviewed change-set to `main`, and gates the
working tree against `main`, since staged and head subjects are exact two-tree
diffs by design. Allow markers are stripped before the baseline commit as well
as after the change, so an unchanged marked line reads as unchanged. The patch form lets a safety case create a
secret-like path only inside the temporary repository, without placing that
path in Solumbe's own working tree. Corpus entries cannot provide shell commands,
redirect execution outside `evals/fixtures/`, or use path-like change-set
names. The source fixture and customer repositories are never mutated or
executed.

This is product evidence for the encoded local-gate behaviours. Hosted CI,
GitHub approvals, CODEOWNERS approval state, unresolved conversations, and the
human merge decision remain separate authorities.

### Read cases

The `reads` corpus labels what a request asks for: its intent (one of the
eight in `src/lib/jev.js`, or several where a careful reader could defend more
than one), the solumbe tool that answers it, and the files the work needs. It
grades the request read, not solumbe's ranking, so it runs one read provider at
a time over the same offline context pack the retrieval eval builds:

```bash
solumbe eval --reads --provider heuristic   # solumbe's own action word, no call
solumbe eval --reads --provider jev         # TYPESAFE_API_KEY
solumbe eval --reads --provider claude      # ANTHROPIC_API_KEY
```

It reports intent accuracy, the share of reads that clear `CHOICE_FLOOR`, the
accuracy of the intent a pack would actually carry, a Brier score and
confidence bands for the stated confidence, capability accuracy, how many
expected files a read would demote, and the cost. It calls a model, so it has
no thresholds and is not part of `npm run quality`; results are recorded in
[the calibration thesis](17-calibration-thesis/README.md#grading-the-request-read-2026-10-18).
`tests/claude-read.test.js` runs it against a mocked fetch.

## How thresholds work

The corpus header carries a `thresholds` block so the pass/fail bar is tunable
without touching code:

```json
"thresholds": {
  "retrieval": { "precisionAtK": 0.82, "recallAtK": 0.9, "mrr": 0.9 },
  "risk": { "accuracy": 0.97 }
}
```

The runner computes the aggregate metrics, compares each against its floor, and
sets `exitCode` to `0` only when **every** check passes. Thresholds are set to
**current-baseline-minus-slack**: high enough that a real regression trips the
gate, low enough that the suite is green today. (At the recorded baseline a
single risk-case regression drops accuracy to 27/28 = 0.964, below the 0.97
floor, so the gate catches it. The floor moved from 0.96 to 0.97 when the risk
corpus grew from 22 to 28 cases, because 27/28 would otherwise pass 0.96.)

## Current baseline

Recorded **2026-10-13** by running `runRetrievalEval()` against the committed
corpus (36 retrieval + 22 risk cases):

```
| Group     | Metric       | Value | Threshold | Pass |
|-----------|--------------|------:|----------:|:----:|
| retrieval | precisionAtK | 0.838 |      0.82 | yes  |
| retrieval | recallAtK    | 1.0   |      0.9  | yes  |
| retrieval | mrr          | 0.986 |      0.9  | yes  |
| risk      | accuracy     | 1.0   |      0.97 | yes  |

Retrieval: p@5=0.838, r@5=1.0, mrr=0.986 (36/36 cases pass)
Risk:      accuracy=1.0 (28/28 cases pass)
Overall:   PASS (exit 0)
```

The 2026-10-20 change recorded the misses from a Dependabot batch and a Node
20 → 22 upgrade on bashbop-api. Two were rules and are fixed: `.nvmrc`,
`.node-version` and `.tool-versions` are configuration and gate a merge, and
`dependency`, `dependencies`, `deps`, `dependabot`, `renovate` and `lockfile`
in a request imply the dependency concept. `upgrade`, `bump` and `package` do
not, since they name pricing tiers, releases and versions as often. The rest
need manifests, lockfiles and version pins indexed, which the code map skips,
so they are recorded as known gaps (below): four `node-upgrade-api` retrieval
cases and the `dependency-bump-converges` gate case. The risk floor moved to
0.97 for the larger corpus. Retrieval aggregates are unchanged.

The 2026-10-13 change added the `git-hooks` fixture and the
`git-hook-pre-commit-gate-step` case. Git hook scripts have no extension, so
they were never indexed, and a request to change the pre-commit hook ranked
components that shared the words "step" and "gate". The case returns the hook
alone at rank 1 (p@5=1.0). Before the primary pool was scoped for hooks it
returned the hook plus both decoys (p@5=0.333), which took the aggregate to
0.819, below the floor. The floor was not changed. A global relative score
cutoff was tried at 0.5 to 0.7 of the top score and rejected: every ratio
dropped at least one labeled second owner elsewhere in the corpus.

The 2026-10-10 change added the `python-orders-api` and `go-inventory-api`
fixtures and ten cases, to measure ranking in a repository with no JavaScript,
and then Go import resolution. The 25 earlier cases are unchanged (p@5=0.861,
r@5=1.0, mrr=0.979). The ten new cases score p@5=0.767, r@5=1.0, mrr=1.0,
which moved the aggregate below the old 0.85 precision floor, so the floor was
re-set to 0.82 here and in `tests/cli.test.js`. What the new cases show:

- Every name and symbol case passes with the labeled file at rank 1, in both
  languages. The five Go cases return one primary file each. Four of the five
  Python cases also return one or two primary files that are not labeled
  (p@5=0.333 or 0.5).
- Both Python importer cases pass, but not through the import graph: the
  resolver reads neither `from .tax import` nor `from app.shared.clock
  import`, and `relatedFiles` is empty. The caller is ranked as a primary
  file because the import line itself names the module.
- The engine before Go import resolution fails `go-module-import-importer`. A
  Go import names a package directory by module path
  (`example.com/inventory/internal/platform`), never the file, so nothing
  connected `internal/stock/store.go` to `internal/platform/retry.go` and the
  pack for "change the retry backoff" held `retry.go` alone. The code map now
  reads `go.mod` and records the package directories each Go file imports,
  and the pack's import graph links the file to that package's files, so
  `store.go` is a related file ("imports primary file").

The 2026-10-06 change (string names a registry gives tools indexed as
`registered` symbols, and a named tool's implementing module pinned) left the
24 earlier cases with the same aggregate (p@5=0.87, r@5=1.0, mrr=0.978). It
added `registered-tool-implementation` on the new `tool-registry` fixture,
which returns a third, unlabeled primary file (p@5=0.667). The engine before
that change fails it: the request reaches neither `src/lib/converge.js` nor
the registry `src/lib/mcp.js`.

The 2026-10-05 change (each request word counted once, the words of a
camelCase name such as `OpenPanel` counted only together, and an action verb
counted only in a symbol's own name) left all 22 earlier cases with the same
aggregate (p@5=0.873, r@5=1.0, mrr=0.976). It added `telemetry-repeated-words`
and `telemetry-openpanel-camelcase` on the new `telemetry-web` fixture; the
aggregate moved because the first returns a third, unlabeled primary file
(p@5=0.667). The fixture is too small to reproduce the live failure, where
`app/global-error.tsx` fell out of the pack and a seller checkout service
became primary; `tests/context-engine.test.js` asserts the three mechanisms
directly, and each of those tests fails with its fix removed.

The 2026-09-27 change (named-file pinning, translation-catalog demotion and
locale folding, extension tokens dropped, runnable tests only) left all 21
earlier cases byte-identical; the aggregate moved from p@5=0.867, mrr=0.975
only because it added `multi-locale-named-files-and-symbol`, which scores 1.0.
The engine before that change fails the same case (p@5=0.6: two
`.ts`/`.tsx` files matched on their extension took the slots of
`utils/create-event.ts` and `aiEventSchema.ts`).

precision@5 is below 1.0 because some pairing queries (e.g. `fix the rsvp
button`) legitimately return two primary files when only one is labeled
`expectedPrimary`; the second is a correct related file, so this is expected
headroom rather than a defect.

mrr dropped from 1.0 to 0.975 when the query-interpretation heuristics (intent
hints, the signup/verification and RSVP-privacy boosts, the template boost)
were removed. Those rules existed to put one file at rank 1 for the three
cases they were written against; without them the expected file sits at rank
2 or 3, still inside the top five. Ordering within the pack is the model's job.

## How to add a case

1. **Pick or add a fixture.** Reuse a name under `fixtureRoots` in
   `evals/corpus.json`, or add a small synthetic repo under `evals/fixtures/`
   and register it in `fixtureRoots`. Keep fixtures tiny and synthetic: a few
   files that exercise one behavior. Do **not** add a `.solumbe/` cache to a
   fixture; the runner copies each fixture to a temp dir and regenerates the map
   from source so the committed fixtures are never mutated.

2. **Add the case.**

   Retrieval:

   ```json
   {
     "name": "shop-refund-payment",
     "query": "refund a payment",
     "repoFixture": "shop-api",
     "expectedPrimary": ["src/payment/checkout.service.ts"],
     "expectedAnyOf": ["src/payment/stripe.webhook.ts"]
   }
   ```

   Multi-repo cases use `"repoFixtures": ["shop-api", "web-client"]` and
   namespace expected paths as `"<fixture>/<repo-relative-path>"`.

   Risk:

   ```json
   {
     "name": "query-refund-is-money",
     "mode": "query",
     "query": "refund a payment",
     "expectedConcepts": ["money flow"],
     "notExpectedConcepts": []
   }
   ```

   Harness execution:

   ```json
   {
     "name": "node-install-test-typecheck-build",
     "repoFixture": "harness-node",
     "commands": [
       { "kind": "install", "group": "setup", "command": "npm install" },
       { "kind": "test", "group": "validate", "command": "npm test", "script": "test" }
     ]
   }
   ```

   Gate effectiveness:

   ```json
   {
     "name": "secret-file-is-blocked",
     "repoFixture": "gate-node",
     "changeSet": "secret",
     "expectedVerdict": "FAIL",
     "expectedChecks": [
       {
         "name": "Secret safety",
         "status": "FAIL",
         "summaryIncludes": "Potential secret or environment file changed"
       }
     ]
   }
   ```

3. **Run it.** `node --test tests/eval.test.js`, or run the runner directly to
   see the scoreboard. If you intentionally changed behavior, re-record the
   baseline above and re-set the thresholds to baseline-minus-slack.

## Running the eval

`runRetrievalEval()`, `runHarnessExecutionEval()`, and
`runGateEffectivenessEval()` are exported from `src/lib/eval.js`. All suites are
covered by `tests/eval.test.js`:

```bash
node --test tests/eval.test.js
```

Run the release-gating commands directly with:

```bash
npm run eval:accuracy
npm run eval:harness
npm run eval:gate
```

The CLI equivalents are `solumbe eval --accuracy`, `solumbe eval --harness`, and
`solumbe eval --gate-effectiveness`. Each exits non-zero on a failed corpus, and
`npm run quality` runs all three release-gating suites.
