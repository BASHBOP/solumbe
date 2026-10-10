import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createLinearRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-attest-reconcile-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "audit-pilot"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "reconcile-attestations.sh"), path.join(root, "scripts", "reconcile-attestations.sh"));

  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Solumbe Test"]);
  git(root, ["config", "user.email", "solumbe@example.test"]);

  const commits = [];
  for (const name of ["one", "two", "three"]) {
    fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", name]);
    commits.push(git(root, ["rev-parse", "HEAD"]));
  }
  return { root, commits };
}

// A repository whose first commit is 1.0.0 and whose head carries `version`,
// with a CHANGELOG section for each of `changelog` and `tags` on the first.
function createReleaseRepo({ version, changelog, tags }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-tag-release-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "scripts", "tag-release.sh"), path.join(root, "scripts", "tag-release.sh"));

  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Solumbe Test"]);
  git(root, ["config", "user.email", "solumbe@example.test"]);

  let commits = 0;
  const commit = (packageVersion, sections) => {
    // Every commit changes something, as a main push that is not a release does.
    fs.writeFileSync(path.join(root, "change.txt"), `${++commits}\n`);
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: packageVersion })}\n`);
    const notes = sections.map((section) => `## [${section}] - 2026-09-26\n\n- A change.\n`);
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), ["# Changelog\n", "## [Unreleased]\n", ...notes].join("\n"));
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", `version ${packageVersion}`]);
    return git(root, ["rev-parse", "HEAD"]);
  };

  const base = commit("1.0.0", ["1.0.0"]);
  for (const tag of tags) git(root, ["tag", tag, base]);
  const head = commit(version, changelog);
  return { root, base, head };
}

function tagRelease(root, env = {}) {
  return spawnSync("bash", [path.join(root, "scripts", "tag-release.sh")], {
    cwd: root,
    encoding: "utf8",
    // Never inherit a CI job's GITHUB_OUTPUT: the script would write to it.
    env: { ...process.env, SOLUMBE_TAG_SHA: "", SOLUMBE_TAG_DRY_RUN: "1", GITHUB_OUTPUT: "", ...env },
  });
}

test("CI validates PRs once and reserves push validation for main", () => {
  const workflow = read(".github/workflows/solumbe-ci.yml");
  assert.match(workflow, /pull_request:\n\s+types:/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /attest-main:/);
});

test("post-merge workflow reconciles successful CI into a durable audit branch", () => {
  // The repo's own workflow only resolves which commit merged; the attestation
  // is the reusable workflow, which any repository can call the same way.
  const caller = read(".github/workflows/post-merge-attest.yml");
  assert.match(caller, /workflow_run:/);
  assert.match(caller, /workflows: \["solumbe CI"\]/);
  assert.match(caller, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(caller, /uses: \.\/\.github\/workflows\/attest\.yml/);
  // solumbe attests its own commit with the engine that commit ships.
  assert.match(caller, /solumbe_ref: \$\{\{ needs\.resolve\.outputs\.target_sha \}\}/);

  const reusable = read(".github/workflows/attest.yml");
  assert.match(reusable, /^on:\s+workflow_call:/m);
  assert.match(reusable, /target_sha:[\s\S]*?required: true/);
  assert.match(reusable, /scripts\/reconcile-attestations\.sh/);
  assert.match(reusable, /ledger_branch:[\s\S]*?default: audit-ledger/);
  assert.match(reusable, /HEAD:refs\/heads\/\$LEDGER_BRANCH/);
  // The tool is checked out beside the repository under attestation and kept
  // out of its tree, so the review never sees solumbe's own files as a change.
  assert.match(reusable, /SOLUMBE_REPO: \$\{\{ github\.workspace \}\}/);
  assert.match(reusable, /SOLUMBE_BIN: node \$\{\{ github\.workspace \}\}\/\$\{\{ env\.SOLUMBE_TOOL_DIR \}\}\/src\/cli\.js/);
  assert.match(reusable, /echo "\$SOLUMBE_TOOL_DIR\/" >> \.git\/info\/exclude/);
  // The record is signed with a key the caller passes, never one in the tree,
  // and published on the commit it attests, which needs the statuses scope.
  assert.match(reusable, /secrets:\s+attest_key:[\s\S]*?required: false/);
  assert.match(reusable, /SOLUMBE_ATTEST_KEY_PEM: \$\{\{ secrets\.attest_key \}\}/);
  assert.match(reusable, /statuses: write/);
  assert.match(reusable, /attest \. --status --ledger "\$LEDGER_PATH" --merge "\$TARGET_SHA"/);
  assert.match(caller, /attest_key: \$\{\{ secrets\.SOLUMBE_ATTEST_KEY \}\}/);
  assert.match(caller, /statuses: write/);
});

test("the attestation target is passed in a variable the workflow can actually set", () => {
  const caller = read(".github/workflows/post-merge-attest.yml");
  const reusable = read(".github/workflows/attest.yml");
  // GitHub ignores a step's attempt to set a GITHUB_* variable.
  assert.doesNotMatch(caller, /^\s+GITHUB_SHA:/m);
  assert.doesNotMatch(reusable, /^\s+GITHUB_SHA:/m);
  assert.match(caller, /target_sha: \$\{\{ needs\.resolve\.outputs\.target_sha \}\}/);
  assert.match(reusable, /SOLUMBE_TARGET_SHA: \$\{\{ inputs\.target_sha \}\}/);
});

test("the repository is solo-maintained, so its gate and attestation default to solo governance", () => {
  // A solo maintainer has no second reviewer: under team governance every merge
  // records a FAIL for a missing approval nobody can give. An explicit
  // --governance flag still overrides this default.
  assert.equal(JSON.parse(read(".solumberc.json")).governance, "solo");
});

test("only a manual run can reset the audit ledger, and the archived chain is kept", () => {
  const caller = read(".github/workflows/post-merge-attest.yml");
  const reusable = read(".github/workflows/attest.yml");
  assert.match(caller, /reset_ledger:[\s\S]*?type: boolean\s+default: false/);
  assert.match(reusable, /reset_ledger:[\s\S]*?type: boolean\s+default: false/);
  // The caller decides, once, and only a person dispatching the run can say yes.
  assert.equal((caller.match(/reset_ledger: \$\{\{/g) ?? []).length, 1);
  assert.match(caller, /reset_ledger: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.reset_ledger \|\| false \}\}/);
  // The reusable workflow sets the script variable in one place, from that input.
  assert.equal((reusable.match(/SOLUMBE_ATTEST_RESET_LEDGER/g) ?? []).length, 1);
  assert.match(reusable, /SOLUMBE_ATTEST_RESET_LEDGER: \$\{\{ inputs\.reset_ledger && '1' \|\| '0' \}\}/);
  assert.doesNotMatch(caller, /SOLUMBE_ATTEST_RESET_LEDGER/);
  // The superseded chain reaches the ledger branch and the uploaded evidence.
  assert.match(reusable, /for archive in "\$LEDGER_DIR"\/ledger-orphaned-\*\.jsonl; do/);
  assert.match(reusable, /path: \|[\s\S]*ledger-orphaned-\*\.jsonl/);
});

test("workflow dependencies use setup-node v7 and TypeScript majors require migration", () => {
  const workflowFiles = fs.readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"));
  const workflows = workflowFiles.map((name) => fs.readFileSync(path.join(workflowsDir, name), "utf8")).join("\n");
  assert.doesNotMatch(workflows, /actions\/setup-node@v6/);
  assert.match(workflows, /actions\/setup-node@v7/);

  const dependabot = read(".github/dependabot.yml");
  assert.match(dependabot, /dependency-name: typescript/);
  assert.match(dependabot, /version-update:semver-major/);
});

test("release publishing uses GitHub OIDC without a stored npm token", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /- name: Publish\n\s+if: steps\.npm\.outputs\.published != 'true'\n\s+run: npm publish/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("release skips npm publish for a version npm already has, so the later jobs still run", () => {
  const workflow = read(".github/workflows/release.yml");
  // Only the publish step is skipped: the GitHub Release and MCP Registry jobs
  // need it to succeed, and a skipped step still leaves the job green.
  assert.match(workflow, /id: npm\n\s+run: \|[\s\S]*?npm view "\$NAME@\$VERSION" version[\s\S]*?published=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /github-release:[\s\S]*?needs: publish/);
  assert.match(workflow, /publish-mcp:[\s\S]*?needs: publish/);
});

test("the pre-rename MCP listing is retired only by hand, only once the new listing is live", () => {
  const workflow = read(".github/workflows/retire-legacy-listing.yml");
  assert.match(workflow, /^on:\n\s+workflow_dispatch:\n\n/m, "manual trigger only");
  const guard = workflow.indexOf("Refuse unless the new listing is live");
  const deprecate = workflow.indexOf("mcp-publisher status");
  assert.ok(guard > 0 && guard < deprecate, "the live-listing guard runs before the status change");
  assert.match(workflow, /status --status deprecated --message "[^"]+" --all-versions --yes io\.github\.BASHBOP\/\w+ /, "flags before the server name");
});

test("MCP Registry identity matches Bashbop's granted OIDC namespace", () => {
  const manifest = JSON.parse(read("package.json"));
  const server = JSON.parse(read("server.json"));
  assert.equal(manifest.mcpName, "io.github.BASHBOP/solumbe");
  assert.equal(server.name, manifest.mcpName);
});

test("reconciliation dry-run lists missing first-parent commits oldest-first", () => {
  const { root, commits } = createLinearRepo();

  fs.writeFileSync(path.join(root, "audit-pilot", "ledger.jsonl"), `${JSON.stringify({ mergeSha: commits[0] })}\n`);
  const result = spawnSync("bash", [path.join(root, "scripts", "reconcile-attestations.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: commits[2],
      SOLUMBE_TARGET_SHA: "",
      SOLUMBE_ATTEST_DRY_RUN: "1",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(result.stdout.trim().split("\n"), [commits[1], commits[2]]);
});

test("reconciliation rejects a cryptographically valid ledger with a first-parent coverage gap", () => {
  const { root, commits } = createLinearRepo();
  fs.writeFileSync(
    path.join(root, "audit-pilot", "ledger.jsonl"),
    `${JSON.stringify({ mergeSha: commits[0] })}\n${JSON.stringify({ mergeSha: commits[2] })}\n`,
  );

  const result = spawnSync("bash", [path.join(root, "scripts", "reconcile-attestations.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: commits[2],
      SOLUMBE_TARGET_SHA: "",
      SOLUMBE_ATTEST_DRY_RUN: "1",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /first-parent coverage gap/);
});

test("reconciliation refuses a target on another first-parent line, such as a develop merge commit", () => {
  const { root, commits } = createLinearRepo();
  // develop branches off the first commit and later merges main in, so main's
  // tip is an ancestor of its merge commit, but only through the second parent.
  git(root, ["switch", "-q", "-c", "develop", commits[0]]);
  fs.writeFileSync(path.join(root, "develop.txt"), "develop\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "develop work"]);
  git(root, ["merge", "-q", "--no-ff", "-m", "merge main into develop", commits[2]]);
  const developMerge = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "audit-pilot", "ledger.jsonl"), `${commits.map((sha) => JSON.stringify({ mergeSha: sha })).join("\n")}\n`);

  const result = spawnSync("bash", [path.join(root, "scripts", "reconcile-attestations.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_SHA: developMerge,
      SOLUMBE_TARGET_SHA: "",
      SOLUMBE_ATTEST_DRY_RUN: "1",
    },
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /does not continue the ledger/);
  assert.equal(result.stdout.trim(), "", "nothing is listed for attestation");
});

test("only a PR merged into main resolves to a commit for the main ledger", () => {
  const workflow = read(".github/workflows/post-merge-attest.yml");
  assert.match(workflow, /BASE_REF="\$\(gh api "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{PR_NUMBER\}" --jq '\.base\.ref'\)"/);
  assert.match(workflow, /if \[ "\$BASE_REF" = "main" \]; then\n\s+TARGET_SHA="\$\(gh api [^\n]+merge_commit_sha'\)"\n\s+else/);
});

test("a version bump that reaches main is tagged once CI passes on it, and the tag starts Release", () => {
  const workflow = read(".github/workflows/tag-release.yml");
  assert.match(workflow, /workflow_run:\n\s+workflows: \["solumbe CI"\]\n\s+types: \[completed\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
  // The script needs every tag to tell a new version from a tagged one.
  assert.match(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\n\s+fetch-depth: 0/);
  assert.match(workflow, /SOLUMBE_TAG_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(workflow, /bash scripts\/tag-release\.sh/);
  // A tag pushed with GITHUB_TOKEN starts no workflow, so Release is dispatched on it.
  assert.match(workflow, /if: steps\.tag\.outputs\.tag != ''/);
  assert.match(workflow, /gh workflow run release\.yml --ref "\$TAG"/);

  const release = read(".github/workflows/release.yml");
  assert.match(release, /^ {2}workflow_dispatch:/m);
  // Dispatched on a branch, Release refuses rather than publish from it.
  assert.match(release, /if \[ "\$GITHUB_REF_TYPE" != "tag" \]; then/);
});

test("tag-release tags a new version with release notes on the commit that carries it", () => {
  const { root, head } = createReleaseRepo({ version: "1.1.0", changelog: ["1.1.0", "1.0.0"], tags: ["v1.0.0"] });
  const result = tagRelease(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `would tag ${head} as v1.1.0`);
});

test("tag-release tags nothing when the version is already tagged", () => {
  const { root, base } = createReleaseRepo({ version: "1.0.0", changelog: ["1.0.0"], tags: ["v1.0.0"] });
  const result = tagRelease(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `v1.0.0 is already tagged at ${base}; nothing to release.`);
});

test("tag-release orders versions numerically and ignores pre-release tags", () => {
  const numeric = createReleaseRepo({ version: "1.10.0", changelog: ["1.10.0"], tags: ["v1.9.0"] });
  assert.equal(tagRelease(numeric.root).stdout.trim(), `would tag ${numeric.head} as v1.10.0`);

  const afterCandidate = createReleaseRepo({ version: "1.1.0", changelog: ["1.1.0"], tags: ["v1.0.0", "v1.1.0-rc.1"] });
  assert.equal(tagRelease(afterCandidate.root).stdout.trim(), `would tag ${afterCandidate.head} as v1.1.0`);
});

test("tag-release refuses a version that is not newer than the latest tag", () => {
  const { root } = createReleaseRepo({ version: "1.1.0", changelog: ["1.1.0"], tags: ["v1.0.0", "v1.2.0"] });
  const result = tagRelease(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /says 1\.1\.0, which is not newer than v1\.2\.0; refusing to tag it/);
  assert.equal(result.stdout, "");
});

test("tag-release refuses a version CHANGELOG.md has no section for", () => {
  const { root } = createReleaseRepo({ version: "1.1.0", changelog: ["1.0.0"], tags: ["v1.0.0"] });
  const result = tagRelease(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CHANGELOG\.md at [0-9a-f]{40} has no \[1\.1\.0\] section/);
  assert.equal(result.stdout, "");
});

test("tag-release pushes the tag to origin and hands it to the step that starts Release", () => {
  const { root, head } = createReleaseRepo({ version: "1.1.0", changelog: ["1.1.0"], tags: ["v1.0.0"] });
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-tag-release-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-tag-release-output-")), "github-output");

  const result = tagRelease(root, { SOLUMBE_TAG_SHA: head, SOLUMBE_TAG_DRY_RUN: "0", GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, ["rev-parse", "v1.1.0^{commit}"]), head);
  assert.equal(git(remote, ["cat-file", "-t", "v1.1.0"]), "tag");
  assert.equal(fs.readFileSync(output, "utf8"), "tag=v1.1.0\n");
});
