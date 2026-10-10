import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateConvergence } from "../src/lib/converge.js";
import { generateImpact } from "../src/lib/impact.js";
import {
  DEFAULT_INTENT_PATH,
  INTENT_SCHEMA,
  amendIntent,
  declareIntent,
  declaredScope,
  formatIntentMarkdown,
  intentFromImpact,
  readIntent,
  verifyIntent,
  writeIntent,
} from "../src/lib/intent.js";
import { evaluateLocal } from "../src/lib/pass-local.js";

// The scope contract: a request's predicted files are frozen before the edit,
// and the gate holds the diff against that record. These tests cover the
// record (declare, amend, verify), the comparison convergence makes against it,
// and the gate check that fails an undeclared file.

const REQUEST = "update the greeting message";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-intent-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  write(root, {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hi ${name}`; }\n",
    "src/auth/session.ts": "export const sessionTtl = 3600;\n",
    "tests/greeting.test.ts": "export const t = 1;\n",
  });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/** The edit the request asks for, its test, and an unrequested change to session expiry. */
function editWithDrift(root) {
  write(root, {
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hello ${name}`; }\n",
    "tests/greeting.test.ts": "export const t = 2;\n",
    "src/auth/session.ts": "export const sessionTtl = Infinity;\n",
  });
  git(root, "add", "src", "tests");
}

const contractCheck = (result) => result.checks.find((check) => check.name === "Scope contract");

test("declareIntent freezes the predicted files, the commit and a contract hash", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });

  assert.equal(intent.schema, INTENT_SCHEMA);
  assert.equal(intent.request, REQUEST);
  assert.equal(intent.head, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(intent.declared.owners, ["src/greeting/greeting.ts"]);
  assert.equal(intent.grounded, true);
  assert.deepEqual(intent.dirtyAtDeclaration, []);
  assert.deepEqual(intent.amendments, []);
  assert.match(intent.contractHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyIntent(intent), { ok: true, tip: intent.contractHash });

  // Identity, not a timestamp: declaring the same request on the same tree
  // later gives the same contract.
  const later = declareIntent(REQUEST, { path: root, now: () => new Date("2030-01-01T00:00:00Z") });
  assert.equal(later.contractHash, intent.contractHash);
  assert.notEqual(later.declaredAt, intent.declaredAt);

  // The same record comes from an impact result that was already computed.
  assert.equal(intentFromImpact(generateImpact(REQUEST, { path: root }).data).contractHash, intent.contractHash);
});

test("an intent declared after the edit began says which files had already changed", () => {
  const root = fixture();
  write(root, { "src/auth/session.ts": "export const sessionTtl = 60;\n" });
  const intent = declareIntent(REQUEST, { path: root });
  assert.deepEqual(intent.dirtyAtDeclaration, ["src/auth/session.ts"]);
  assert.match(formatIntentMarkdown(intent), /Already changed when this was declared: `src\/auth\/session\.ts`/);
});

test("a request that predicts no owner file declares nothing, and says how to name files", () => {
  const root = fixture();
  const intent = declareIntent("tidy things up", { path: root });
  assert.equal(intent.grounded, false);
  assert.deepEqual(intent.declared.owners, []);
  assert.match(formatIntentMarkdown(intent), /predicted no owner file, so the contract declares nothing yet/);
});

test("amendIntent chains each amendment to the one before it and leaves the original alone", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  const once = amendIntent(intent, ["./src/auth/session.ts"], "the greeting now outlives the session");
  const twice = amendIntent(once, ["README.md", "README.md"], "document the new greeting");

  assert.equal(intent.amendments.length, 0, "the record passed in is not mutated");
  assert.deepEqual(once.amendments[0].files, ["src/auth/session.ts"], "paths are normalised");
  assert.equal(once.amendments[0].prevHash, intent.contractHash);
  assert.equal(twice.amendments[1].prevHash, once.amendments[0].hash);
  assert.deepEqual(twice.amendments[1].files, ["README.md"]);
  assert.deepEqual(verifyIntent(twice), { ok: true, tip: twice.amendments[1].hash });

  const scope = declaredScope(twice, twice.amendments[1].hash);
  assert.deepEqual(scope.owners, ["src/greeting/greeting.ts"]);
  assert.ok(scope.related.includes("src/auth/session.ts") && scope.related.includes("README.md"));
  assert.deepEqual(scope.amended.get("src/auth/session.ts"), { seq: 1, reason: "the greeting now outlives the session" });

  assert.throws(() => amendIntent(intent, ["src/auth/session.ts"], "  "), /needs a reason/);
  assert.throws(() => amendIntent(intent, [], "why"), /at least one file/);
  assert.throws(() => amendIntent(intent, ["../outside.ts"], "why"), /repository path/);
  assert.throws(() => amendIntent(intent, ["/etc/passwd"], "why"), /repository path/);
});

test("verifyIntent refuses a record whose request, files or amendments were edited afterwards", () => {
  const root = fixture();
  const intent = amendIntent(declareIntent(REQUEST, { path: root }), ["src/auth/session.ts"], "the greeting now outlives the session");
  const edited = (change) => {
    const copy = JSON.parse(JSON.stringify(intent));
    change(copy);
    return verifyIntent(copy);
  };

  assert.match(edited((copy) => copy.declared.owners.push("src/auth/session.ts")).error, /contract hash mismatch/);
  assert.match(edited((copy) => (copy.request = "rewrite auth")).error, /contract hash mismatch/);
  assert.match(edited((copy) => (copy.amendments[0].reason = "because")).error, /amendment 1 was altered/);
  assert.match(edited((copy) => copy.amendments[0].files.push("README.md")).error, /amendment 1 was altered/);
  assert.match(edited((copy) => (copy.schema = "solumbe.intent/v0")).error, /schema/);
  assert.equal(verifyIntent(null).ok, false);
  assert.throws(() => amendIntent({ ...intent, request: "rewrite auth" }, ["README.md"], "why"), /does not verify/);
});

test("an intent round-trips through its file, its JSON and the record itself", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  const file = writeIntent(root, intent);
  assert.equal(file, path.join(root, DEFAULT_INTENT_PATH));
  assert.deepEqual(readIntent(root, DEFAULT_INTENT_PATH), intent);
  assert.deepEqual(readIntent(root, JSON.stringify(intent)), intent);
  assert.equal(readIntent(root, intent), intent);
  assert.throws(() => readIntent(root, "missing.json"), /no intent file at missing\.json/);
  assert.throws(() => readIntent(root, "{not json"), /not valid JSON/);
});

test("convergence holds the diff against the declared scope and binds the receipt to the contract", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  editWithDrift(root);

  const live = generateConvergence(REQUEST, { path: root, base: "HEAD", staged: true });
  const held = generateConvergence(REQUEST, { path: root, base: "HEAD", staged: true, declared: declaredScope(intent, intent.contractHash) });

  assert.deepEqual(held.contract, { tip: intent.contractHash, undeclared: ["src/auth/session.ts"] });
  assert.deepEqual(held.drivers.confirmedDirect, ["src/greeting/greeting.ts"]);
  assert.deepEqual(
    held.drivers.inferredRelated.map((entry) => entry.file),
    ["tests/greeting.test.ts"],
    "a test of a declared file is implied, not undeclared",
  );
  assert.ok(held.recommendations.some((rec) => /Changed but never declared: `src\/auth\/session\.ts`/.test(rec)));
  assert.notEqual(held.receipt.inputsHash, live.receipt.inputsHash, "the receipt names the contract it was measured under");
  assert.equal(live.contract, undefined);

  assert.throws(
    () => generateConvergence(REQUEST, { path: root, base: "HEAD", staged: true, declared: { tip: "nope", owners: [], related: [] } }),
    /invalid declared scope/,
  );
});

test("the gate fails a changed file that was never declared, and passes once it is amended with a reason", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  editWithDrift(root);

  const failed = evaluateLocal(root, { base: "HEAD", staged: true, intent });
  const check = contractCheck(failed);
  assert.equal(check.status, "FAIL");
  assert.match(check.summary, /^Touched `src\/auth\/session\.ts`, which was never declared\./);
  assert.ok(check.details.includes("Changed files: 3 (1 declared, 0 amended, 1 implied, 1 undeclared)"));
  assert.ok(check.details.includes("Implied: tests/greeting.test.ts (owner-test of src/greeting/greeting.ts)"));
  assert.ok(check.details.some((line) => line.startsWith("Undeclared on a risk-sensitive path: src/auth/session.ts [")));
  assert.equal(failed.verdict, "FAIL");
  assert.deepEqual(failed.contract.undeclared, ["src/auth/session.ts"]);

  const amended = amendIntent(intent, ["src/auth/session.ts"], "the greeting now outlives the session");
  const passed = evaluateLocal(root, { base: "HEAD", staged: true, intent: amended });
  assert.equal(contractCheck(passed).status, "PASS");
  assert.ok(contractCheck(passed).details.includes("Amended #1: src/auth/session.ts (the greeting now outlives the session)"));
  assert.deepEqual(passed.contract, { tip: amended.amendments[0].hash, request: REQUEST, amendments: 1, undeclared: [] });

  // The contract also works from the file the command line writes.
  writeIntent(root, amended);
  assert.equal(contractCheck(evaluateLocal(root, { base: "HEAD", staged: true, intent: DEFAULT_INTENT_PATH })).status, "PASS");
});

test("the gate refuses a contract that does not verify, a different request, and an unreadable intent", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  editWithDrift(root);

  const forged = { ...intent, declared: { ...intent.declared, supporting: ["src/auth/session.ts"] } };
  assert.match(contractCheck(evaluateLocal(root, { base: "HEAD", staged: true, intent: forged })).summary, /does not verify: .*contract hash mismatch/);

  const other = evaluateLocal(root, { base: "HEAD", staged: true, intent, request: "rewrite session expiry" });
  assert.equal(contractCheck(other).status, "FAIL");
  assert.match(contractCheck(other).summary, /different request than the one declared/);

  assert.match(contractCheck(evaluateLocal(root, { base: "HEAD", staged: true, intent: "nowhere.json" })).summary, /Could not read the declared intent/);
  assert.equal(contractCheck(evaluateLocal(root, { base: "HEAD", staged: true })), undefined, "no intent, no check");
});

test("a convergence floor is measured against the declared files when an intent is supplied", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  editWithDrift(root);

  const result = evaluateLocal(root, { base: "HEAD", staged: true, intent, minConvergence: 0 });
  const convergence = result.checks.find((check) => check.name === "Convergence");
  const held = generateConvergence(REQUEST, { path: root, base: "HEAD", staged: true, declared: declaredScope(intent, intent.contractHash) });
  assert.equal(convergence.receipt.inputsHash, held.receipt.inputsHash, "the request comes from the intent and the score from its declared files");
});

// --- command line ---

function cli(cwd, ...args) {
  return spawnSync(process.execPath, [path.resolve("src/cli.js"), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

test("solumbe declare, amend and gate --intent carry a contract from before the edit to the verdict", () => {
  const root = fixture();
  const declared = cli(root, "declare", ".", REQUEST, "--json");
  assert.equal(declared.status, 0, declared.stderr);
  const { path: file, intent } = JSON.parse(declared.stdout);
  assert.equal(file, path.join(root, DEFAULT_INTENT_PATH));
  assert.deepEqual(intent.declared.owners, ["src/greeting/greeting.ts"]);

  editWithDrift(root);
  const failed = cli(root, "gate", ".", "--staged", "--base", "HEAD", "--intent", DEFAULT_INTENT_PATH, "--json");
  assert.equal(failed.status, 1, "an undeclared file fails the gate");
  assert.equal(contractCheck(JSON.parse(failed.stdout)).status, "FAIL");

  const missingReason = cli(root, "amend", "src/auth/session.ts");
  assert.equal(missingReason.status, 1);
  assert.match(missingReason.stderr, /needs a reason/);

  const amended = cli(root, "amend", "src/auth/session.ts", "--reason", "the greeting now outlives the session");
  assert.equal(amended.status, 0, amended.stderr);
  assert.match(amended.stdout, /#1 `src\/auth\/session\.ts`: the greeting now outlives the session/);

  const passed = JSON.parse(cli(root, "gate", ".", "--staged", "--base", "HEAD", "--intent", DEFAULT_INTENT_PATH, "--json").stdout);
  assert.equal(contractCheck(passed).status, "PASS");
  assert.equal(passed.contract.amendments, 1);

  const text = cli(root, "declare", REQUEST, "--out", "contract.json");
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /# Declared intent/);
  assert.match(text.stdout, /Already changed when this was declared/);
  assert.ok(fs.existsSync(path.join(root, "contract.json")));
});
