import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryFromSubject, runHistoryEval } from "../src/lib/history-eval.js";

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function git(cwd, args, env = {}) {
  const result = spawnSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * @param {string} root
 * @param {Record<string, string>} files
 */
function write(root, files) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
}

function historyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-history-test-"));
  git(root, ["init", "-q", "-b", "main"]);
  write(root, {
    "package.json": JSON.stringify({ name: "shop", scripts: { test: "node --test" } }),
    "src/payment/refund.service.ts": "export function refundPayment(id: string) {\n  return id;\n}\n",
    "src/users/profile.service.ts": "export function updateProfile(name: string) {\n  return name;\n}\n",
    "tests/refund.service.test.ts": "import { refundPayment } from '../src/payment/refund.service';\n",
    "CHANGELOG.md": "# Changelog\n",
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "initial"]);

  write(root, {
    "src/payment/refund.service.ts": "export function refundPayment(id: string) {\n  return `refund:${id}`;\n}\n",
    "tests/refund.service.test.ts": "import { refundPayment } from '../src/payment/refund.service';\n// twice\n",
    "src/payment/refund.guard.ts": "export const guard = true;\n",
    "CHANGELOG.md": "# Changelog\n\n- refunds\n",
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fix(payment): stop refunding a payment twice (#12)"]);

  write(root, { "package.json": JSON.stringify({ name: "shop", version: "1.0.1", scripts: { test: "node --test" } }) });
  git(root, ["commit", "-q", "-am", "chore(release): v1.0.1"]);

  write(root, { "src/users/profile.service.ts": "export function updateProfile(name: string) {\n  return name.trim();\n}\n" });
  git(root, ["commit", "-q", "-am", "bump profile"], { GIT_AUTHOR_NAME: "dependabot[bot]" });
  return root;
}

test("queryFromSubject drops the conventional-commit prefix and the PR number", () => {
  assert.equal(queryFromSubject("fix(gate): scan only added lines (#321)"), "scan only added lines");
  assert.equal(queryFromSubject("feat!: read a question as explain"), "read a question as explain");
  assert.equal(queryFromSubject("refund a payment"), "refund a payment");
});

test("runHistoryEval scores a commit on its parent tree and leaves the repository untouched", () => {
  const root = historyRepo();
  try {
    const head = git(root, ["rev-parse", "HEAD"]);
    const { data, markdown } = runHistoryEval({ repoPath: root, commits: 10 });

    assert.equal(data.evalKind, "history");
    assert.equal(data.repo.head, head);
    // The release and the bot commit are skipped; the root commit has no parent.
    assert.deepEqual(data.counts.skipped, { "bot author": 1, "release, merge or bump subject": 1, "root commit": 1 });
    assert.equal(data.cases.length, 1);

    const [fix] = data.cases;
    assert.equal(fix.query, "stop refunding a payment twice");
    // The added guard did not exist on the parent and the changelog is
    // bookkeeping, so neither is expected; the changed test is expected in
    // the pack's Tests section, not among the primary files.
    assert.deepEqual(fix.expected, ["src/payment/refund.service.ts"]);
    assert.deepEqual(fix.expectedTests, ["tests/refund.service.test.ts"]);
    assert.deepEqual(fix.added, ["src/payment/refund.guard.ts"]);
    assert.deepEqual(fix.ignored, ["CHANGELOG.md"]);
    assert.equal(fix.error, undefined);
    assert.equal(fix.ranked[0], "src/payment/refund.service.ts");
    assert.equal(fix.metrics.mrr, 1);
    assert.equal(fix.hitAtK, true);
    assert.ok(!fix.ranked.includes("src/payment/refund.guard.ts"), "the pack must be built on the parent tree");

    assert.equal(data.scoreboard.hitAtK, 1);
    assert.equal(data.exitCode, 0);
    assert.match(markdown, /# solumbe History Replay Eval/);
    assert.match(markdown, /stop refunding a payment twice/);

    assert.equal(git(root, ["status", "--porcelain"]), "");
    assert.equal(git(root, ["worktree", "list"]).split("\n").length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runHistoryEval scores a repeated subject once, keeping the newest commit", () => {
  const root = historyRepo();
  try {
    write(root, { "src/payment/refund.service.ts": "export function refundPayment(id: string) {\n  return `refund:${id}:once`;\n}\n" });
    git(root, ["commit", "-q", "-am", "fix: stop refunding a payment twice (#13)"]);
    const newest = git(root, ["rev-parse", "HEAD"]);

    const { data } = runHistoryEval({ repoPath: root, commits: 10 });
    assert.equal(data.cases.length, 1);
    assert.equal(data.cases[0].sha, newest);
    assert.equal(data.counts.skipped["repeated subject"], 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runHistoryEval skips commits that change more files than maxFiles and exits non-zero with no cases", () => {
  const root = historyRepo();
  try {
    const { data } = runHistoryEval({ repoPath: root, commits: 10, maxFiles: 1, ref: "HEAD~2" });
    // At HEAD~2 the fix changes two existing files (the service and its test).
    assert.equal(data.cases.length, 0);
    assert.equal(data.counts.skipped["more than 1 files changed"], 1);
    assert.equal(data.exitCode, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
