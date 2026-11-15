import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fc from "fast-check";
import { amendIntent, declareIntent } from "../src/lib/intent.js";
import { migrationCheck, scopeContractCheck, secretCheck } from "../src/lib/pass-local.js";

// Property-based tests for the gate's checks. pass-local.test.js and
// intent.test.js pin specific changes; these state what must hold for every
// change: an undeclared file always fails the scope contract and the same file
// amended always passes, a credential in changed content always fails however
// many clean files surround it, and a change without a SQL migration never
// produces a migration check.

const REQUEST = "update the greeting message";

function git(/** @type {string} */ cwd, /** @type {string[]} */ ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function write(/** @type {string} */ root, /** @type {Record<string, string>} */ files) {
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-property-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  write(root, {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hi ${name}`; }\n",
  });
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

// Paths the request cannot reach: no directory shared with the owner file, no
// path word in common with the request, no import, not a test and not a doc.
// The `zq` prefix keeps every generated word out of the request's vocabulary.
const word = fc.stringMatching(/^zq[a-z]{1,6}$/);
const unrelatedFile = fc.tuple(word, word).map(([dir, name]) => `${dir}/${name}.ts`);
const unrelatedFiles = fc.uniqueArray(unrelatedFile, { minLength: 1, maxLength: 4 });

test("property: an undeclared file always fails the scope contract, and the same file amended always passes", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });
  assert.deepEqual(intent.declared.owners, ["src/greeting/greeting.ts"]);

  fc.assert(
    fc.property(unrelatedFiles, fc.boolean(), (extra, editOwner) => {
      git(root, "reset", "-q", "--hard", "HEAD");
      if (editOwner) write(root, { "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hello ${name}`; }\n" });
      write(root, Object.fromEntries(extra.map((file, index) => [file, `export const value${index} = ${index};\n`])));
      git(root, "add", ".");

      const undeclared = scopeContractCheck(root, "HEAD", REQUEST, intent, { staged: true });
      assert.equal(undeclared?.check.status, "FAIL", undeclared?.check.summary);
      assert.deepEqual([...undeclared.check.contract.undeclared].sort(), [...extra].sort());
      for (const file of extra) assert.ok(undeclared.check.summary.includes(`\`${file}\``), `the summary does not name ${file}`);

      const amended = scopeContractCheck(root, "HEAD", REQUEST, amendIntent(intent, extra, "needed by the greeting"), { staged: true });
      assert.equal(amended?.check.status, "PASS", amended?.check.summary);
      assert.deepEqual(amended.check.contract.undeclared, []);
    }),
    { numRuns: 12 },
  );
});

test("property: a tampered intent never verifies, whatever was changed", () => {
  const root = fixture();
  const intent = declareIntent(REQUEST, { path: root });

  fc.assert(
    fc.property(unrelatedFiles, (extra) => {
      const tampered = { ...intent, declared: { ...intent.declared, owners: [...intent.declared.owners, ...extra] } };
      const result = scopeContractCheck(root, "HEAD", REQUEST, tampered, { staged: true });
      assert.equal(result?.check.status, "FAIL");
      assert.match(result.check.summary, /does not verify/);
    }),
    { numRuns: 25 },
  );
});

// A credential in the shape of an AWS access key id; built at runtime so this
// file does not itself carry one.
const awsKeyId = fc.stringMatching(/^[A-Z2-7]{16}$/).map((tail) => `AKIA${tail}`);
const cleanSource = fc.constantFrom("export const total = 1;\n", "function add(a, b) { return a + b; }\n", "// nothing to see\n", "");
const sourceFile = fc.tuple(word, word).map(([dir, name]) => `src/${dir}/${name}.js`);

test("property: a credential value in one changed file fails the secret check however many clean files surround it", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(sourceFile, { minLength: 1, maxLength: 6 }),
      fc.array(cleanSource, { minLength: 6, maxLength: 6 }),
      fc.nat(),
      awsKeyId,
      (files, bodies, pick, key) => {
        const leaking = files[pick % files.length];
        const content = new Map(files.map((file, index) => [file, bodies[index]]));
        const read = (/** @type {string} */ file) => content.get(file) ?? null;

        assert.equal(secretCheck(files, read).status, "PASS", "clean files must pass");

        content.set(leaking, `${content.get(leaking)}const awsAccessKeyId = "${key}";\n`);
        const check = secretCheck(files, read);
        assert.equal(check.status, "FAIL", check.summary);
        assert.ok(
          (check.details ?? []).some((detail) => detail.includes(leaking)),
          `the details do not name ${leaking}`,
        );
        assert.ok(!JSON.stringify(check).includes(key), "the check must not echo the credential");
      },
    ),
  );
});

test("property: a secret file path fails the secret check regardless of its content", () => {
  const secretPath = fc
    .tuple(fc.array(word, { maxLength: 2 }), fc.constantFrom(".env", ".env.production", "id_rsa"))
    .map(([dirs, name]) => [...dirs, name].join("/"));
  fc.assert(
    fc.property(secretPath, fc.uniqueArray(sourceFile, { maxLength: 4 }), cleanSource, (secret, others, body) => {
      const check = secretCheck([...others, secret], () => body);
      assert.equal(check.status, "FAIL", check.summary);
    }),
  );
});

test("property: a change with no SQL migration never produces a migration check", () => {
  fc.assert(
    fc.property(fc.uniqueArray(sourceFile, { maxLength: 6 }), fc.string(), (files, body) => {
      assert.deepEqual(
        migrationCheck(files, () => body),
        [],
      );
    }),
  );
});
