# Audit-layer pilot

Turns a `solumbe review --json` verdict into an **immutable, hash-chained attestation** bound to a merged commit. Models the "after-merge, complete, tamper-evident" audit layer — the ledger here stands in for an append-only row in a hosted audit store.

The attestation itself is a CLI command, `solumbe attest` (source: `src/lib/attest.js`). This directory holds the ledger and the verdicts the workflow writes.

## What it proves

Two properties an auditor actually tests:

- **Completeness** — every record is keyed to an exact `mergeSha` (+ base, PR, author). In production this fires from **post-merge CI on `main`**, not on anyone remembering.
- **Tamper-evidence** — each record's `recordHash = sha256(prevHash + body)`, so the records form a chain. Editing any stored field breaks every hash after it.

## Pilot run (PR #75, repoctx v2.3.0)

| field            | value                                                         |
| ---------------- | ------------------------------------------------------------- |
| merge            | `2acaa12` — "feat: convergence score + usage dashboard (#75)" |
| verdict          | **WARN**, confidence 65                                       |
| risk             | medium — flags: configuration, large PR, large file diff      |
| escalated checks | Risk review (WARN), Review state (WARN — local mode)          |
| recordHash       | `df2a5d1d729f…`                                               |

## Commands

```bash
# Attest a merged commit (post-merge CI pipes the review verdict in)
solumbe review . --pr 75 --json > verdict.json   # production: PR mode for full controls
solumbe attest . --verdict verdict.json --merge <sha> --prev <base> \
     --pr 75 --author "Name" --committed <iso>

# Verify the whole chain (CI gate / auditor spot-check)
solumbe attest . --verify        # exits non-zero if any record was altered
solumbe attest . --verify --json # the same, as data

# Sign, and verify the signatures (Ed25519, PEM)
solumbe attest . --verdict verdict.json --merge <sha> --sign-key attest.key.pem
solumbe attest . --verify --public-key attest.pub.pem --require-signature

# Publish a record as the solumbe/receipt commit status on the commit it attests
solumbe attest . --status --merge <sha>
```

The ledger defaults to `audit-pilot/ledger.jsonl` under the repository; `--ledger <file>` (or `SOLUMBE_LEDGER` for the scripts) names another. Every record written by `solumbe attest` carries `schemaVersion: 2` and the `verdictSchemaVersion` of the verdict it was built from; the published schema is [docs/schemas/attestation-record.v2.json](../docs/schemas/attestation-record.v2.json). A version 2 record binds the verdict to the request that was stated, the scope contract the change was held against, the exact tree it was measured on and a hash of its changed paths, each `null` when the verdict did not carry it. Records written before those fields existed verify unchanged: the hash covers whatever body was stored.

A record can be signed. `--sign-key <pem>` (or `SOLUMBE_ATTEST_KEY` naming a file, or `SOLUMBE_ATTEST_KEY_PEM` holding the PEM) signs `recordHash` with an Ed25519 key; `--verify --public-key <pem>` checks every signature, and `--require-signature` fails an unsigned record. The signature sits outside the hash, so a signed ledger verifies the same way as an unsigned one. The chain shows nothing was edited afterwards; the signature shows who wrote it.

`attest --status` posts a record as the `solumbe/receipt` commit status on the commit it attests, through your own `gh` login: the verdict, the record's place in the chain, its hash, the tree and the signing key. `FAIL` is a failed status; `PASS` and `WARN` are a success, since a `WARN` asks for a reviewer and does not block. The reusable workflow does this for every record it writes.

## CI on main

Successful `repoctx CI` runs trigger `.github/workflows/post-merge-attest.yml`. Keeping attestation in a separate `workflow_run` workflow provides two important guarantees:

- ordinary pushes are attested only after the main quality gate passes;
- Dependabot auto-merges are still detected from the completed PR workflow even though merges performed with `GITHUB_TOKEN` do not trigger another push workflow.

The workflow:

1. Resolves the exact merged main commit, ignoring completed PR workflows that have not merged.
2. Restores the latest ledger from the dedicated `audit-ledger` branch.
3. Runs `scripts/reconcile-attestations.sh` to backfill every missing first-parent commit in chronological order.
4. Runs exact diff-mode review for historical gaps and PR-mode review for the newly merged target when its subject references `#NNN`.
5. Appends and verifies the hash chain with `solumbe attest`.
6. Commits the ledger and latest verdict to `audit-ledger`, keeping bot-generated evidence commits off `main`.
7. Uploads commit-specific evidence artifacts for convenient review.

The reconciliation job is serialized, idempotent by merge SHA, and fails if the stored ledger tip is not an ancestor of the requested main commit. A maintainer can also run it manually with the workflow's optional `target_sha` input.

Review exit codes are not verdict validity: a blocking `FAIL` intentionally exits nonzero. The attestation step validates the JSON envelope and records PASS, WARN, or FAIL faithfully; it falls back only when PR review produces no valid verdict.

`ledger-v1.jsonl` preserves the original pilot chain before first-parent completeness was enforced. The canonical `ledger.jsonl` was rebuilt from its unchanged genesis record so the previously skipped `bebc24d` commit and every later main commit are represented in order.

## Use it in your own repository

The attestation job is a reusable workflow. Call it after your own CI passes on the default branch:

```yaml
jobs:
  attest:
    uses: BASHBOP/solumbe/.github/workflows/attest.yml@main
    with:
      target_sha: ${{ github.sha }}
      # ledger_path: audit-pilot/ledger.jsonl   # where records go
      # ledger_branch: audit-ledger             # the branch that carries them
      # solumbe_ref: v3.0.0                       # pin the engine
    permissions:
      actions: read
      contents: write
      pull-requests: read
```

It checks solumbe out beside your repository, attests every first-parent commit between the ledger tip and `target_sha`, and commits the ledger to `ledger_branch`. Nothing leaves your repository. Verify at any time with `npx @bashbop/solumbe attest . --verify --ledger <file>`.

The scripts behind it take three variables when run by hand: `SOLUMBE_REPO` (the repository to attest), `SOLUMBE_BIN` (the solumbe command) and `SOLUMBE_LEDGER` (the ledger file). Unset, they attest the checkout they ship in.

## Notes / next steps

- This run used **local mode** (`policy: standard`). Production wants **PR mode** (`--pr`) so the gate can verify approvals, CODEOWNERS, and status checks — the "Review state" WARN above is local mode telling you exactly that.
- The `audit-ledger` branch is the durable pilot sink. Protect it from force-pushes and deletions; production should additionally POST each record into an append-only audit store.
