import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WORKFLOW_ACTION_VERSIONS, initProject } from "../src/lib/init.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookGateLine = /solumbe gate \. --staged --policy standard --out \.solumbe\/gate\.md/;

test("initProject scaffolds solumbe files without overwriting by default", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-"));
  const result = initProject(fixture, { toolRepo: "example/solumbe", toolRef: "stable" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.created.sort(), [".solumbe/README.md", ".githooks/pre-commit", ".github/workflows/solumbe-ci.yml", ".gitignore"].sort());

  const generatedWorkflowPath = path.join(fixture, ".github", "workflows", "solumbe-ci.yml");
  const workflow = fs.readFileSync(generatedWorkflowPath, "utf8");
  assert.match(workflow, /repository: example\/solumbe/);
  assert.match(workflow, /ref: stable/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /Checkout PR head/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /Checkout pushed commit/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Install solumbe dependencies/);
  assert.match(workflow, /working-directory: \.solumbe\/tool/);
  assert.match(workflow, /secrets\.SOLUMBE_REPO_TOKEN/);
  assert.match(workflow, /git fetch origin "\+\$\{\{ github\.base_ref \}\}:refs\/remotes\/origin\/\$\{\{ github\.base_ref \}\}"/);
  assert.match(workflow, /Generate commit review context/);
  assert.match(workflow, /node \.solumbe\/tool\/src\/cli\.js pr \./);

  fs.writeFileSync(generatedWorkflowPath, "custom workflow\n");
  const skipped = initProject(fixture);
  assert.ok(skipped.skipped.includes(".github/workflows/solumbe-ci.yml"));
  assert.equal(fs.readFileSync(generatedWorkflowPath, "utf8"), "custom workflow\n");
});

test("initProject adds .solumbe/ to .gitignore (creating it when absent)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-gitignore-"));
  const result = initProject(fixture, { noWorkflow: true });

  const gitignorePath = path.join(fixture, ".gitignore");
  assert.ok(fs.existsSync(gitignorePath), ".gitignore must be created");
  const contents = fs.readFileSync(gitignorePath, "utf8");
  assert.match(contents, /^\.solumbe\/$/m);
  assert.ok(result.created.includes(".gitignore"));
});

test("initProject appends .solumbe/ to an existing .gitignore without clobbering it", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-gitignore-"));
  const gitignorePath = path.join(fixture, ".gitignore");
  fs.writeFileSync(gitignorePath, "node_modules\ndist\n");

  const result = initProject(fixture, { noWorkflow: true });
  const contents = fs.readFileSync(gitignorePath, "utf8");
  assert.match(contents, /node_modules/);
  assert.match(contents, /dist/);
  assert.match(contents, /^\.solumbe\/$/m);
  assert.ok(result.updated.includes(".gitignore"));
});

test("initProject is idempotent about .gitignore and respects covering patterns", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-gitignore-"));
  const gitignorePath = path.join(fixture, ".gitignore");

  initProject(fixture, { noWorkflow: true });
  const afterFirst = fs.readFileSync(gitignorePath, "utf8");
  const second = initProject(fixture, { noWorkflow: true });
  const afterSecond = fs.readFileSync(gitignorePath, "utf8");

  assert.equal(afterFirst, afterSecond, "second run must not duplicate the entry");
  assert.ok(second.skipped.includes(".gitignore"));

  // A bare ".solumbe" (no trailing slash) already covers the directory.
  const covered = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-gitignore-"));
  fs.writeFileSync(path.join(covered, ".gitignore"), ".solumbe\n");
  const result = initProject(covered, { noWorkflow: true });
  assert.equal(fs.readFileSync(path.join(covered, ".gitignore"), "utf8"), ".solumbe\n");
  assert.ok(result.skipped.includes(".gitignore"));
});

test("initProject can force overwrite and skip workflow", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-"));
  initProject(fixture);

  const forced = initProject(fixture, { force: true });
  assert.ok(forced.updated.includes(".solumbe/README.md"));
  assert.ok(forced.updated.includes(".github/workflows/solumbe-ci.yml"));

  const noWorkflow = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-"));
  const result = initProject(noWorkflow, { noWorkflow: true });
  assert.ok(result.created.includes(".solumbe/README.md"));
  assert.equal(fs.existsSync(path.join(noWorkflow, ".github", "workflows", "solumbe-ci.yml")), false);
});

test("initProject injects a harness-driven quality job and pre-commit hook from package scripts", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-gates-"));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "sample", scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "node --test" } }, null, 2),
  );

  const result = initProject(fixture);

  assert.equal(result.gatesApplied, true);
  assert.equal(result.gatesStatus, "applied");
  assert.equal(result.precommitApplied, true);
  assert.equal(result.precommitStatus, "applied");
  assert.ok(result.created.includes(".githooks/pre-commit"));

  const workflow = fs.readFileSync(path.join(fixture, ".github", "workflows", "solumbe-ci.yml"), "utf8");
  const qualitySection = workflow.split("  review:")[0];
  assert.match(workflow, /^ {2}quality:$/m);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(qualitySection, /install Node dependencies\n {8}run: npm install/);
  assert.doesNotMatch(qualitySection, /install Node dependencies\n {8}run: npm ci/);
  assert.match(workflow, /run: npm run lint/);
  assert.match(workflow, /run: npm run typecheck/);
  assert.match(workflow, /run: npm test/);
  // the review job must survive alongside the new quality job
  assert.match(workflow, /name: Generate PR review context/);

  const hookFile = path.join(fixture, ".githooks", "pre-commit");
  const hook = fs.readFileSync(hookFile, "utf8");
  assert.match(hook, /^#!\/bin\/sh/);
  assert.match(hook, /npm run lint/);
  assert.match(hook, /npm run typecheck/);
  assert.match(hook, hookGateLine);
  // slow gates (test/build/audit) never run in the pre-commit hook
  assert.doesNotMatch(hook, /npm test/);
  // the hook must be executable
  assert.equal(fs.statSync(hookFile).mode & 0o111, 0o111);
});

test("initProject omits gates and pre-commit when disabled", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-nogates-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint ." } }, null, 2));

  const result = initProject(fixture, { gates: false, precommit: false });

  assert.equal(result.gatesApplied, false);
  assert.equal(result.gatesStatus, "disabled");
  assert.equal(result.precommitApplied, false);
  assert.equal(result.precommitStatus, "disabled");
  assert.equal(fs.existsSync(path.join(fixture, ".githooks", "pre-commit")), false);

  const workflow = fs.readFileSync(path.join(fixture, ".github", "workflows", "solumbe-ci.yml"), "utf8");
  assert.doesNotMatch(workflow, /^ {2}quality:$/m);
  assert.match(workflow, /name: Generate PR review context/);
});

test("initProject installs the staged safety hook even when no static scripts are detected", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-bare-"));
  const result = initProject(fixture);

  assert.equal(result.gatesApplied, false);
  assert.equal(result.gatesStatus, "none");
  assert.equal(result.precommitApplied, true);
  assert.equal(result.precommitStatus, "applied");
  const hook = fs.readFileSync(path.join(fixture, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, hookGateLine);
});

test("initProject uses npm ci when package-lock.json is present", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-lock-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint .", test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(fixture, "package-lock.json"), JSON.stringify({ name: "sample", lockfileVersion: 3, packages: {} }, null, 2));

  initProject(fixture);

  const workflow = fs.readFileSync(path.join(fixture, ".github", "workflows", "solumbe-ci.yml"), "utf8");
  const qualitySection = workflow.split("  review:")[0];
  assert.match(qualitySection, /install Node dependencies\n {8}run: npm ci/);
});

test("initProject excludes non-static script names from the pre-commit hook", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-precommit-filter-"));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "sample", scripts: { lint: "eslint .", prototype: "node prototype.js", test: "node --test" } }, null, 2),
  );

  const result = initProject(fixture);

  assert.equal(result.precommitApplied, true);
  const hook = fs.readFileSync(path.join(fixture, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, hookGateLine);
  assert.match(hook, /npm run lint/);
  assert.doesNotMatch(hook, /prototype/);
  assert.doesNotMatch(hook, /npm test/);
});

test("initProject runs a type check named with a tsc segment in the quality job and the pre-commit hook", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-tsc-"));
  fs.writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "sample",
        scripts: {
          lint: "eslint .",
          "tsc:check": "tsc --noEmit",
          "tsc:watch": "tsc --noEmit --watch",
          "tsconfig:sync": "node scripts/sync-tsconfig.js",
          test: "node --test",
        },
      },
      null,
      2,
    ),
  );

  initProject(fixture);

  const workflow = fs.readFileSync(path.join(fixture, ".github", "workflows", "solumbe-ci.yml"), "utf8");
  assert.match(workflow, /type contract checks\n {8}run: npm run tsc:check/);
  assert.doesNotMatch(workflow, /tsc:watch|tsconfig:sync/);

  const hook = fs.readFileSync(path.join(fixture, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, hookGateLine);
  assert.match(hook, /npm run lint/);
  assert.match(hook, /npm run tsc:check/);
  assert.doesNotMatch(hook, /tsc:watch|tsconfig:sync/);
  assert.doesNotMatch(hook, /npm test/);
});

test("initProject sets core.hooksPath only when requested, inside a git repo", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-hooks-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint ." } }, null, 2));
  execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });

  const result = initProject(fixture, { hooksPath: true });

  assert.equal(result.precommitApplied, true);
  assert.equal(result.hooksConfigured, true);
  const configured = execFileSync("git", ["config", "core.hooksPath"], { cwd: fixture }).toString().trim();
  assert.equal(configured, ".githooks");
});

test("initProject skips hooks path when no pre-commit hook was scaffolded", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-hooks-skip-"));
  execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });

  const result = initProject(fixture, { hooksPath: true, gates: false, precommit: false });

  assert.equal(result.hooksPathRequested, true);
  assert.equal(result.hooksConfigured, false);
  assert.ok(result.nextSteps.some((step) => step.includes("core.hooksPath was not set")));
});

test("the pre-commit hook gates under --policy standard so a strict repository policy cannot fail every local commit", () => {
  // A repository that sets `policy: company` in .solumberc.json means it for
  // merge time: the company policy requires an approving review, which a
  // commit that has not been pushed yet can never have. Without the flag the
  // hook would inherit that policy and refuse every local commit.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-policy-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint ." } }, null, 2));
  fs.writeFileSync(path.join(fixture, ".solumberc.json"), JSON.stringify({ policy: "company", governance: "team" }, null, 2));
  fs.writeFileSync(path.join(fixture, "index.js"), "export const value = 1;\n");
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", ["-c", "user.name=solumbe", "-c", "user.email=solumbe@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: fixture,
      stdio: "ignore",
    });
  git(["init", "--quiet"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "baseline"]);
  fs.writeFileSync(path.join(fixture, "index.js"), "export const value = 2;\n");
  git(["add", "--all"]);

  const hook = fs.readFileSync(path.join(initProject(fixture).root, ".githooks", "pre-commit"), "utf8");
  assert.match(hook, hookGateLine);

  // The exact gate the hook runs, minus --out, in JSON so the verdict can be read.
  const gate = (/** @type {string[]} */ extra) => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "src", "cli.js"), "gate", ".", "--staged", ...extra, "--json"], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, SOLUMBE_TELEMETRY: "0", SOLUMBE_TELEMETRY_SHARE: "0" },
    });
    return { exitCode: result.status, data: JSON.parse(result.stdout) };
  };
  const inherited = gate([]);
  assert.equal(inherited.data.policy, "company");
  assert.equal(inherited.data.verdict, "FAIL", "the repository's own policy fails the staged gate");
  assert.equal(inherited.exitCode, 1);

  const hooked = gate(["--policy", "standard"]);
  assert.equal(hooked.data.policy, "standard");
  assert.notEqual(hooked.data.verdict, "FAIL", "the hook's gate must not fail on review state alone");
  assert.equal(hooked.exitCode, 0);
});

test("the pre-commit hook says FAIL and names the blocking check when it blocks a commit", () => {
  // Printing only the report path read as a pass while the commit was refused.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-hook-fail-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint ." } }, null, 2));
  fs.writeFileSync(path.join(fixture, "index.js"), "export const value = 1;\n");
  const git = (/** @type {string[]} */ args) =>
    execFileSync("git", ["-c", "user.name=solumbe", "-c", "user.email=solumbe@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: fixture,
      stdio: "ignore",
    });
  git(["init", "--quiet"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "baseline"]);
  initProject(fixture);
  fs.writeFileSync(path.join(fixture, ".env"), "API_TOKEN=local\n");
  git(["add", ".env"]);

  // The hook calls `solumbe` from PATH; point it at this checkout.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-hook-bin-"));
  fs.writeFileSync(path.join(bin, "solumbe"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, "src", "cli.js")}" "$@"\n`, { mode: 0o755 });
  const hook = spawnSync("sh", [path.join(".githooks", "pre-commit")], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SOLUMBE_TELEMETRY: "0", SOLUMBE_TELEMETRY_SHARE: "0" },
  });

  assert.equal(hook.status, 1, hook.stdout + hook.stderr);
  assert.match(hook.stdout, /Gate verdict: FAIL — blocked by Secret safety: /);
  assert.match(hook.stdout, /Gate report written: .*\.solumbe\/gate\.md/);
  assert.match(hook.stderr, /solumbe pre-commit: FAIL — commit blocked by the staged safety gate; full report in \.solumbe\/gate\.md/);
  assert.doesNotMatch(hook.stdout, /running static checks/, "a blocked commit stops before the static checks");
  assert.match(fs.readFileSync(path.join(fixture, ".solumbe", "gate.md"), "utf8"), /Verdict: \*\*FAIL\*\*/);
});

test("the generated workflow pins the same action majors as this repository's own CI", () => {
  // The template is shipped in the package and cannot read solumbe-ci.yml at
  // run time, so the majors are constants. This test is what keeps them from
  // drifting behind the workflow the project itself runs on.
  const usesOf = (/** @type {string} */ yaml) => {
    /** @type {Map<string, string>} */
    const majors = new Map();
    for (const match of yaml.matchAll(/^\s*-?\s*uses:\s*([^@\s]+)@(v\d+)\s*$/gm)) {
      const [, action, major] = match;
      const seen = majors.get(action);
      assert.ok(seen === undefined || seen === major, `${action} is pinned to both ${seen} and ${major}`);
      majors.set(action, major);
    }
    return majors;
  };

  const own = usesOf(fs.readFileSync(path.join(repoRoot, ".github", "workflows", "solumbe-ci.yml"), "utf8"));
  for (const [action, major] of Object.entries(WORKFLOW_ACTION_VERSIONS)) {
    assert.equal(own.get(action), major, `${action}: template pins ${major}, solumbe-ci.yml uses ${own.get(action) ?? "nothing"}`);
  }

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-init-majors-"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "sample", scripts: { lint: "eslint .", test: "node --test" } }, null, 2));
  initProject(fixture);
  const generated = usesOf(fs.readFileSync(path.join(fixture, ".github", "workflows", "solumbe-ci.yml"), "utf8"));
  assert.ok(generated.size >= 3, "the generated workflow should use checkout, setup-node and upload-artifact");
  for (const [action, major] of generated) {
    if (!own.has(action)) continue;
    assert.equal(major, own.get(action), `${action}: generated workflow pins ${major}, solumbe-ci.yml uses ${own.get(action)}`);
  }
});
