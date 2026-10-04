import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateLocal, formatPassMarkdown, secretCheck } from "../src/lib/pass-local.js";
import { generateConvergence } from "../src/lib/converge.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pass-${prefix}-`));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

function writeAndCommit(root, files, message) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", message);
}

test("evaluateLocal returns PASS when nothing risky changed and tests are present", () => {
  const root = initRepo("clean");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const greet = () => 'hi';\n",
    },
    "init",
  );
  writeAndCommit(root, { "src/index.ts": "export const greet = () => 'hello';\n" }, "tweak");

  const result = evaluateLocal(root, { base: "HEAD~1" });
  assert.equal(result.verdict, "WARN", "review state always warns in local mode");
  const checkNames = result.checks.map((c) => c.name);
  assert.ok(checkNames.includes("Changed files"));
  assert.ok(checkNames.includes("Secret safety"));
  assert.ok(checkNames.includes("Risk review"));
  assert.ok(checkNames.includes("Release discipline"));
  assert.ok(checkNames.includes("Validation commands"));
  assert.ok(checkNames.includes("Dependency audit"));
  assert.ok(checkNames.includes("Review state"));
  assert.ok(checkNames.includes("Policy profile"));
});

test("evaluateLocal evaluates only the Git index when staged mode is enabled", () => {
  const root = initRepo("staged");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const greet = () => 'hi';\n",
      "src/unstaged.ts": "export const unstaged = false;\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const greet = () => 'hello';\n");
  git(root, "add", "src/index.ts");
  fs.writeFileSync(path.join(root, "src/unstaged.ts"), "export const unstaged = true;\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=not-staged\n");

  const result = evaluateLocal(root, { base: "HEAD", staged: true });
  assert.equal(result.scope, "staged");
  assert.deepEqual(result.changedFiles, ["src/index.ts"]);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.checks.find((check) => check.name === "Review state").status, "PASS");
  assert.equal(result.checks.find((check) => check.name === "Secret safety").status, "PASS");
  assert.match(result.checks.find((check) => check.name === "Staged snapshot").details.join(" "), /not bound by this convergence receipt/);
});

test("run-validation executes the base-committed policy against the exact staged tree", () => {
  const root = initRepo("validation-snapshot");
  writeAndCommit(
    root,
    {
      "solumbe.gate.json": JSON.stringify({
        version: 1,
        validation: {
          commands: [
            {
              id: "staged-source",
              command: `${process.execPath} -e "const fs=require('node:fs'); process.exit(fs.readFileSync('src/value.js','utf8').includes('staged') ? 0 : 1)"`,
              timeoutSeconds: 10,
            },
          ],
        },
      }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "src/value.js");
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'unstaged';\n");

  const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
  const execution = result.checks.find((check) => check.name === "Validation execution");

  assert.equal(execution.status, "PASS");
  assert.match(execution.summary, /exact staged tree/);
  assert.equal(result.validationEvidence.policy.version, 1);
  assert.equal(result.validationEvidence.policy.path, "solumbe.gate.json");
  assert.equal(result.validationEvidence.environment.dependencyStateAttested, false);
  assert.equal(result.validationEvidence.commands[0].status, "PASS");
  assert.equal(result.validationEvidence.receipt.receiptVersion, 1);
  assert.deepEqual(result.validationEvidence.receipt.subject, result.subject);
});

test("run-validation reads its policy from the base commit rather than the staged change", () => {
  const root = initRepo("validation-policy");
  writeAndCommit(
    root,
    {
      "solumbe.gate.json": JSON.stringify({
        version: 1,
        validation: { commands: [{ id: "base-policy", command: `${process.execPath} -e "process.exit(0)"` }] },
      }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(
    path.join(root, "solumbe.gate.json"),
    JSON.stringify({ version: 1, validation: { commands: [{ id: "staged-policy", command: `${process.execPath} -e "process.exit(1)"` }] } }),
  );
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "solumbe.gate.json", "src/value.js");

  const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });

  assert.equal(result.checks.find((check) => check.name === "Validation execution").status, "PASS");
  assert.equal(result.validationEvidence.commands[0].id, "base-policy");
});

test("run-validation rejects a staged replacement of a base-pinned npm script", () => {
  const root = initRepo("validation-script-tamper");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(0)"` } }),
      "solumbe.gate.json": JSON.stringify({ version: 1, validation: { commands: [{ id: "unit", command: "npm test" }] } }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(0)"` } }));
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  // A no-op replacement may look successful to npm, but it is not the script
  // approved by the base-committed validation policy.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  git(root, "add", "package.json", "src/value.js");

  const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
  const command = result.validationEvidence.commands[0];

  assert.equal(result.checks.find((check) => check.name === "Validation execution").status, "FAIL");
  assert.equal(command.status, "FAIL");
  assert.equal(command.packageScript.scriptName, "test");
  assert.equal(command.exitCode, null);
});

for (const [label, policyCommand, expectedManager] of [
  ["Yarn", "yarn test", "yarn"],
  ["pnpm", "pnpm test", "pnpm"],
  ["Bun", "bun run test", "bun"],
  ["Corepack Yarn", "corepack yarn run test", "yarn"],
]) {
  test(`run-validation rejects a staged replacement of a base-pinned ${label} script`, () => {
    const root = initRepo(`validation-${expectedManager}-script-tamper`);
    writeAndCommit(
      root,
      {
        "package.json": JSON.stringify({ scripts: { test: `${process.execPath} -e "process.exit(0)"` } }),
        "solumbe.gate.json": JSON.stringify({ version: 1, validation: { commands: [{ id: "unit", command: policyCommand }] } }),
        "src/value.js": "module.exports = 'base';\n",
      },
      "init",
    );
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");

    const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
    const command = result.validationEvidence.commands[0];

    assert.equal(result.checks.find((check) => check.name === "Validation execution").status, "FAIL");
    assert.equal(command.status, "FAIL");
    assert.equal(command.packageScript.packageManager, expectedManager);
    assert.equal(command.packageScript.scriptName, "test");
  });
}

test("run-validation excludes host secrets unless the base policy explicitly allows them", () => {
  const root = initRepo("validation-environment");
  const previous = process.env.SOLUMBE_TEST_HOST_SECRET;
  process.env.SOLUMBE_TEST_HOST_SECRET = "not-for-staged-code";
  writeAndCommit(
    root,
    {
      "solumbe.gate.json": JSON.stringify({
        version: 1,
        validation: {
          commands: [{ id: "secret-boundary", command: `${process.execPath} -e "process.exit(process.env.SOLUMBE_TEST_HOST_SECRET ? 1 : 0)"` }],
        },
      }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "src/value.js");

  try {
    const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
    assert.equal(result.checks.find((check) => check.name === "Validation execution").status, "PASS");
    assert.deepEqual(result.validationEvidence.environment.inheritedVariables, []);
    assert.equal(result.validationEvidence.environment.isolatedHome, true);
  } finally {
    if (previous === undefined) delete process.env.SOLUMBE_TEST_HOST_SECRET;
    else process.env.SOLUMBE_TEST_HOST_SECRET = previous;
  }
});

test("run-validation supports a base-policy allowlist for required environment variables", () => {
  const root = initRepo("validation-environment-allow");
  const previous = process.env.SOLUMBE_TEST_REQUIRED_VALUE;
  process.env.SOLUMBE_TEST_REQUIRED_VALUE = "available";
  writeAndCommit(
    root,
    {
      "solumbe.gate.json": JSON.stringify({
        version: 1,
        validation: {
          environment: { allow: ["SOLUMBE_TEST_REQUIRED_VALUE"] },
          commands: [
            { id: "explicit-secret", command: `${process.execPath} -e "process.exit(process.env.SOLUMBE_TEST_REQUIRED_VALUE === 'available' ? 0 : 1)"` },
          ],
        },
      }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "src/value.js");

  try {
    const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
    assert.equal(result.checks.find((check) => check.name === "Validation execution").status, "PASS");
    assert.deepEqual(result.validationEvidence.environment.inheritedVariables, ["SOLUMBE_TEST_REQUIRED_VALUE"]);
  } finally {
    if (previous === undefined) delete process.env.SOLUMBE_TEST_REQUIRED_VALUE;
    else process.env.SOLUMBE_TEST_REQUIRED_VALUE = previous;
  }
});

test("run-validation records failed command evidence without retaining raw output", () => {
  const root = initRepo("validation-failure");
  const previous = process.env.SOLUMBE_TEST_SECRET_OUTPUT;
  process.env.SOLUMBE_TEST_SECRET_OUTPUT = "private failure";
  writeAndCommit(
    root,
    {
      "solumbe.gate.json": JSON.stringify({
        version: 1,
        validation: { commands: [{ id: "fails", command: `${process.execPath} -e "console.error(process.env.SOLUMBE_TEST_SECRET_OUTPUT); process.exit(2)"` }] },
      }),
      "src/value.js": "module.exports = 'base';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "src/value.js");

  try {
    const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
    const execution = result.checks.find((check) => check.name === "Validation execution");

    assert.equal(execution.status, "FAIL");
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.validationEvidence.commands[0].exitCode, 2);
    assert.match(result.validationEvidence.commands[0].stderrSha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(result.validationEvidence).includes("private failure"));
  } finally {
    if (previous === undefined) delete process.env.SOLUMBE_TEST_SECRET_OUTPUT;
    else process.env.SOLUMBE_TEST_SECRET_OUTPUT = previous;
  }
});

test("run-validation fails closed when the selected base has no versioned validation policy", () => {
  const root = initRepo("validation-policy-missing");
  writeAndCommit(root, { "src/value.js": "module.exports = 'base';\n" }, "init");
  fs.writeFileSync(path.join(root, "src/value.js"), "module.exports = 'staged';\n");
  git(root, "add", "src/value.js");

  const result = evaluateLocal(root, { base: "HEAD", staged: true, runValidation: true });
  const execution = result.checks.find((check) => check.name === "Validation execution");

  assert.equal(execution.status, "FAIL");
  assert.match(execution.summary, /versioned validation policy/);
});

test("staged convergence receipt is bound to the captured Git index tree", () => {
  const root = initRepo("staged-receipt");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      ".gitattributes": "*.ts filter=solumbe-test\n",
      "src/index.ts": "export const greet = () => 'hi';\n",
      "src/later.ts": "export const later = false;\n",
    },
    "init",
  );
  const filterSentinel = path.join(root, "smudge-filter-ran");
  const filterScript = path.join(root, "smudge-filter.cjs");
  const cleanFilterScript = path.join(root, "clean-filter.cjs");
  fs.writeFileSync(
    filterScript,
    `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(filterSentinel)}, "ran"); process.stdin.pipe(process.stdout);\n`,
  );
  fs.writeFileSync(cleanFilterScript, "process.stdin.pipe(process.stdout);\n");
  git(root, "config", "filter.solumbe-test.clean", `${process.execPath} ${cleanFilterScript}`);
  git(root, "config", "filter.solumbe-test.smudge", `${process.execPath} ${filterScript}`);
  git(root, "config", "filter.solumbe-test.required", "true");
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const greet = () => 'hello';\n");
  git(root, "add", "src/index.ts");
  fs.writeFileSync(path.join(root, "src/later.ts"), "export const later = true;\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=not-staged\n");

  const first = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the greeting", minConvergence: 0 });
  const expectedTree = git(root, "write-tree").trim();
  const expectedParent = git(root, "rev-parse", "HEAD").trim();
  const convergence = first.checks.find((check) => check.name === "Convergence");

  assert.deepEqual(first.changedFiles, ["src/index.ts"]);
  assert.equal(first.subject.kind, "git-index");
  assert.equal(first.subject.treeSha, expectedTree);
  assert.equal(first.subject.parentSha, expectedParent);
  assert.deepEqual(convergence.subject, first.subject);
  assert.deepEqual(convergence.receipt.subject, first.subject);
  assert.deepEqual(first.receipt, convergence.receipt);
  assert.equal(fs.existsSync(filterSentinel), false, "receipt scoring must not execute configured checkout filters");

  fs.writeFileSync(path.join(root, "src/index.ts"), "export const greet = () => 'replacement-content';\n");
  git(root, "add", "src/index.ts");
  const replacementTree = git(root, "write-tree").trim();
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const greet = () => 'hello';\n");
  git(root, "add", "src/index.ts");
  git(root, "replace", first.subject.treeSha, replacementTree);
  const replaceRefIgnored = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the greeting", minConvergence: 0 });
  assert.equal(replaceRefIgnored.receipt.inputsHash, first.receipt.inputsHash, "local replace refs must not change exact-subject scoring");
  git(root, "replace", "-d", first.subject.treeSha);

  assert.throws(
    () => generateConvergence("update the greeting", { path: root, base: "HEAD", subject: first.subject }),
    /subject and diff files must be supplied together/,
  );
  assert.throws(
    () => generateConvergence("update the greeting", { path: root, base: "HEAD", diffFiles: first.changedFiles }),
    /subject and diff files must be supplied together/,
  );
  assert.throws(
    () => generateConvergence("update the greeting", { path: root, base: "HEAD", subject: first.subject, diffFiles: ["src/later.ts"] }),
    /do not match the staged Git tree subject/,
  );

  fs.writeFileSync(path.join(root, "src/later.ts"), "export function updateGreetingForTheGreetingTask() { return 'highly-relevant-but-unstaged'; }\n");
  const sameIndex = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the greeting", minConvergence: 0 });
  assert.equal(sameIndex.subject.treeSha, first.subject.treeSha);
  assert.equal(sameIndex.receipt.inputsHash, first.receipt.inputsHash, "unstaged source edits must not change a staged-tree receipt");

  const abbreviated = evaluateLocal(root, {
    base: "HEAD",
    staged: true,
    request: "update the greeting",
    receipt: first.receipt.id,
  });
  assert.equal(abbreviated.checks.find((check) => check.name === "Convergence").status, "FAIL");
  assert.match(abbreviated.checks.find((check) => check.name === "Convergence").summary, /full inputs hash/);

  const verified = evaluateLocal(root, {
    base: "HEAD",
    staged: true,
    request: "update the greeting",
    receipt: first.receipt.inputsHash,
  });
  assert.equal(verified.checks.find((check) => check.name === "Convergence").status, "PASS");

  git(root, "add", "src/later.ts");
  const second = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the greeting", minConvergence: 0 });
  assert.notEqual(second.subject.treeSha, first.subject.treeSha);
  assert.notEqual(second.receipt.inputsHash, first.receipt.inputsHash);
});

test("staged receipt preserves legal whitespace and newline characters in paths", () => {
  const root = initRepo("staged-unusual-path");
  const unusualPath = "src/ leading\ntrailing .ts";
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      [unusualPath]: "export const unusual = 'before';\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, unusualPath), "export const unusual = 'after';\n");
  git(root, "add", "--", unusualPath);

  const result = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the unusual path", minConvergence: 0 });

  assert.deepEqual(result.changedFiles, [unusualPath]);
  assert.deepEqual(result.receipt.subject, result.subject);
});

test("staged receipt fixes rename detection independently of local Git config", () => {
  const root = initRepo("staged-rename-config");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "src/old-name.ts": "export const renamed = true;\n",
    },
    "init",
  );
  git(root, "mv", "src/old-name.ts", "src/new-name.ts");

  git(root, "config", "diff.renames", "false");
  const disabled = evaluateLocal(root, { base: "HEAD", staged: true, request: "rename the source file", minConvergence: 0 });
  git(root, "config", "diff.renames", "copies");
  git(root, "config", "diff.renameLimit", "1");
  git(root, "config", "diff.algorithm", "histogram");
  const copies = evaluateLocal(root, { base: "HEAD", staged: true, request: "rename the source file", minConvergence: 0 });

  assert.deepEqual(disabled.changedFiles, ["src/new-name.ts"]);
  assert.deepEqual(copies.changedFiles, disabled.changedFiles);
  assert.equal(copies.receipt.inputsHash, disabled.receipt.inputsHash);
});

test("staged receipt includes a gitlink change despite submodule ignore config", () => {
  const root = initRepo("staged-gitlink");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "src/index.ts": "export const baseline = true;\n",
    },
    "init",
  );
  const firstNestedCommit = git(root, "rev-parse", "HEAD").trim();
  git(root, "update-index", "--add", "--cacheinfo", `160000,${firstNestedCommit},vendor/sub`);
  git(root, "commit", "-q", "-m", "add gitlink");
  const baselineTree = git(root, "rev-parse", "HEAD^{tree}").trim();
  const secondNestedCommit = git(root, "commit-tree", baselineTree, "-p", firstNestedCommit, "-m", "nested next").trim();
  git(root, "update-index", "--cacheinfo", `160000,${secondNestedCommit},vendor/sub`);
  git(root, "config", "diff.ignoreSubmodules", "all");

  const result = evaluateLocal(root, { base: "HEAD", staged: true, request: "update the vendor submodule", minConvergence: 0 });

  assert.deepEqual(result.changedFiles, ["vendor/sub"]);
  assert.equal(result.receipt.receiptVersion, 2);
  assert.deepEqual(result.receipt.subject, result.subject);
});

test("staged receipt fails closed before an oversized source tree is analyzed", () => {
  const root = initRepo("staged-source-limit");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "src/index.ts": "export const baseline = true;\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "large-source.ts"), "x".repeat(1024 * 1024));
  const blob = git(root, "hash-object", "-w", "--", "large-source.ts").trim();
  for (let index = 0; index < 65; index += 1) {
    git(root, "update-index", "--add", "--cacheinfo", `100644,${blob},src/generated-${String(index).padStart(2, "0")}.ts`);
  }

  assert.throws(
    () => generateConvergence("add generated sources", { path: root, base: "HEAD", staged: true }),
    /exceeds the safe analysis limit \(5000 files or 64 MiB\)/,
  );
});
test("evaluateLocal includes configured tieline contract evidence", () => {
  const root = initRepo("tieline");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "tieline.config.json"), JSON.stringify({ frontend: ".", backend: "." }));
  const bin = path.join(root, "fake-tieline");
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ totals: { drift: 0 }, drift: [] }));\n`);
  fs.chmodSync(bin, 0o755);
  const previous = process.env.SOLUMBE_TIELINE_BIN;
  process.env.SOLUMBE_TIELINE_BIN = bin;
  try {
    const result = evaluateLocal(root, { base: "HEAD" });
    const contracts = result.checks.find((check) => check.name === "Contract drift");
    assert.equal(contracts.status, "PASS");
    assert.match(contracts.summary, /No frontend↔backend contract drift/);
  } finally {
    if (previous === undefined) delete process.env.SOLUMBE_TIELINE_BIN;
    else process.env.SOLUMBE_TIELINE_BIN = previous;
  }
});

test("evaluateLocal gives the tieline installation command when its configured binary is missing", () => {
  const root = initRepo("tieline-missing");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }), "src/index.ts": "export const hi = 1;\n" }, "init");
  fs.writeFileSync(path.join(root, "tieline.config.json"), JSON.stringify({ frontend: ".", backend: "." }));

  const result = evaluateLocal(root, { base: "HEAD" });
  const contracts = result.checks.find((check) => check.name === "Contract drift");
  assert.equal(contracts.status, "WARN");
  assert.match(contracts.summary, /install @nugehs\/tieline to enable this gate/);
  assert.ok(contracts.details.includes("Repair command: npm install --save-dev @nugehs/tieline"));
  // @bashbop/tieline was never published: npm answers that install with a 404.
  assert.doesNotMatch(JSON.stringify(contracts), /@bashbop\/tieline/);
});

test("evaluateLocal includes configured bouncer compliance evidence", () => {
  const root = initRepo("bouncer");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "bouncer.config.json"), JSON.stringify({ target: { adapter: "next", repo: "." }, packs: ["uk-osa"] }));
  const bin = path.join(root, "fake-bouncer");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ totals: { pass: 2, fail: 1, unknown: 0 }, findings: [{ ruleId: 'osa.report', status: 'fail', fix: 'Add report controls.' }] }));\n`,
  );
  fs.chmodSync(bin, 0o755);
  const previous = process.env.SOLUMBE_BOUNCER_BIN;
  process.env.SOLUMBE_BOUNCER_BIN = bin;
  try {
    const result = evaluateLocal(root, { base: "HEAD" });
    const compliance = result.checks.find((check) => check.name === "Compliance controls");
    assert.equal(compliance.status, "FAIL");
    assert.match(compliance.summary, /1 required control is missing/);
    assert.ok(compliance.details.some((detail) => detail.includes("Repair action: Add report controls.")));
    assert.ok(compliance.details.some((detail) => detail.includes("Recheck command:")));
  } finally {
    if (previous === undefined) delete process.env.SOLUMBE_BOUNCER_BIN;
    else process.env.SOLUMBE_BOUNCER_BIN = previous;
  }
});

test("evaluateLocal gives the bouncer installation command when its configured binary is missing", () => {
  const root = initRepo("bouncer-missing");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }), "src/index.ts": "export const hi = 1;\n" }, "init");
  fs.writeFileSync(path.join(root, "bouncer.config.json"), JSON.stringify({ target: { adapter: "next", repo: "." }, packs: ["uk-osa"] }));

  const result = evaluateLocal(root, { base: "HEAD" });
  const compliance = result.checks.find((check) => check.name === "Compliance controls");
  assert.equal(compliance.status, "WARN");
  assert.match(compliance.summary, /install @nugehs\/bouncer to enable this gate/);
  assert.ok(compliance.details.includes("Repair command: npm install --save-dev @nugehs/bouncer"));
  // @bashbop/bouncer was never published: npm answers that install with a 404.
  assert.doesNotMatch(JSON.stringify(compliance), /@bashbop\/bouncer/);
});

test("evaluateLocal names the CI workflow that runs bouncer through npx without running npx itself", () => {
  const root = initRepo("bouncer-ci");
  const workflow = [
    "name: Compliance Controls (bouncer)",
    "on: pull_request",
    "jobs:",
    "  bouncer:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      # A comment that names @nugehs/bouncer is not a run.",
    "      - name: Run compliance-controls check",
    "        run: npx -y @nugehs/bouncer@latest check",
  ];
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "src/index.ts": "export const hi = 1;\n",
      ".github/workflows/audit.yml": "on: push\njobs:\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm audit\n",
      ".github/workflows/bouncer.yml": `${workflow.join("\n")}\n`,
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "bouncer.config.json"), JSON.stringify({ target: { adapter: "next", repo: "." }, packs: ["uk-osa"] }));
  // Package runners that leave a mark if the gate ever shells out to one.
  const shims = fs.mkdtempSync(path.join(os.tmpdir(), "pass-bouncer-ci-shims-"));
  const ran = path.join(shims, "ran");
  for (const runner of ["npx", "npm"]) {
    fs.writeFileSync(path.join(shims, runner), `#!/bin/sh\necho ${runner} >> "${ran}"\nexit 1\n`);
    fs.chmodSync(path.join(shims, runner), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${shims}${path.delimiter}${previousPath}`;
  try {
    const result = evaluateLocal(root, { base: "HEAD" });
    const compliance = result.checks.find((check) => check.name === "Compliance controls");
    assert.equal(compliance.status, "WARN", "a workflow that runs bouncer is not evidence the controls pass for this change");
    assert.match(compliance.summary, /^bouncer runs in CI \(\.github\/workflows\/bouncer\.yml\) but not locally/);
    const runLine = workflow.indexOf("        run: npx -y @nugehs/bouncer@latest check") + 1;
    assert.ok(compliance.details.includes(`CI workflow: .github/workflows/bouncer.yml:${runLine} · run: npx -y @nugehs/bouncer@latest check`));
    assert.ok(compliance.details.includes("Repair command: npm install --save-dev @nugehs/bouncer"));
    assert.equal(fs.existsSync(ran), false, "the gate must stay offline and never run a package runner");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("evaluateLocal includes opted-in aiglare governance evidence", () => {
  const root = initRepo("aiglare");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  const bin = path.join(root, "fake-aiglare");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ surfaceCount: 1, surfaces: [{ file: 'src/ai.ts', sink: 'side-effectful', severity: 'red' }], gate: { passed: false, blocking: 1 } }));\n`,
  );
  fs.chmodSync(bin, 0o755);
  const previousBin = process.env.SOLUMBE_AIGLARE_BIN;
  const previousOptIn = process.env.SOLUMBE_AIGLARE;
  process.env.SOLUMBE_AIGLARE_BIN = bin;
  process.env.SOLUMBE_AIGLARE = "1";
  try {
    const result = evaluateLocal(root, { base: "HEAD" });
    const governance = result.checks.find((check) => check.name === "AI governance");
    assert.equal(governance.status, "FAIL");
    assert.match(governance.summary, /1 irreversible AI surface lacks/);
  } finally {
    if (previousBin === undefined) delete process.env.SOLUMBE_AIGLARE_BIN;
    else process.env.SOLUMBE_AIGLARE_BIN = previousBin;
    if (previousOptIn === undefined) delete process.env.SOLUMBE_AIGLARE;
    else process.env.SOLUMBE_AIGLARE = previousOptIn;
  }
});

test("evaluateLocal enforces a convergence floor and matching receipt", () => {
  const root = initRepo("convergence");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const greet = () => 'hi';\n",
    },
    "init",
  );
  writeAndCommit(root, { "src/index.ts": "export const greet = () => 'hello';\n" }, "tweak");

  const score = generateConvergence("update the greeting", { path: root, base: "HEAD~1" });
  const result = evaluateLocal(root, {
    base: "HEAD~1",
    request: "update the greeting",
    minConvergence: 0,
    receipt: score.receipt.id,
  });
  const convergence = result.checks.find((check) => check.name === "Convergence");
  assert.equal(convergence.status, "PASS");
  assert.match(convergence.details.join(" "), /Receipt handle: rcpt_/);

  const mismatch = evaluateLocal(root, {
    base: "HEAD~1",
    request: "update the greeting",
    receipt: "rcpt_000000000000",
  });
  assert.equal(mismatch.checks.find((check) => check.name === "Convergence").status, "FAIL");
});

test("evaluateLocal gates exactly base..head when a head ref is given", () => {
  const root = initRepo("head");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
      "src/index.ts": "export const greet = () => 'hi';\n",
      "src/other.ts": "export const other = 1;\n",
    },
    "init",
  );
  writeAndCommit(root, { "src/index.ts": "export const greet = () => 'hello';\n" }, "tweak");
  const headSha = git(root, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(root, "src/other.ts"), "export const other = 2;\n");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=not-committed\n");

  const result = evaluateLocal(root, { base: "HEAD~1", head: "HEAD", request: "update the greeting", minConvergence: 0 });
  assert.equal(result.scope, "commit");
  assert.equal(result.head, "HEAD");
  assert.deepEqual(result.changedFiles, ["src/index.ts"]);
  assert.equal(result.subject.kind, "git-commit");
  assert.equal(result.subject.headSha, headSha);
  assert.equal(result.subject.treeSha, git(root, "rev-parse", "HEAD^{tree}").trim());
  assert.equal(result.checks.find((check) => check.name === "Secret safety").status, "PASS", "an untracked .env is not part of base..head");
  const snapshot = result.checks.find((check) => check.name === "Commit snapshot");
  assert.equal(snapshot.status, "PASS");
  assert.match(snapshot.details.join(" "), new RegExp(`Head: ${headSha}`));
  assert.deepEqual(result.receipt.subject, result.subject);
  assert.match(formatPassMarkdown(result), new RegExp(`Head commit: \`${headSha}\``));

  assert.throws(() => evaluateLocal(root, { base: "HEAD~1", head: "HEAD", staged: true }), /either --head <ref> or --staged/);
  const missing = evaluateLocal(root, { base: "HEAD~1", head: "no-such-ref" });
  assert.equal(missing.checks.find((check) => check.name === "Commit snapshot").status, "FAIL");
  assert.deepEqual(missing.changedFiles, []);
});

test("a head-bound receipt verifies only when the gate measures the same head", () => {
  const root = initRepo("head-receipt");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const greet = () => 'hi';\n",
    },
    "init",
  );
  writeAndCommit(root, { "src/index.ts": "export const greet = () => 'hello';\n" }, "tweak");
  const score = generateConvergence("update the greeting", { path: root, base: "HEAD~1", head: "HEAD" });
  const receiptFile = path.join(root, "convergence.json");
  fs.writeFileSync(receiptFile, JSON.stringify(score));

  const verified = evaluateLocal(root, { base: "HEAD~1", head: "HEAD", request: "update the greeting", receipt: score.receipt.inputsHash });
  assert.equal(verified.checks.find((check) => check.name === "Convergence").status, "PASS");

  const fromFile = evaluateLocal(root, { base: "HEAD~1", head: "HEAD", request: "update the greeting", receipt: receiptFile });
  assert.equal(fromFile.checks.find((check) => check.name === "Convergence").status, "PASS");

  const workingTree = evaluateLocal(root, { base: "HEAD~1", request: "update the greeting", receipt: receiptFile });
  const mismatch = workingTree.checks.find((check) => check.name === "Convergence");
  assert.equal(mismatch.status, "FAIL");
  assert.match(mismatch.summary, new RegExp(`bound to head commit ${score.subject.headSha} but the gate measured the working tree`));
  assert.match(mismatch.summary, new RegExp(`--head ${score.subject.headSha}`));

  const staged = evaluateLocal(root, { base: "HEAD~1", staged: true, request: "update the greeting", receipt: receiptFile });
  assert.match(staged.checks.find((check) => check.name === "Convergence").summary, /measured a staged Git index tree/);

  const bareHash = evaluateLocal(root, { base: "HEAD~1", request: "update the greeting", receipt: score.receipt.inputsHash });
  assert.match(bareHash.checks.find((check) => check.name === "Convergence").summary, /does not match the recomputed receipt/);
});

test("evaluateLocal fails convergence enforcement when no task request is supplied", () => {
  const root = initRepo("convergence-no-task");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }), "src/index.ts": "export const hi = 1;\n" }, "init");
  writeAndCommit(root, { "src/index.ts": "export const hi = 2;\n" }, "tweak");

  const result = evaluateLocal(root, { base: "HEAD~1", minConvergence: 50 });
  const convergence = result.checks.find((check) => check.name === "Convergence");
  assert.equal(convergence.status, "FAIL");
  assert.match(convergence.summary, /task request is required/);
});

test("evaluateLocal FAILS when a .env file is in the diff", () => {
  const root = initRepo("secret");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  writeAndCommit(root, { ".env": "SECRET=xxx\n" }, "leak");

  const result = evaluateLocal(root, { base: "HEAD~1" });
  assert.equal(result.verdict, "FAIL");
  const secret = result.checks.find((c) => c.name === "Secret safety");
  assert.equal(secret.status, "FAIL");
  assert.ok(secret.details.includes(".env"));
});

test("evaluateLocal WARNs when risk-sensitive paths change (prisma schema)", () => {
  const root = initRepo("prisma");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  writeAndCommit(root, { "prisma/schema.prisma": "model User { id String @id }\n" }, "schema");

  const result = evaluateLocal(root, { base: "HEAD~1" });
  assert.equal(result.verdict, "WARN");
  const risk = result.checks.find((c) => c.name === "Risk review");
  assert.equal(risk.status, "WARN");
  assert.ok(risk.details.some((file) => file.includes("schema.prisma")));
});

test("evaluateLocal makes staged production configuration warnings actionable", () => {
  const root = initRepo("production-config");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/feature-flags/config/environments/production.json": JSON.stringify({ audienceStudio: false }),
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/feature-flags/config/environments/production.json"), JSON.stringify({ audienceStudio: true }));
  git(root, "add", "src/feature-flags/config/environments/production.json");

  const result = evaluateLocal(root, { base: "HEAD", staged: true });
  const risk = result.checks.find((check) => check.name === "Risk review");
  assert.equal(risk.status, "WARN");
  assert.ok(risk.details.some((detail) => detail.includes("explicitly approve the production configuration scope")));
  assert.ok(risk.details.some((detail) => detail.includes("git restore --staged -- 'src/feature-flags/config/environments/production.json'")));
});

// The high-risk profile used the unfiltered risk matcher, so it listed test
// files and documentation as "High-risk file changes" — contradicting the Risk
// review check in the same run, which correctly reported none.
test("high-risk policy does not count test or documentation files as high-risk changes", () => {
  const root = initRepo("highrisk-noise");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
      "tests/checkout.spec.ts": "export const a = 1;\n",
      "docs/auth-guide.md": "# auth\n",
    },
    "init",
  );
  writeAndCommit(root, { "tests/checkout.spec.ts": "export const a = 2;\n", "docs/auth-guide.md": "# auth v2\n" }, "touch test and doc");

  const result = evaluateLocal(root, { base: "HEAD~1", policy: "high-risk" });
  const policy = result.checks.find((c) => c.name === "Policy profile");
  const risk = result.checks.find((c) => c.name === "Risk review");
  // Risk review already filtered these; the policy profile must agree.
  assert.equal(risk.status, "PASS");
  assert.ok(
    !policy.details.some((line) => line.includes("High-risk file changes")),
    `policy should not claim high-risk file changes, got: ${policy.details.join(" | ")}`,
  );
  assert.ok(!policy.details.some((line) => line.includes("checkout.spec.ts") || line.includes("auth-guide.md")));
});

test("high-risk policy still names a genuine risk path", () => {
  const root = initRepo("highrisk-real");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) }, "init");
  writeAndCommit(root, { "src/auth/session.ts": "export const s = 1;\n" }, "auth");

  const result = evaluateLocal(root, { base: "HEAD~1", policy: "high-risk" });
  const policy = result.checks.find((c) => c.name === "Policy profile");
  assert.ok(policy.details.some((line) => line.includes("src/auth/session.ts")));
});

test("evaluateLocal escalates to FAIL under high-risk policy when prisma changes locally", () => {
  const root = initRepo("highrisk");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  writeAndCommit(root, { "prisma/schema.prisma": "model User { id String @id }\n" }, "schema");

  const result = evaluateLocal(root, { base: "HEAD~1", policy: "high-risk" });
  assert.equal(result.verdict, "FAIL");
  const policy = result.checks.find((c) => c.name === "Policy profile");
  assert.equal(policy.status, "FAIL");
  assert.ok(policy.details.some((line) => line.includes("GitHub PR mode")));
});

test("evaluateLocal does not warn Risk review for a test/doc-only change with a risky-looking name", () => {
  const root = initRepo("gate-test-doc");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  // A test file and a doc that both mention money-/auth-flavored words. These
  // are risk-adjacent for ranking but must not, on their own, trip the gate.
  writeAndCommit(
    root,
    {
      "tests/checkout.spec.ts": "import test from 'node:test';\ntest('checkout', () => {});\n",
      "docs/git-checkout-guide.md": "# Checkout guide\n\nHow to use git checkout.\n",
    },
    "tests and docs",
  );

  const result = evaluateLocal(root, { base: "HEAD~1" });
  const risk = result.checks.find((c) => c.name === "Risk review");
  assert.equal(risk.status, "PASS", `expected no risk warning for test/doc-only change, got ${risk.status}: ${JSON.stringify(risk.details)}`);
});

test("evaluateLocal does not FAIL Secret safety for an env-substring source or a secrets doc", () => {
  const root = initRepo("gate-secret-fp");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  writeAndCommit(
    root,
    {
      "src/config/dev.environments.ts": "export const environments = ['dev'];\n",
      "docs/secrets-management.md": "# Secrets management\n\nHow we store secrets.\n",
    },
    "env-substring source and secrets doc",
  );

  const result = evaluateLocal(root, { base: "HEAD~1" });
  const secret = result.checks.find((c) => c.name === "Secret safety");
  assert.equal(secret.status, "PASS", `expected secret check to pass, got ${secret.status}: ${JSON.stringify(secret.details)}`);
});

test("evaluateLocal markdown rendering includes the verdict and check names", () => {
  const root = initRepo("markdown");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/index.ts": "export const hi = 1;\n",
    },
    "init",
  );
  const data = evaluateLocal(root, { base: "HEAD" });
  const markdown = formatPassMarkdown(data);
  assert.match(markdown, /# solumbe pass/);
  assert.match(markdown, /Verdict:/);
  assert.match(markdown, /Secret safety/);
});

// Regression: "Secret safety" only ever matched file *names*, so a live
// credential pasted into ordinary source passed the gate. Credential literals
// are assembled at runtime — a live-format key committed to this repository
// would be caught by the gate these tests cover.
const FIXTURE_AWS_KEY = "AKIA" + "3F7QZL2MXN8RTVWB";

test("evaluateLocal blocks a credential value pasted into ordinary source", () => {
  const root = initRepo("secret-content");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "secret-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/config.js": "export const config = { region: 'eu-west-1' };\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/config.js"), `export const config = { key: "${FIXTURE_AWS_KEY}" };\n`);
  git(root, "add", ".");

  const data = evaluateLocal(root, { base: "HEAD", staged: true });
  const check = data.checks.find((entry) => entry.name === "Secret safety");
  assert.equal(check.status, "FAIL");
  assert.match(check.summary, /credential value found in changed content/);
  assert.ok(
    check.details.some((detail) => detail.startsWith("src/config.js:1")),
    `expected a file:line detail, got ${JSON.stringify(check.details)}`,
  );
  assert.ok(!JSON.stringify(data).includes(FIXTURE_AWS_KEY), "the receipt must never echo the credential");
  assert.equal(data.verdict, "FAIL");
});

test("evaluateLocal scans the staged tree, not the working tree, for credentials", () => {
  const root = initRepo("secret-staged-only");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "secret-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/config.js": "export const config = {};\n",
    },
    "init",
  );
  // Staged content is clean; the credential exists only in the unstaged working
  // tree, so a staged-scope gate must not report it.
  fs.writeFileSync(path.join(root, "src/config.js"), "export const config = { region: 'eu-west-1' };\n");
  git(root, "add", ".");
  fs.writeFileSync(path.join(root, "src/config.js"), `export const config = { key: "${FIXTURE_AWS_KEY}" };\n`);

  const staged = evaluateLocal(root, { base: "HEAD", staged: true });
  assert.equal(staged.checks.find((entry) => entry.name === "Secret safety").status, "PASS");

  // The working-tree gate sees the same file and must block it.
  const workingTree = evaluateLocal(root, { base: "HEAD" });
  assert.equal(workingTree.checks.find((entry) => entry.name === "Secret safety").status, "FAIL");
});

test("evaluateLocal still passes clean changes and reports the path half separately", () => {
  const root = initRepo("secret-clean");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "secret-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/config.js": "export const config = {};\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/config.js"), "export const config = { region: 'eu-west-1' };\n");
  git(root, "add", ".");

  const data = evaluateLocal(root, { base: "HEAD", staged: true });
  const check = data.checks.find((entry) => entry.name === "Secret safety");
  assert.equal(check.status, "PASS");
  assert.match(check.summary, /no credential values found/);
});

test("the batched blob reader scans every changed file, including after a deletion", () => {
  const root = initRepo("secret-batch");
  writeAndCommit(
    root,
    {
      "package.json": JSON.stringify({ name: "batch-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/a.js": "export const a = 1;\n",
      "src/b.js": "export const b = 2;\n",
      "src/c.js": "export const c = 3;\n",
      "src/gone.js": "export const gone = true;\n",
    },
    "init",
  );
  fs.writeFileSync(path.join(root, "src/a.js"), "export const a = 11;\n");
  fs.writeFileSync(path.join(root, "src/b.js"), "export const b = 22;\n");
  // The credential sits behind a deletion in the same change: a reader that
  // loses alignment after a missing object would never reach it.
  fs.rmSync(path.join(root, "src/gone.js"));
  fs.writeFileSync(path.join(root, "src/c.js"), `export const c = "${FIXTURE_AWS_KEY}";\n`);
  git(root, "add", "-A");

  const data = evaluateLocal(root, { base: "HEAD", staged: true });
  const check = data.checks.find((entry) => entry.name === "Secret safety");
  assert.equal(check.status, "FAIL");
  assert.ok(
    check.details.some((detail) => detail.startsWith("src/c.js:1")),
    `expected the credential behind the deletion to be found, got ${JSON.stringify(check.details)}`,
  );
});

test("secretCheck reports that content was unavailable instead of claiming a clean scan", () => {
  const files = ["src/config.js"];
  const unavailable = secretCheck(files, () => null);
  assert.equal(unavailable.status, "PASS");
  assert.match(unavailable.summary, /not available to scan/);

  const scanned = secretCheck(files, () => "export const config = {};\n");
  assert.equal(scanned.status, "PASS");
  assert.match(scanned.summary, /no credential values found/);
});

// Regression (dogfood, bashbop-api): removing DOJAH_* keys from `.env.example`
// hard-failed the gate as a secret file. A template passes on its path; a
// real credential pasted into it still fails on content.
test("secretCheck passes an env template and still fails a credential inside one", () => {
  const files = [".env.example"];
  const empty = secretCheck(files, () => "# Paystack BVN check\nPAYSTACK_BVN_ENFORCEMENT_DATE=\n");
  assert.equal(empty.status, "PASS");

  const leaked = secretCheck(files, () => `AWS_ACCESS_KEY_ID=${FIXTURE_AWS_KEY}\n`);
  assert.equal(leaked.status, "FAIL");
  assert.match(leaked.summary, /credential value/);
});

// Regression (dogfood, bashbop-api): a head-bound gate told the maintainer to
// `git restore --staged` files that were committed, not staged.
test("evaluateLocal with a head gives review advice, not unstaging commands", () => {
  const root = initRepo("head-risk-advice");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }), "prisma/schema.prisma": "model A { id Int @id }\n" }, "init");
  writeAndCommit(root, { "prisma/schema.prisma": "model A { id Int @id\n name String? }\n" }, "add name");

  const result = evaluateLocal(root, { base: "HEAD~1", head: "HEAD" });
  const risk = result.checks.find((check) => check.name === "Risk review");
  assert.equal(risk.status, "WARN");
  assert.ok(!risk.details.some((detail) => detail.includes("git restore --staged")), JSON.stringify(risk.details));
  assert.ok(risk.details.some((detail) => detail.includes("record explicit review")));
});

// Regression (dogfood, bashbop-api #543): the migration that reset every
// verified organiser to INCOMPLETE passed the gate as an ordinary schema file.
test("evaluateLocal warns when a migration rewrites or drops existing data", () => {
  const root = initRepo("migration-safety");
  writeAndCommit(root, { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) }, "init");
  writeAndCommit(
    root,
    {
      "prisma/migrations/20261004_add/migration.sql": 'ALTER TABLE "Profile" ADD COLUMN "paystackKycName" TEXT;\n',
    },
    "additive",
  );
  const additive = evaluateLocal(root, { base: "HEAD~1", head: "HEAD" }).checks.find((check) => check.name === "Migration safety");
  assert.equal(additive?.status, "PASS");

  writeAndCommit(
    root,
    {
      "prisma/migrations/20261004_reset/migration.sql": [
        "-- Everyone starts again; UPDATE in a comment is not a statement",
        'UPDATE "Profile" SET "paystackKycStatus" = \'INCOMPLETE\' WHERE "paystackKycStatus" IS DISTINCT FROM \'INCOMPLETE\';',
        'ALTER TABLE "Profile" DROP COLUMN "paystackIdNumber",',
        'DROP COLUMN "paystackSelfieUrl";',
        'DELETE FROM "Session";',
        "",
      ].join("\n"),
    },
    "reset",
  );
  const risky = evaluateLocal(root, { base: "HEAD~1", head: "HEAD" }).checks.find((check) => check.name === "Migration safety");
  assert.equal(risky?.status, "WARN");
  const details = risky.details.join("\n");
  assert.match(details, /rewrites existing rows in "Profile"/);
  assert.match(details, /drops columns of "Profile"/);
  assert.match(details, /deletes rows from "Session" \(every row: no WHERE\)/);
  assert.equal(risky.details.length, 3, details);
});
