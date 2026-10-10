# Spec: Convergence Score

**Status:** Implemented in task mode (`solumbe converge`) + `convergence_score` MCP tool, including exact change-subject receipt v2.
**Depends on:** `src/lib/impact.js` (`generateImpact`, `validateAgainstDiff`),
`src/lib/risk-paths.js` (`classifyPath`, `isSecretPath`, `RISK_FLAGS`),
`src/lib/tools.js` (`runCommand`), `node:crypto`.
**Implementation:** `src/lib/converge.js` (`generateConvergence`, `makeReceipt`),
CLI `solumbe converge`, MCP `convergence_score`, tests in `tests/converge.test.js`.

## 1. Summary

A deterministic 0–100 score for the **distance between a stated task (intent) and the
actual git diff (execution)**, the buildable core of the convergence argument
([README.md](./README.md)). It is not a proof of correctness; it is a reproducible
*measurement*, computed out-of-band where the agent cannot fake it.

```bash
solumbe converge "add Stripe refunds" --base origin/main
```

## 2. Why this is low-risk to build

Every input already exists; convergence is a composition layer, not new analysis:

| Signal | Source (already in repo) |
| --- | --- |
| Predicted owner files for the task (intent) | `generateImpact(query).data.topFiles` in `src/lib/impact.js` |
| Predicted-vs-actual diff comparison | `validateAgainstDiff` (already inside `generateImpact` when `diffBase` is set): `confirmedDirect`, `confirmedRelated`, `unconfirmedCandidates`, `missedChangedFiles` |
| Risk weight of a drifted path | `classifyPath` / `isSecretPath` / `RISK_FLAGS` in `src/lib/risk-paths.js` |
| Exact change subject for receipt v2 | Staged: resolved base + parent commit + `git write-tree`; head: resolved base + head commit + its tree; PR: GitHub repository/number + exact base/head OIDs |
| Precedent for a 0–100 composite + receipt-style evidence | `generateAxScore` (`src/lib/ax.js`), `review_verdict` |

## 3. Score model

Three sub-scores, each 0–100, blended with config-overridable weights (defaults below).

```
Convergence = 0.45 * Coverage        // did the intent happen?
            + 0.35 * Scope           // did only the intent happen?
            + 0.20 * RiskAlignment   // did drift land somewhere dangerous?
```

### 3.1 Coverage (did intent happen?)

```
predictedDirect = confirmedDirect + unconfirmedCandidates
Coverage = predictedDirect > 0 ? 100 * confirmedDirect / predictedDirect : 0
```

Share of the task's predicted owner files that were actually changed. A task that grounds to
no predicted file is unmeasurable: the result is `inconclusive` (3.4), with no Coverage at all.

Owners are predicted from the request's words first: the paths, symbols, exports and routes
that match it. When no file clears that bar, the import graph is asked. A file is then an
owner when a word of the request is its name (`util` for `src/lib/util.js`) or a symbol it
exports, no other source file shares that name or export, and it has at least one import edge,
so it is a module the repository uses and not a stray file. Candidates are ordered by how many
files import them, and the lexical score only breaks ties. Words that say what to do or name
code in general (`refactor`, `index`, `test`) anchor nothing. The file's reasons say
"grounded in the import graph" and which word and edge count did it.

### 3.2 Scope (did only intent happen?)

```
onTask = confirmedDirect + confirmedRelated + inferredRelated
Scope = changedFiles > 0 ? 100 * onTask / changedFiles : 0
```

Share of the diff the task anticipated (directly, as a related dependency, or as the
confirmed owners' own fan-out). `missedChangedFiles`, files that changed but nothing in the
task predicted, are scope drift. An empty diff converges on nothing, so Scope is 0.

`inferredRelated` moves a changed file out of drift (or out of the advisory bucket) under
one of six named rules, each anchored on a file the diff already confirmed:

- **`owner-sibling`**: a file the change *adds* in the same directory as a confirmed
  required owner. It must be a mapped source file, must not be a secret path, and must
  carry no risk flag the owner lacks. Modified siblings, files in subdirectories, and
  owners at the repository root anchor nothing.
- **`owner-test`**: a test, added or modified, whose file name names a confirmed file or
  an inferred sibling: `PersonDialog.test.tsx` for `PersonDialog.tsx`,
  `SmartTable.selection.test.tsx` for `SmartTable.tsx`, `test_converge.py` for
  `converge.py`. Generic stems (`index`, `utils`, `types`, …) must sit beside the file or in
  a `__tests__`/`test`/`tests` directory directly under it. A suffix after a hyphen or
  underscore also names a non-generic file: `mcp-dispatch.test.js` for `mcp.js`.
- **`owner-changelog`**: the changelog (`CHANGELOG.md`, `CHANGES.md`, `HISTORY.md`,
  release notes), which records the change.
- **`owner-test-data`**: fixture or eval data (`evals/fixtures/…`, `evals/corpus.json`,
  `testdata/…`), the input the change's tests run on.

The last two need at least one confirmed owner; a diff that is only a changelog or only
fixtures stays drift.

Three rules read the lines the change *adds* (a zero-context diff against the base, or the
whole file when an untracked file is scored), so they hold for what this change did:

- **`owner-test`** also covers a test whose added lines import a confirmed file, whatever
  its name.
- **`owner-import`**: a source file whose added lines import a confirmed file, by a relative
  specifier or a root alias (`@/utils/analytics`, `~/lib/x`, `#/lib/x`, resolved from the
  repository root or `src/`), carrying no risk flag that file lacks. The change wired them
  together, as when a helper moves into a shared module and its callers import it there, or
  a feature calls a confirmed module from the screens it touches.
- **`owner-doc`**: a doc whose added lines name a confirmed or inferred file by path or file
  name. Generic file names (`index.ts`) name nothing, and the change's code is preferred
  over its fixtures as the anchor.

Each entry records its rule and anchor, so the inference is visible rather than silent.

### 3.3 Risk alignment (is the drift dangerous?)

```
RiskAlignment = clamp(100 - sum(riskWeight(f) for f in missedChangedFiles), 0, 100)
```

Each unrequested changed file is penalised by its worst risk flag, so a drifted edit to a
secret/auth/money path tanks the score and a drifted README barely moves it.

```
secret 30 · auth/security 25 · money flow 25 · data model 15 · contract 15
· request surface 15 · configuration 10 · default 5
```

### 3.4 Bands

`aligned` ≥ 80 · `partial` ≥ 50 · `drift` < 50.

A fourth outcome carries no score. When the task predicts no owner file (`drivers.grounded` is
`false`), there is nothing to measure the diff against: coverage, scope and drift are all
relative to a prediction that does not exist. The result is `band: "inconclusive"` with
`convergence: null` and every sub-score `null`. Before engine 0.6.0 such a task scored about
20 (risk alignment alone) and banded as `drift`, the same for a correct change and an
unrelated one. The drivers still list the changed files, as "changed, not predicted" rather
than as drift, and name any that sit on a risk-sensitive path. The receipt is computed as
usual, so an inconclusive result can still be recomputed and verified.

### 3.5 What is scored

| Mode | Changed files | Receipt |
| --- | --- | --- |
| Working tree (default) | `git diff <base>`: tracked files, staged or not. Untracked files are listed under `untracked` and not scored unless `--include-untracked` is passed. | v1 |
| `--head <ref>` | Exactly `base..head` as a direct tree diff (no merge base). Uncommitted and untracked files play no part. | v2, `git-commit` |
| `--staged` | Exactly `base..index` via `git write-tree`. | v2, `git-index` |
| GitHub PR (gate only) | `merge-base(base, head)..head`, checked against GitHub's file list. | v2, `github-pr` |

`--head` and `--staged` cannot be combined. To score a branch whose base has moved on, pass
the merge base as `--base` (`git merge-base origin/main HEAD`); `--head` deliberately does
not compute one, so the subject is exactly the two trees named.

## 4. Recomputable receipt

The video's "tamper-evident attestation": a hash anyone can regenerate from the same inputs
and compare to the one recorded for a change.

```
inputsHash = sha256( canonical({ engine, task, base, commit, convergence,
                                 subScores, changedFiles, confirmedDirect,
                                 confirmedRelated, unconfirmedCandidates,
                                 missedChangedFiles, inferredRelated? }) )
id         = "rcpt_" + inputsHash[0:12]
```

The canonical payload **excludes `generatedAt`** and **sorts every file list**, so the
receipt is identity, not timestamp or ordering, the property that makes "recompute and
compare" meaningful in CI. `inferredRelated` (file paths only) is present only when a file
was inferred into scope, so a payload without inference hashes exactly as before.

`engine` is `convergenceEngineVersion`. Engine `0.2.0` added owner-adjacent inference and
stopped scoring untracked files by default; both change scores, so a receipt issued by
`0.1.0` does not recompute under `0.2.0`. Engine `0.3.0` added suffixed test names, the
changelog and test data to that inference, so a `0.2.0` receipt does not recompute under
`0.3.0` either. Engine `0.4.0` added the rules that read added lines (`owner-import`,
`owner-doc`, and tests by import), so a `0.3.0` receipt does not recompute under `0.4.0`.
Engine `0.5.0` follows root-alias imports in those rules, so a `0.4.0` receipt does not
recompute under `0.5.0`. Engine `0.6.0` reports an ungrounded task as `inconclusive` with no
score, so a `0.5.0` receipt does not recompute under `0.6.0`. Re-issue it with the current
engine.

Calls without an exact subject retain the byte-for-byte v1 canonical payload and receipt
shape for compatibility. A subject-bound receipt uses v2 and adds both of these fields to
the canonical payload:

```text
receiptVersion = 2
subject        = canonical({ kind, repository?, number?, baseSha,
                              parentSha?, headSha?, treeSha? })
```

The three valid subject shapes are:

- `git-commit`: resolved base commit, resolved head commit, and the head commit's tree SHA.
  Changed paths are captured from `baseSha..treeSha` and the scoring map is built from raw
  blobs in that tree, with the same filter, replace-ref, rename, and size controls as
  `git-index` below. The receipt's `commit` is the head commit. A supplied subject is
  rechecked: the head must still resolve to the recorded tree, and the diff files must match.
- `git-index`: resolved base commit, current parent commit, and the tree SHA produced by
  `git write-tree`. Changed paths are captured from `baseSha..treeSha`, so the file list
  and subject come from the same immutable tree. The task-scoring code map is also built
  from raw blobs in that tree, so unstaged source edits cannot change the receipt and
  configured checkout filters cannot execute during scoring. Blobs are analyzed in bounded
  batches, and receipt generation fails closed above 5,000 source files or 64 MiB of eligible
  source. Git paths use NUL-delimited capture so legal whitespace and newline characters
  remain exact. Git diff commands disable local replacement refs, force changed gitlinks to
  remain visible, and fix rename detection at 50% with a finite 1,000-candidate limit. These
  controls prevent repository-local Git configuration from changing the comparison's meaning.
- `github-pr`: target repository, PR number, and the exact `baseRefOid` / `headRefOid`
  returned by GitHub. Exact receipt issuance fails closed if GitHub's `changedFiles` total
  does not equal the returned file list, the local `merge-base(baseSha, headSha)..headSha`
  diff does not match that list, or the local analysis checkout is not the exact, clean
  PR head. Its scoring map is built from `headRefOid`.

`rcpt_` plus 12 hex characters is a display handle. Exact-subject enforcement compares the
full 64-character `inputsHash`. The receipt is hashed but not yet cryptographically signed.

## 5. Output schema

```jsonc
{
  "ok": true,
  "convergenceEngineVersion": "0.6.0",
  "task": "add Stripe refunds",
  "base": "origin/main",
  "head": "HEAD",
  "subject": {
    "kind": "git-commit",
    "baseSha": "a77d38a...",
    "headSha": "b88e49b...",
    "treeSha": "c99f50c..."
  },
  "repo": { "name": "shop-api", "root": "/..." },
  "convergence": 72,
  "band": "partial",
  "subScores": { "coverage": 80, "scope": 70, "riskAlignment": 60 },
  "drivers": {
    "changedFiles": 4, "predictedDirect": 5,
    "confirmedDirect": ["..."], "confirmedRelated": ["..."],
    "inferredRelated": [{ "file": "src/refunds/reason.js", "rule": "owner-sibling", "anchor": "src/refunds/refund.js" }],
    "unconfirmedCandidates": ["..."], "missedChangedFiles": ["..."],
    "advisoryChangedFiles": ["..."],
    "grounded": true,
    "riskyDrift": [{ "file": "src/auth/login.js", "weight": 25, "flags": ["auth/security"] }]
  },
  "recommendations": ["..."],
  "receipt": {
    "id": "rcpt_f2af2b4b6d5b",
    "algorithm": "sha256",
    "commit": "b88e49b...",
    "inputsHash": "...",
    "receiptVersion": 2,
    "subject": { "kind": "git-commit", "baseSha": "a77d38a...", "headSha": "b88e49b...", "treeSha": "c99f50c..." }
  }
}
```

In working-tree mode there is no `subject`, and the result carries
`"untracked": { "included": false, "count": 2, "files": ["dump.rdb", "..."] }` (at most 25
paths listed).

## 6. Surface

```bash
solumbe converge "<task>" --base origin/main                  # task mode, cwd, tracked changes
solumbe converge <repo> "<task>" --base HEAD~1 --json          # explicit repo, machine-readable
solumbe converge "<task>" --base HEAD~1 --head HEAD --json     # exact base..head commit subject
solumbe converge "<task>" --base HEAD --staged --json          # exact Git-index subject
solumbe converge "<task>" --base origin/main --include-untracked  # also score untracked files
```

MCP: `convergence_score` (requires `query` + `base`, accepts `head`, `staged`, and
`includeUntracked`), mirroring
`agent_experience`. This is the deliberate 13th tool on a surface guarded by three count
tests + the migration doc. Because staged capture uses `git write-tree`, it may write Git
object or index-cache metadata without changing source files; the MCP tool is conservatively
not annotated read-only.

## 7. Tests

Pure pieces are unit-tested (`tests/converge.test.js`): frozen v1 compatibility, v2 subject
canonicalisation and validation (including `git-commit`), sensitivity to tree/base/head
changes, owner-adjacent inference rules and their guards, and band thresholds. Head fixtures
verify that dirty and untracked files are excluded, that the receipt survives later commits
and edits, that forged commit subjects are refused, and that working-tree mode lists rather
than scores untracked files. Staged and PR fixtures verify tree capture, immutable-tree
scoring, filter and replace-ref isolation, rename-configuration independence, NUL-safe paths,
merge-base PR scope, complete file scope, exact head matching, CLI, MCP, and Gate
propagation.

## 8. Gate integration

Convergence can now be made load-bearing by passing a task plus either a minimum
score, a receipt, or both to the local/PR gate:

```bash
solumbe gate . --base origin/main --request "update the greeting" --min-convergence 80
solumbe converge . "update the greeting" --base origin/main --staged --json > .solumbe/convergence.json
solumbe gate . --base origin/main --staged --request "update the greeting" --receipt .solumbe/convergence.json
solumbe converge . "update the greeting" --base HEAD~1 --head HEAD --json > .solumbe/convergence.json
solumbe gate . --base HEAD~1 --head HEAD --request "update the greeting" --receipt .solumbe/convergence.json
```

The gate recomputes the score from the selected diff and fails when the score is
below the requested floor or when the supplied receipt does not match the current task,
base, and exact change subject. Subject-bound v2 enforcement requires the full inputs hash;
JSON receipt files are accepted and supply that hash automatically. A receipt verifies only
in the mode that produced it: `--head` for a `git-commit` receipt, `--staged` for a
`git-index` receipt, `--pr` for a `github-pr` receipt. When a JSON receipt's subject names a
different mode or head than the gate measured, the failure says which to rerun with rather
than reporting a bare hash mismatch. With `--head`, the gate's changed-path, risk, secret, and
convergence checks all read the head commit's tree. Receipt enforcement is opt-in so existing
gate verdicts remain backward-compatible.

An `inconclusive` result has no score to hold against a floor. With a `--min-convergence`
above 0 the `Convergence` check reports `WARN` and says the request did not ground; it does
not report `FAIL`, because the failure would say nothing about the change. A floor of 0 asks
for no score and passes, and a receipt that does not match fails whether or not the task
grounded. A pipeline that blocks only on `FAIL` therefore lets an ungrounded request through
with a warning: block on `WARN` as well, or name the files or symbols in the request, where
that matters.

This is an exact **convergence receipt**, not yet a complete Gate attestation. Release checks,
optional local analyzers, base-branch CODEOWNERS, GitHub review state, and signer identity are
not all bound into this envelope yet. In staged mode, `solumbe gate --run-validation` can produce
a separate validation receipt: a versioned `solumbe.gate.json` plan is read from the selected base
commit, run against an isolated materialisation of the exact staged tree, and binds command
outcomes plus output hashes without retaining raw output. A linked local `node_modules` directory,
when present, is reported as not attested. The Gate still reports every remaining working-tree
boundary explicitly.

## 9. Scope contract

The score above predicts the owner files after the edit, from the tree the edit produced. A
scope contract makes the prediction before the edit and freezes it, so the gate can say
"touched `src/auth/session.ts`, which was never declared" rather than "78/100". The score
stays as secondary evidence.

```bash
solumbe declare . "update the greeting message"        # writes .solumbe/intent.json
# ... make the change ...
solumbe gate . --staged --base HEAD --intent .solumbe/intent.json
solumbe amend src/auth/session.ts --reason "the greeting now outlives the session"
```

Over MCP no tool is added: `change_impact` with `declare: true` returns the same record under
`intent` and writes nothing, `change_impact` with `intent` and `amend: { files, reason }`
returns the amended record, and `review_gate`, `review_verdict` and `convergence_score` take
it as `intent` (the record, its JSON, or a path).

**The record** (`solumbe.intent/v1`) holds the request, the commit it was declared at, the
impact engine version, the declared files (`owners` and `supporting`, the required owners and
predictable supporting files `solumbe impact` ranks for the request) and
`dirtyAtDeclaration`, the tracked files that already differed from `HEAD`, so a contract
written after the edit began says so. It also holds what the request's own words scope:

- `terms`: the words of the request that few tracked paths carry (at most 20 paths, or 3% of
  the repository if that is more). `hubspot` in an events platform is on a dozen paths and is
  a term; `event` is on hundreds and is not. A word no path carries yet is kept, since it
  names what the change adds. Words are compared in the singular, so `fees` meets
  `fee-calculator.ts`. Three things are never terms: a tree name (`src`, `lib`, `tests`), a
  file extension (`ts`), and the parts of a tracked path written out in the request.
  "update greet in src/index.ts" names that one file, which the prediction holds, and
  scopes neither `src` nor every `index`.
- `modules`: the directories whose whole name is a word of the request: `src/user` for
  "user: …", not `src/user-settings`. A directory holding more than a fifth of the
  repository, a tree name (`src`, `lib`, `tests`, …) or a dot-directory names nothing, and a
  request that names more than six directories names none.

```
contractHash   = sha256( canonical({ schema, request, head, impactEngineVersion,
                                     owners, supporting, dirtyAtDeclaration,
                                     terms, modules }) )
amendment.hash = sha256( prevHash + canonical({ seq, files, reason }) )
```

`terms` and `modules` enter the hash only when the record carries them, so a record declared
before they existed verifies as it did.

`prevHash` is the previous amendment's hash, or `contractHash` for the first. Editing the
request, a declared file, or any amendment's files or reason breaks the chain, and the gate
refuses a record that does not verify. `declaredAt` and `amendedAt` are outside the hashes:
declaring the same request on the same tree gives the same contract.

**The `Scope contract` check** runs when the gate is given an intent. Each changed file is one
of four things:

| Bucket | Meaning |
| --- | --- |
| declared | An owner or supporting file in the record. |
| amended | Named in an amendment, which carries its reason. |
| implied | Placed in scope by one of the rules in 3.2, anchored on a declared or amended file (its test, a new file beside it, a file whose added lines import it, the changelog entry), or by one of the declaration rules below. |
| undeclared | None of the above. The check fails and names the file, with its risk flags when it sits on a risk-sensitive path. |

A declared owner that was not changed is listed and does not fail the check. A gate given a
`--request` other than the declared one fails, since it would be holding the change against a
different promise. With an intent, `--min-convergence` and `--receipt` measure against the
declared files too, and the convergence receipt carries the contract hash, so it names the
contract it was scored under. A request that predicts no owner file declares no file: a
changed file is then in scope only through the request's own words (the first three rules
below) or an amendment, which is the explicit way to name files by path.

**What a declaration implies.** A real change is wider than the files a request predicts: the
controller beside the service, the feature flag, the workflow step, the doc. Under a contract,
after the rules in 3.2, seven more rules place a changed file in scope. They run in this
order, and each implied file is reported with its rule and anchor:

| Rule | A changed file is in scope when |
| --- | --- |
| `request-word` | its path, without the extension, carries one of the record's `terms`: `docs/hubspot-crm-sync.md` under "hubspot: …". |
| `request-module` | it is under one of the record's `modules`: `src/user/dto/me.dto.ts` under "user: …". |
| `request-config` | it is a configuration or data file (JSON, YAML, TOML, INI, a dotfile, a snapshot, a shell or `.mjs`/`.cjs` script) and the lines the change adds to it carry one of the `terms`: the flag the feature ships behind, the workflow step that runs it. |
| `owner-module` | it sits in, or under, the directory of a declared owner, changed or not. A directory at the repository root or one level down (`src`) is a tree and anchors nothing. |
| `scope-import` | it imports, or is imported by, a changed source file already in scope, and the imported side has at most five importers. An edge into a module half the repository imports relates nothing. |
| `scope-test` | it is a test that imports, or is named for, a source file in scope. |
| `scope-doc` | it is documentation, or a template such as `.env.example`, and at least one source file is in scope. Documentation alone joins nothing. |

`scope-import` and `scope-test` repeat until nothing more joins, so a chain of imports from a
declared file is followed through the change. Import edges come from the code map of the tree
under review, and only edges between changed files count.

Two limits keep the rules from waving a change through:

- A secret path is never implied.
- `owner-module` and `scope-import` do not bring in a file on an authentication or payment
  path unless the anchor is on one too. A payment service beside a declared mailer stays
  undeclared and needs an amendment. The three request rules carry no such limit: the request
  named the file.

The request rules take the request at its word, and cannot tell a module named on purpose
from one a sentence happens to mention: "allow one ticket type per guest" names `src/types`
and `src/guests` as surely as "guests: …" does. A change inside a directory or to
a path that shares a distinctive word with the request is in scope by definition. What the
rules hold out is the change that shares none.

These rules widen what a declaration covers and do not change the score without one: a
`converge` or gate run with no intent applies only the rules in 3.2.

**Measured on a real repository.** `bashbop-api` (a NestJS service, about 1,400 tracked
files) was replayed commit by commit: the intent is declared from the commit's subject at its
parent, the commit is gated against it, and then one unrelated change at a time is planted on
top (an authentication service, a payment service, two plain services, a compose file, a
workflow) and gated again. A plant counts as caught when the check fails and names it, and a
plant whose path or module shares a word with the request is skipped, since the rules place
it in scope by definition.

| | Commits that pass | Changed files undeclared | Planted changes caught |
| --- | --- | --- | --- |
| Rules of 3.2 only, 30 most recent commits | 3 of 30 | 153 of 199 | not measured |
| With the declaration rules, the same 30 (the rules were tuned on these) | 16 of 30 | 36 of 199 | 156 of 157 |
| Rules of 3.2 only, the 30 commits before those | 5 of 30 | 172 of 219 | 143 of 143 |
| With the declaration rules, the 30 commits before those (held out, run once) | 15 of 30 | 71 of 219 | 142 of 142 |

The held-out commits were measured once. The repository's own tests then showed that a
request naming a file turned `src` and `ts` into terms, so tree names, extensions and written
paths were excluded, and both sets were measured again: every figure above was unchanged.

The one plant that passed was a payment service the declaration itself had listed as a
supporting file for an unrelated request: a wrong prediction, which no rule here corrects.

About half of real commits still fail, and by design. Their undeclared files are a database
schema or migration, a feature-flag snapshot whose added lines do not carry the request's
words, a shared constants or error-dictionary file, or a module the subject line never named
(a change to how emails format dates that also edits the user and scheduled-task modules).
Each is a file a reviewer should see a reason for, and `solumbe amend` records one. The figures are
from one repository with conventional `scope: subject` commit messages; a repository with
terser subjects will declare less.

What the contract does not prove: that the declared files were the right ones, or that the
code in them is correct. An agent can amend any file in; the amendment and its reason are what
a reviewer reads.

## 10. Open questions

- **Weights & risk penalties**: defaults are placeholders; calibrate against known-good and
  known-drifted PRs before locking, then move into `config.js`.
- **Calibration**: tune the score weights and risk penalties against known-good and
  known-drifted PRs before making a default floor part of a policy profile.
