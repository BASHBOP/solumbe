import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "src", "cli.js");

function runAttest(args, options = {}) {
  return spawnSync(process.execPath, [cli, "attest", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("attest --verify passes on the committed pilot ledger", () => {
  const result = runAttest(["--verify"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Chain intact/);

  const json = runAttest([".", "--verify", "--json"]);
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.records, payload.chain.length);
  assert.ok(payload.chain.every((row) => row.valid));
});

test("attest appends a versioned record that chains on the previous one, and refuses without a merge SHA", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-append-"));
  const ledger = path.join(tempDir, "ledger", "chain.jsonl");
  const verdictPath = path.join(tempDir, "verdict.json");
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({
      ok: true,
      generatedAt: "2026-09-25T00:00:00.000Z",
      schemaVersion: 1,
      reviewEngineVersion: 1,
      verdict: "PASS",
      confidence: 88,
      pass: { policy: "standard", governance: "solo", checks: [{ name: "Secret safety", status: "PASS", detail: "dropped" }] },
      prReviewSummary: { changedFiles: 2, riskLevel: "low", riskFlags: [] },
      impactSummary: { topFiles: [{ path: "src/a.js", score: 9 }] },
    }),
  );

  const missing = runAttest(["--verdict", verdictPath, "--ledger", ledger]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--merge/);
  assert.equal(fs.existsSync(ledger), false, "nothing is written until the record is complete");

  const first = runAttest(["--verdict", verdictPath, "--merge", "a".repeat(40), "--prev", "b".repeat(40), "--pr", "12", "--ledger", ledger, "--json"]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const { record } = JSON.parse(first.stdout);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.verdictSchemaVersion, 1);
  assert.equal(record.seq, 1);
  assert.equal(record.pr, 12);
  assert.equal(record.prevHash, "0".repeat(64));
  assert.deepEqual(record.checks, [{ name: "Secret safety", status: "PASS" }], "checks keep name and status only");
  assert.deepEqual(record.impactedFiles, ["src/a.js"]);

  const second = runAttest(["--verdict", verdictPath, "--merge", "c".repeat(40), "--ledger", ledger, "--json"]);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const next = JSON.parse(second.stdout).record;
  assert.equal(next.seq, 2);
  assert.equal(next.prevHash, record.recordHash, "each record hashes the one before it");
  assert.equal(next.pr, null);

  const verify = runAttest(["--verify", "--ledger", ledger]);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.match(verify.stdout, /Chain intact: 2 record\(s\)/);
});

test("attest --verify fails when a ledger record is tampered", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attest-tamper-"));
  const pilotDir = path.join(tempDir, "audit-pilot");
  fs.mkdirSync(pilotDir, { recursive: true });

  const ledger = path.join(pilotDir, "ledger.jsonl");
  const sourceLedger = path.join(repoRoot, "audit-pilot", "ledger.jsonl");
  fs.copyFileSync(sourceLedger, ledger);

  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
  const row = JSON.parse(lines[0]);
  row.verdict = "FAIL";
  lines[0] = JSON.stringify(row);
  fs.writeFileSync(ledger, `${lines.join("\n")}\n`);

  // The default ledger is <repo>/audit-pilot/ledger.jsonl; --ledger names it outright.
  const result = runAttest([tempDir, "--verify"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TAMPERED|CHAIN BROKEN/);
  const named = runAttest(["--verify", "--ledger", ledger, "--json"]);
  assert.equal(named.status, 1);
  assert.equal(JSON.parse(named.stdout).ok, false);
});

test("post-merge attestation records a valid FAIL verdict even when review exits nonzero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-merge-attest-fail-"));
  const scriptsDir = path.join(root, "scripts");
  const pilotDir = path.join(root, "audit-pilot");
  const srcDir = path.join(root, "src");
  const binDir = path.join(root, "bin");
  for (const dir of [scriptsDir, pilotDir, srcDir, binDir]) fs.mkdirSync(dir, { recursive: true });

  fs.copyFileSync(path.join(repoRoot, "scripts", "post-merge-attest.sh"), path.join(scriptsDir, "post-merge-attest.sh"));
  // The script calls `src/cli.js` for both the review and the attestation.
  // This stand-in fakes the review (a FAIL that exits nonzero) and hands
  // `attest` to the real CLI so the ledger it writes is the real format.
  fs.writeFileSync(
    path.join(srcDir, "cli.js"),
    [
      "if (process.argv[2] === 'attest') {",
      "  const { spawnSync } = require('node:child_process');",
      `  const run = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
      "  process.exit(run.status ?? 1);",
      "}",
      "console.log(JSON.stringify({",
      "  ok: true, generatedAt: '2026-07-15T00:00:00.000Z', reviewEngineVersion: 1,",
      "  verdict: 'FAIL', confidence: 42,",
      "  pass: { policy: 'standard', governance: 'team', checks: [] },",
      "  prReviewSummary: { changedFiles: 1, riskLevel: 'low', riskFlags: [] },",
      "  impactSummary: { topFiles: [] }",
      "}));",
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  const fakeGh = path.join(binDir, "gh");
  fs.writeFileSync(fakeGh, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeGh, 0o755);

  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Solumbe Test"]);
  git(root, ["config", "user.email", "solumbe@example.test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "change.txt"), "change\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fix: guarded merge (#12)"]);
  const merge = git(root, ["rev-parse", "HEAD"]);

  const result = spawnSync("bash", [path.join(scriptsDir, "post-merge-attest.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_SHA: merge,
      SOLUMBE_TARGET_SHA: "",
      GITHUB_EVENT_BEFORE: base,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /blocking verdict/);
  const row = JSON.parse(fs.readFileSync(path.join(pilotDir, "ledger.jsonl"), "utf8"));
  assert.equal(row.verdict, "FAIL");
  assert.equal(row.mergeSha, merge);
});

test("the scripts attest another repository when SOLUMBE_REPO, SOLUMBE_BIN and SOLUMBE_LEDGER are set", () => {
  // This is the reusable-workflow mode: the tool is this checkout, the
  // repository under attestation is somewhere else, and the ledger lives
  // where the caller says. Nothing may be written under this checkout.
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "attest-consumer-"));
  git(target, ["init", "-q"]);
  git(target, ["config", "user.name", "Solumbe Test"]);
  git(target, ["config", "user.email", "solumbe@example.test"]);
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", scripts: { test: "true" } }));
  fs.writeFileSync(path.join(target, "index.js"), "module.exports = 1;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "base"]);
  const base = git(target, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(target, "index.js"), "module.exports = 2;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "feat: bump (#7)"]);
  const merge = git(target, ["rev-parse", "HEAD"]);

  const ledger = path.join(target, ".solumbe", "audit", "ledger.jsonl");
  const ownLedgerBefore = fs.readFileSync(path.join(repoRoot, "audit-pilot", "ledger.jsonl"), "utf8");
  const result = spawnSync("bash", [path.join(repoRoot, "scripts", "reconcile-attestations.sh")], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: {
      ...process.env,
      SOLUMBE_REPO: target,
      SOLUMBE_BIN: `${process.execPath} ${cli}`,
      SOLUMBE_LEDGER: ledger,
      SOLUMBE_TARGET_SHA: merge,
      GITHUB_SHA: "",
      GITHUB_EVENT_BEFORE: "",
      SOLUMBE_ATTEST_MODE: "diff",
      SOLUMBE_ATTEST_RESET_LEDGER: "0",
      SOLUMBE_ATTEST_DRY_RUN: "0",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Chain intact: 2 record\(s\)/, "both first-parent commits are attested, oldest first");

  const rows = fs
    .readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    rows.map((row) => row.mergeSha),
    [base, merge],
  );
  assert.equal(rows[1].pr, 7);
  assert.equal(rows[1].schemaVersion, 2);
  assert.ok(fs.existsSync(path.join(target, ".solumbe", "audit", "verdict-latest.json")), "the verdict is written beside the ledger");
  assert.equal(fs.readFileSync(path.join(repoRoot, "audit-pilot", "ledger.jsonl"), "utf8"), ownLedgerBefore, "the tool's own ledger is untouched");
});

/**
 * A repository whose ledger chains against commits that are not in it.
 * That is what a rename or a history rewrite leaves behind, and it is the
 * state solumbe's own `audit-ledger` branch was in: 97 records keyed to
 * repoctx merge SHAs, none reachable from solumbe's `main`.
 */
function orphanedLedgerRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-orphan-"));
  const scriptsDir = path.join(root, "scripts");
  const pilotDir = path.join(root, "audit-pilot");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(pilotDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "reconcile-attestations.sh"), path.join(scriptsDir, "reconcile-attestations.sh"));

  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Solumbe Test"]);
  git(root, ["config", "user.email", "solumbe@example.test"]);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "first commit"]);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "second (#2)"]);
  const target = git(root, ["rev-parse", "HEAD"]);

  // Two records pointing at commits that exist nowhere in this repository.
  const absent = ["2acaa1229ca4d5842b94f572be438d67863c8156", "7890b54afa1bdd1a31e3273a9d8d377825b0c49a"];
  fs.writeFileSync(path.join(pilotDir, "ledger.jsonl"), absent.map((mergeSha, i) => JSON.stringify({ seq: i + 1, mergeSha })).join("\n") + "\n");

  return { root, target };
}

/**
 * Control the variables the script reads rather than inheriting them.
 *
 * `reconcile-attestations.sh` takes its target from `GITHUB_SHA`, which is set
 * on every GitHub runner. Inheriting the ambient environment pointed the
 * script at the *workflow's* commit, which does not exist inside the temp
 * repository, so `git rev-parse --verify` failed under `set -e` and the test
 * saw exit 128 — the very code it exists to prove is gone. It passed on a
 * machine where `GITHUB_SHA` is unset and failed in CI, which is the same
 * shape as the `TYPESAFE_API_KEY` test recorded in the 1.13.1 changelog.
 */
function runReconcile(root, target, env = {}) {
  return spawnSync("bash", [path.join(root, "scripts", "reconcile-attestations.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: target,
      SOLUMBE_TARGET_SHA: "",
      GITHUB_EVENT_BEFORE: "",
      SOLUMBE_ATTEST_RESET_LEDGER: "0",
      SOLUMBE_ATTEST_DRY_RUN: "1",
      ...env,
    },
  });
}

test("an orphaned ledger is diagnosed, not reported as git's invalid revision range", () => {
  // Regression: the coverage-gap check ran `git rev-list FIRST..LAST` before
  // anything established those commits were present, so a ledger bound to a
  // dead history died with "fatal: Invalid revision range" and exit 128 —
  // which reads as a broken script rather than a ledger that needs a decision.
  const { root, target } = orphanedLedgerRepo();
  const result = runReconcile(root, target);

  assert.equal(result.status, 1, "must fail deliberately, not with git's 128");
  assert.notEqual(result.status, 128);
  assert.doesNotMatch(result.stderr, /Invalid revision range/);
  assert.match(result.stderr, /not in this repository|not an ancestor/);
  assert.match(result.stderr, /SOLUMBE_ATTEST_RESET_LEDGER=1/, "must name the recovery");
});

test("resetting an orphaned ledger archives the old chain and starts at the tip", () => {
  const { root, target } = orphanedLedgerRepo();
  const result = runReconcile(root, target, { SOLUMBE_ATTEST_RESET_LEDGER: "1" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /archived superseded chain/);

  // The superseded chain is preserved beside the new one, never deleted.
  const archives = fs.readdirSync(path.join(root, "audit-pilot")).filter((f) => f.startsWith("ledger-orphaned-"));
  assert.equal(archives.length, 1, "the old chain must survive the reset");
  assert.equal(
    fs
      .readFileSync(path.join(root, "audit-pilot", archives[0]), "utf8")
      .trim()
      .split("\n").length,
    2,
  );

  // And the new chain starts AT the tip rather than backfilling every
  // ancestor, which would mint verdicts for commits this gate never ran on.
  const attested = result.stdout
    .trim()
    .split("\n")
    .filter((l) => /^[0-9a-f]{40}$/.test(l));
  assert.deepEqual(attested, [target]);
});

test("the target comes from SOLUMBE_TARGET_SHA, because a workflow cannot override the runner's GITHUB_SHA", () => {
  // Regression: the workflow set GITHUB_SHA on the reconcile step, GitHub kept
  // its own value (the default branch head at run time), and a run meant to
  // start the new chain at b3f795d attested the newer fc0a7b9 instead.
  const { root, target } = orphanedLedgerRepo();
  const runnerHead = git(root, ["rev-list", "--max-parents=0", "HEAD"]);
  const result = runReconcile(root, target, { SOLUMBE_ATTEST_RESET_LEDGER: "1", GITHUB_SHA: runnerHead, SOLUMBE_TARGET_SHA: target });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const attested = result.stdout
    .trim()
    .split("\n")
    .filter((l) => /^[0-9a-f]{40}$/.test(l));
  assert.deepEqual(attested, [target]);
});

test("a ledger that matches the history still reconciles normally", () => {
  const { root, target } = orphanedLedgerRepo();
  // Replace the dead records with the repository's own first commit.
  const first = git(root, ["rev-list", "--max-parents=0", "HEAD"]);
  fs.writeFileSync(path.join(root, "audit-pilot", "ledger.jsonl"), JSON.stringify({ seq: 1, mergeSha: first }) + "\n");

  const result = runReconcile(root, target);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /archived superseded chain/);
  assert.equal(fs.readdirSync(path.join(root, "audit-pilot")).filter((f) => f.startsWith("ledger-orphaned-")).length, 0);
});

// --- record version 2: request, contract, tree, signature, schema, status ---

const { ATTESTATION_SCHEMA_VERSION, attestKeyId, buildAttestation, loadAttestKey, postReceiptStatus, receiptStatus, verifyLedger } =
  await import("../src/lib/attest.js");

/** A `solumbe review --json` payload as a gate with a stated request, an intent and an exact subject produces it. */
function boundVerdict(overrides = {}) {
  return {
    ok: true,
    generatedAt: "2026-10-10T00:00:00.000Z",
    schemaVersion: 3,
    reviewEngineVersion: 1,
    request: "add refund handling to checkout",
    requestStated: true,
    verdict: "PASS",
    confidence: 90,
    pass: {
      policy: "standard",
      governance: "solo",
      checks: [
        { name: "Scope contract", status: "PASS", summary: "dropped" },
        { name: "Review state", status: "SKIPPED" },
      ],
      changedFiles: ["src/payment/checkout.service.ts", "CHANGELOG.md"],
      subject: { kind: "git-commit", baseSha: "b".repeat(40), headSha: "a".repeat(40), treeSha: "7".repeat(40) },
      contract: { tip: "c".repeat(64), request: "add refund handling to checkout", amendments: 1, undeclared: [] },
      convergence: 92,
      band: "aligned",
      receipt: { id: "rcpt_0123456789ab", inputsHash: "e".repeat(64) },
    },
    prReviewSummary: { changedFiles: 2, riskLevel: "high", riskFlags: ["money flow"] },
    impactSummary: { topFiles: [{ path: "src/payment/checkout.service.ts", score: 40 }] },
    ...overrides,
  };
}

function ledgerDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `attest-${prefix}-`));
  return { dir, ledger: path.join(dir, "ledger.jsonl"), verdict: path.join(dir, "verdict.json") };
}

function keyPair(dir, name = "attest") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const files = { private: path.join(dir, `${name}.key.pem`), public: path.join(dir, `${name}.pub.pem`) };
  fs.writeFileSync(files.private, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(files.public, publicKey.export({ type: "spki", format: "pem" }));
  return { ...files, privatePem: fs.readFileSync(files.private, "utf8"), keyId: attestKeyId(publicKey) };
}

test("a version 2 record binds the verdict to the request, the contract, the tree and the change", () => {
  const record = buildAttestation({ verdict: boundVerdict(), merge: "a".repeat(40), prev: "b".repeat(40), pr: 7 }, []);
  assert.equal(ATTESTATION_SCHEMA_VERSION, 2);
  assert.equal(record.request, "add refund handling to checkout");
  assert.deepEqual(record.contract, { tip: "c".repeat(64), amendments: 1, undeclared: 0 });
  assert.deepEqual(record.subject, { kind: "git-commit", baseSha: "b".repeat(40), headSha: "a".repeat(40), treeSha: "7".repeat(40) });
  assert.match(record.changedPathsHash, /^[0-9a-f]{64}$/);
  assert.equal(record.convergence, 92);
  assert.equal(record.band, "aligned");
  assert.equal(record.receipt, "e".repeat(64));
  assert.equal(record.signature, undefined, "no key, no signature");

  // The paths are bound by hash, in any order, and never listed.
  const reordered = buildAttestation(
    { verdict: boundVerdict({ pass: { ...boundVerdict().pass, changedFiles: ["CHANGELOG.md", "src/payment/checkout.service.ts"] } }), merge: "a".repeat(40) },
    [],
  );
  assert.equal(reordered.changedPathsHash, record.changedPathsHash);
  assert.ok(!JSON.stringify(record).includes("CHANGELOG.md"));

  // A verdict that carried none of it records nulls, not guesses: the
  // placeholder request is not a request anyone stated.
  const bare = buildAttestation({ verdict: { verdict: "WARN", request: "review this change", pass: { checks: [] } }, merge: "d".repeat(40) }, []);
  assert.deepEqual(
    [bare.request, bare.contract, bare.subject, bare.changedPathsHash, bare.convergence, bare.band, bare.receipt],
    [null, null, null, null, null, null, null],
  );
});

test("a record signed with an Ed25519 key verifies against its public key and against nothing else", () => {
  const { dir, ledger, verdict } = ledgerDir("signed");
  const key = keyPair(dir);
  const other = keyPair(dir, "other");
  fs.writeFileSync(verdict, JSON.stringify(boundVerdict()));

  const signed = runAttest(["--verdict", verdict, "--merge", "a".repeat(40), "--ledger", ledger, "--sign-key", key.private, "--json"]);
  assert.equal(signed.status, 0, signed.stderr || signed.stdout);
  const { record } = JSON.parse(signed.stdout);
  assert.deepEqual(Object.keys(record.signature), ["alg", "keyId", "value"]);
  assert.equal(record.signature.alg, "ed25519");
  assert.equal(record.signature.keyId, key.keyId);

  const verified = runAttest(["--verify", "--ledger", ledger, "--public-key", key.public]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, new RegExp(`Chain intact: 1 record\\(s\\), tip [0-9a-f]{12}, 1 signed by key ${key.keyId}`));

  const wrongKey = runAttest(["--verify", "--ledger", ledger, "--public-key", other.public]);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stdout, /BAD SIGNATURE/);
  assert.match(wrongKey.stdout, new RegExp(`SIGNATURE MISMATCH: 1 record\\(s\\) were not signed by key ${other.keyId}`));

  // Without a key the chain is still checked, and the signature is reported as unchecked.
  const unchecked = runAttest(["--verify", "--ledger", ledger]);
  assert.equal(unchecked.status, 0);
  assert.match(unchecked.stdout, /signed \(not checked: no public key\)/);

  // The private key alone is enough to check its own signatures.
  assert.equal(runAttest(["--verify", "--ledger", ledger, "--sign-key", key.private]).status, 0);

  // A signature moved onto a record it was not made for does not verify.
  const row = JSON.parse(fs.readFileSync(ledger, "utf8"));
  const forged = buildAttestation({ verdict: boundVerdict({ verdict: "FAIL" }), merge: "a".repeat(40) }, []);
  fs.writeFileSync(ledger, `${JSON.stringify({ ...forged, signature: row.signature })}\n`);
  const result = verifyLedger(ledger, { publicKey: loadAttestKey(key.public, { asPublic: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.chain[0].valid, true, "the chain itself recomputes");
  assert.equal(result.chain[0].signature, "invalid");
});

test("the signing key can come from the environment, and an unsigned record fails only when a signature is required", () => {
  const { dir, ledger, verdict } = ledgerDir("env-key");
  const key = keyPair(dir);
  fs.writeFileSync(verdict, JSON.stringify(boundVerdict()));

  const unsigned = runAttest(["--verdict", verdict, "--merge", "a".repeat(40), "--ledger", ledger, "--json"]);
  assert.equal(JSON.parse(unsigned.stdout).record.signature, undefined);
  const signed = runAttest(["--verdict", verdict, "--merge", "c".repeat(40), "--ledger", ledger, "--json"], {
    env: { ...process.env, SOLUMBE_ATTEST_KEY_PEM: key.privatePem },
  });
  assert.equal(JSON.parse(signed.stdout).record.signature.keyId, key.keyId);

  const lenient = runAttest(["--verify", "--ledger", ledger, "--public-key", key.public, "--json"]);
  assert.equal(lenient.status, 0, "a ledger that began before signing still verifies");
  assert.deepEqual(JSON.parse(lenient.stdout).signatures, { signed: 1, verified: 1, invalid: 0, unsigned: 1, keyId: key.keyId });

  const strict = runAttest(["--verify", "--ledger", ledger, "--public-key", key.public, "--require-signature"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /UNSIGNED: 1 record\(s\) carry no signature/);
});

test("attestation keys are Ed25519 PEM, and anything else is refused before a record is written", () => {
  const { dir, ledger, verdict } = ledgerDir("bad-key");
  fs.writeFileSync(verdict, JSON.stringify(boundVerdict()));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(path.join(dir, "rsa.pem"), rsa);

  const refused = runAttest(["--verdict", verdict, "--merge", "a".repeat(40), "--ledger", ledger, "--sign-key", path.join(dir, "rsa.pem")]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /attestation keys are Ed25519, not rsa/);
  assert.equal(fs.existsSync(ledger), false);

  assert.throws(() => loadAttestKey(path.join(dir, "missing.pem")), /no key file at/);
  // A PEM envelope with no key in it, assembled so this file holds no key block.
  const label = "PRIVATE KEY";
  assert.throws(() => loadAttestKey(`-----BEGIN ${label}-----\nnope\n-----END ${label}-----`), /could not read a private key/);
  assert.equal(loadAttestKey(""), null);
});

/** The subset of JSON Schema the published record schema uses. */
function conforms(schema, value, where = "record") {
  if (schema.oneOf) {
    const matching = schema.oneOf.filter((option) => conforms(option, value, where).length === 0);
    return matching.length === 1 ? [] : [`${where}: matches ${matching.length} of oneOf`];
  }
  if ("const" in schema) return value === schema.const ? [] : [`${where}: is not ${JSON.stringify(schema.const)}`];
  if (schema.enum) return schema.enum.includes(value) ? [] : [`${where}: ${JSON.stringify(value)} is not in the enum`];
  const typeOf = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const allowed = [schema.type ?? []].flat();
  if (allowed.length && !allowed.includes(typeOf) && !(typeOf === "integer" && allowed.includes("number")))
    return [`${where}: is ${typeOf}, not ${allowed.join("|")}`];
  const problems = [];
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) problems.push(`${where}: does not match ${schema.pattern}`);
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) problems.push(`${where}: below ${schema.minimum}`);
  if (typeOf === "array" && schema.items) value.forEach((item, index) => problems.push(...conforms(schema.items, item, `${where}[${index}]`)));
  if (typeOf === "object") {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${where}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) problems.push(...conforms(schema.properties[key], item, `${where}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${where}: ${key} is not in the schema`);
    }
  }
  return problems;
}

test("every record the command writes conforms to the published schema, signed or not", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs/schemas/attestation-record.v2.json"), "utf8"));
  const { dir } = ledgerDir("schema");
  const signingKey = loadAttestKey(keyPair(dir).private);

  const bound = buildAttestation(
    { verdict: boundVerdict(), merge: "a".repeat(40), prev: "b".repeat(40), pr: 7, author: "T", committed: "2026-10-10T00:00:00Z", signingKey },
    [],
  );
  const bare = buildAttestation({ verdict: { verdict: "WARN", pass: { checks: [] } }, merge: "d".repeat(40) }, [bound]);
  assert.deepEqual(conforms(schema, bound), []);
  assert.deepEqual(conforms(schema, bare), []);

  // The schema names every field a record has, so one cannot be added to the
  // record without being published.
  const { signature: _signature, ...unsignedFields } = bound;
  assert.deepEqual(Object.keys(unsignedFields).sort(), [...schema.required].sort());
  assert.deepEqual(conforms(schema, { ...bound, extra: true }), ["record: extra is not in the schema"]);
  assert.deepEqual(conforms(schema, { ...bound, verdict: "MAYBE" }), ['record.verdict: "MAYBE" is not in the enum']);
});

test("a record is published as the solumbe/receipt commit status on the commit it attests", () => {
  const { dir, ledger, verdict } = ledgerDir("status");
  const key = keyPair(dir);
  fs.writeFileSync(verdict, JSON.stringify(boundVerdict()));
  runAttest(["--verdict", verdict, "--merge", "a".repeat(40), "--ledger", ledger, "--sign-key", key.private]);
  const [record] = fs
    .readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(receiptStatus(record, { targetUrl: "https://example.test/ledger" }), {
    context: "solumbe/receipt",
    state: "success",
    description: `PASS · record #1 ${record.recordHash.slice(0, 12)} · tree 7777777 · signed ${key.keyId}`,
    target_url: "https://example.test/ledger",
  });
  assert.equal(receiptStatus({ ...record, verdict: "FAIL" }).state, "failure");
  assert.equal(receiptStatus({ ...record, verdict: "WARN" }).state, "success", "a WARN asks for a reviewer; it does not block");

  const dryRun = runAttest(["--status", "--ledger", ledger, "--repo", "acme/shop", "--dry-run"]);
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  assert.match(dryRun.stdout, /^Would publish solumbe\/receipt on acme\/shop@aaaaaaa: success · PASS · record #1 /);

  assert.equal(runAttest(["--status", "--ledger", ledger, "--merge", "f".repeat(40), "--dry-run"]).status, 1, "no record for that commit");

  // Posting goes through the caller's own gh login.
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    return { ok: true, status: 0, stdout: "{}", stderr: "" };
  };
  const posted = postReceiptStatus(record, { repo: "acme/shop", runner });
  assert.equal(posted.posted, true);
  assert.deepEqual(calls[0].slice(0, 5), ["gh", "api", "--method", "POST", `repos/acme/shop/statuses/${"a".repeat(40)}`]);
  assert.ok(calls[0].includes("context=solumbe/receipt") && calls[0].includes("state=success"));

  const refused = postReceiptStatus(record, {
    repo: "acme/shop",
    runner: () => ({ ok: false, status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration\nmore" }),
  });
  assert.deepEqual([refused.posted, refused.error], [false, "HTTP 403: Resource not accessible by integration"]);
});
