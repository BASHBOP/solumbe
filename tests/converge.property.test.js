import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { INCONCLUSIVE_BAND, bandFor, generateConvergence, inferDeclaredScope, inferInScopeFiles, makeReceipt } from "../src/lib/converge.js";
import { isSecretPath } from "../src/lib/risk-paths.js";

// Property-based tests for the convergence score. The example tests in
// converge.test.js pin specific diffs; these state what must hold for every
// diff: the score stays in range, the band follows the score, the receipt does
// not depend on the order files arrive in, and scope inference never admits a
// file it was not offered or a secret path.

const BANDS = ["drift", "partial", "aligned"];

const segment = fc.constantFrom("src", "lib", "app", "billing", "auth", "greeting", "secrets", "credentials", "docs", "tests");
const basename = fc.constantFrom("index.js", "greeting.ts", "session.ts", "invoice.ts", ".env", "id_rsa", "README.md", "greeting.test.ts", "schema.sql");
const filePath = fc.tuple(fc.array(segment, { minLength: 0, maxLength: 3 }), basename).map(([dirs, name]) => [...dirs, name].join("/"));
const fileList = fc.uniqueArray(filePath, { maxLength: 8 });

/** A list together with one reordering of it. */
const shuffled = (/** @type {fc.Arbitrary<string[]>} */ list) =>
  list.chain((files) => fc.tuple(fc.constant(files), fc.shuffledSubarray(files, { minLength: files.length })));

test("property: bandFor is total and monotone in the score", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), (a, b) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      assert.ok(BANDS.includes(bandFor(low)));
      assert.ok(BANDS.indexOf(bandFor(low)) <= BANDS.indexOf(bandFor(high)), `${low} -> ${bandFor(low)}, ${high} -> ${bandFor(high)}`);
    }),
  );
});

test("property: a receipt does not depend on the order of its file lists", () => {
  fc.assert(
    fc.property(shuffled(fileList), shuffled(fileList), shuffled(fileList), fc.integer({ min: 0, max: 100 }), (changed, direct, missed, convergence) => {
      const payload = (/** @type {number} */ side) => ({
        engine: "test",
        task: "a task",
        base: "origin/main",
        commit: "abc123",
        convergence,
        subScores: { coverage: convergence, scope: convergence, riskAlignment: convergence },
        changedFiles: changed[side],
        confirmedDirect: direct[side],
        confirmedRelated: [],
        unconfirmedCandidates: [],
        missedChangedFiles: missed[side],
      });
      const one = makeReceipt(payload(0));
      const other = makeReceipt(payload(1));
      assert.deepEqual(one, other);
      assert.match(one.inputsHash, /^[0-9a-f]{64}$/);
      assert.equal(one.id, `rcpt_${one.inputsHash.slice(0, 12)}`);
    }),
  );
});

test("property: a receipt changes when the score or the changed files change", () => {
  fc.assert(
    fc.property(fileList, filePath, fc.integer({ min: 0, max: 99 }), (files, extra, convergence) => {
      fc.pre(!files.includes(extra));
      const payload = { engine: "test", task: "a task", base: "origin/main", commit: "abc123", convergence, subScores: {}, changedFiles: files };
      const receipt = makeReceipt(payload);
      assert.notEqual(makeReceipt({ ...payload, convergence: convergence + 1 }).inputsHash, receipt.inputsHash);
      assert.notEqual(makeReceipt({ ...payload, changedFiles: [...files, extra] }).inputsHash, receipt.inputsHash);
    }),
  );
});

test("property: inferInScopeFiles is order-independent and only admits offered, non-secret files", () => {
  fc.assert(
    fc.property(shuffled(fileList), shuffled(fileList), shuffled(fileList), (direct, candidates, added) => {
      const input = (/** @type {number} */ side) => ({
        confirmedDirect: direct[side],
        confirmedRelated: [],
        candidates: candidates[side],
        addedFiles: added[side],
        mappedFiles: candidates[side],
      });
      const inferred = inferInScopeFiles(input(0));
      assert.deepEqual(inferred, inferInScopeFiles(input(1)));
      const files = inferred.map((entry) => entry.file);
      assert.equal(new Set(files).size, files.length, "a file is inferred at most once");
      for (const file of files) {
        assert.ok(candidates[0].includes(file), `${file} was never a candidate`);
        assert.equal(isSecretPath(file), false, `${file} is a secret path`);
      }
    }),
  );
});

test("property: inferDeclaredScope only admits offered, non-secret files, each once", () => {
  fc.assert(
    fc.property(
      fileList,
      fileList,
      fileList,
      fc.array(fc.constantFrom("greeting", "billing", "auth", "session", "invoice"), { maxLength: 3 }),
      (owners, inScope, candidates, terms) => {
        const inferred = inferDeclaredScope({
          declared: { owners, terms, modules: [] },
          inScope,
          candidates,
          imports: { edges: new Map(), importers: new Map() },
        });
        const files = inferred.map((entry) => entry.file);
        assert.equal(new Set(files).size, files.length, "a file is inferred at most once");
        for (const file of files) {
          assert.ok(candidates.includes(file), `${file} was never a candidate`);
          assert.equal(isSecretPath(file), false, `${file} is a secret path`);
        }
      },
    ),
  );
});

// The properties below run the whole score against a real repository, so they
// use few runs: each one stages a diff and scores it twice.

function git(/** @type {string} */ cwd, /** @type {string[]} */ ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const BASE_FILES = {
  "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
  "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hi ${name}`; }\n",
  "src/auth/session.ts": "export const sessionTtl = 3600;\n",
  "src/billing/invoice.ts": "export const invoiceTotal = 0;\n",
  "tests/greeting.test.ts": "export const t = 1;\n",
};

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-converge-property-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  for (const [file, body] of Object.entries(BASE_FILES)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

test("property: a scored diff stays in range, its band follows its score, and scoring it again gives the same receipt", () => {
  const root = fixture();
  const editable = Object.keys(BASE_FILES).filter((file) => file !== "package.json");
  const request = fc.constantFrom("update the greeting message", "change the session expiry", "tidy things up");

  fc.assert(
    fc.property(request, fc.uniqueArray(fc.constantFrom(...editable), { minLength: 1 }), fc.nat(), (task, files, salt) => {
      git(root, "reset", "-q", "--hard", "HEAD");
      for (const file of files) fs.appendFileSync(path.join(root, file), `export const edit${salt} = ${salt};\n`);
      git(root, "add", ".");

      const data = generateConvergence(task, { path: root, base: "HEAD", staged: true });
      if (data.convergence === null) {
        assert.equal(data.band, INCONCLUSIVE_BAND);
        assert.deepEqual(data.subScores, { coverage: null, scope: null, riskAlignment: null });
      } else {
        assert.ok(Number.isInteger(data.convergence) && data.convergence >= 0 && data.convergence <= 100, `score ${data.convergence}`);
        assert.equal(data.band, bandFor(data.convergence));
        for (const [name, value] of Object.entries(data.subScores)) {
          assert.ok(value >= 0 && value <= 100, `${name} ${value}`);
        }
      }
      assert.equal(data.drivers.changedFiles, files.length);

      const again = generateConvergence(task, { path: root, base: "HEAD", staged: true });
      assert.deepEqual(again.receipt, data.receipt);
      assert.equal(again.convergence, data.convergence);
    }),
    { numRuns: 12 },
  );
});
