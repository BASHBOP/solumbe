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
no predicted files is unmeasurable; Coverage is 0 and a recommendation says so.

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
- **`owner-import`**: a source file whose added lines import a confirmed file by a relative
  specifier, carrying no risk flag that file lacks. The change wired them together, as when
  a helper moves into a shared module and its callers import it there.
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
Re-issue it with the current engine.

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
  "convergenceEngineVersion": "0.4.0",
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

This is an exact **convergence receipt**, not yet a complete Gate attestation. Release checks,
optional local analyzers, base-branch CODEOWNERS, GitHub review state, and signer identity are
not all bound into this envelope yet. In staged mode, `solumbe gate --run-validation` can produce
a separate validation receipt: a versioned `solumbe.gate.json` plan is read from the selected base
commit, run against an isolated materialisation of the exact staged tree, and binds command
outcomes plus output hashes without retaining raw output. A linked local `node_modules` directory,
when present, is reported as not attested. The Gate still reports every remaining working-tree
boundary explicitly.

## 9. Open questions

- **Weights & risk penalties**: defaults are placeholders; calibrate against known-good and
  known-drifted PRs before locking, then move into `config.js`.
- **Ungrounded tasks**: Coverage 0 is harsh for a real change with a vague task description;
  consider a separate `ungrounded` band rather than folding it into `drift`.
- **Calibration**: tune the score weights and risk penalties against known-good and
  known-drifted PRs before making a default floor part of a policy profile.
