import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluatePR, formatPassPrMarkdown, formatPassPrTerminal } from "../src/lib/pass-pr.js";
import { createRenderer } from "../src/lib/render/fancy.js";

function gitInit(prefix, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pass-pr-${prefix}-`));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: root });
  spawnSync("git", ["config", "user.name", "T"], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function fakeRunner(map) {
  return {
    run(_cwd, args) {
      const joined = args.join(" ");
      for (const [keyPrefix, response] of Object.entries(map)) {
        if (joined === keyPrefix || joined.startsWith(`${keyPrefix} `)) {
          if (response instanceof Error) throw response;
          if (typeof response === "function") return response(args);
          return response;
        }
      }
      throw new Error(`fake gh runner: missing response for "${joined}"`);
    },
  };
}

const baselineCanned = {
  "pr view": JSON.stringify({
    number: 42,
    title: "Add Stripe refunds",
    url: "https://github.com/org/repo/pull/42",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefOid: "b".repeat(40),
    changedFiles: 1,
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    files: [{ path: "src/payment.ts" }],
    reviews: [{ author: { login: "alice" }, state: "APPROVED" }],
    statusCheckRollup: [{ name: "tests", conclusion: "SUCCESS" }],
  }),
  "repo view": JSON.stringify({ nameWithOwner: "org/repo" }),
  "api graphql": JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
  "api repos/org/repo/branches/main/protection": JSON.stringify({
    required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true },
    required_status_checks: { contexts: ["tests"], checks: [{ context: "tests" }] },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  }),
};

test("evaluatePR returns PASS-grade checks when approved with clean CI and protected branch", async () => {
  const root = gitInit("approved", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/utils/format.ts": "export const fmt = 1;\n",
    ".github/CODEOWNERS": "src/utils/format.ts @alice\n",
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      files: [{ path: "src/utils/format.ts" }],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.verdict, "PASS");
  assert.equal(data.checks.find((c) => c.name === "Review decision").status, "PASS");
  assert.equal(data.checks.find((c) => c.name === "PR state").status, "PASS");
  assert.equal(data.checks.find((c) => c.name === "Status checks").status, "PASS");
  assert.equal(data.checks.find((c) => c.name === "Branch protection").status, "PASS");
});

test("PR convergence receipt is bound to GitHub's exact base and head commits", async () => {
  const root = gitInit("exact-subject", {
    ".gitignore": ".solumbe/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/index.ts": "export const greeting = 'hi';\n",
  });
  const mergeBase = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const greeting = 'hello';\n");
  git(root, "add", "src/index.ts");
  git(root, "commit", "-q", "-m", "update greeting");
  const headSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
  fs.writeFileSync(path.join(root, "src/base-only.ts"), "export const baseOnly = true;\n");
  git(root, "add", "src/base-only.ts");
  git(root, "commit", "-q", "-m", "advance base");
  const baseSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "feature");
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      baseRefOid: baseSha,
      headRefOid: headSha,
      files: [{ path: "src/index.ts" }],
      changedFiles: 1,
    }),
  };
  git(root, "replace", headSha, baseSha);

  const data = await evaluatePR(root, "42", {
    runner: fakeRunner(canned),
    request: "update the greeting",
    minConvergence: 0,
  });
  const convergence = data.checks.find((check) => check.name === "Convergence");

  assert.equal(data.checks.find((check) => check.name === "PR snapshot").status, "PASS");
  assert.deepEqual(data.subject, {
    kind: "github-pr",
    repository: "org/repo",
    number: 42,
    baseSha,
    headSha,
  });
  assert.equal(data.pr.baseSha, baseSha);
  assert.equal(data.pr.headSha, headSha);
  assert.deepEqual(data.changedFiles, ["src/index.ts"], "base-only changes must not enter GitHub's three-dot PR scope");
  assert.notEqual(baseSha, mergeBase, "fixture must exercise an advanced base branch");
  assert.equal(convergence.status, "PASS");
  assert.deepEqual(convergence.receipt.subject, data.subject);
  assert.equal(convergence.receipt.commit, headSha);
  assert.deepEqual(data.receipt, convergence.receipt);
});

test("PR convergence fails closed when the local checkout is not the GitHub head", async () => {
  const root = gitInit("head-mismatch", {
    ".gitignore": ".solumbe/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    "src/index.ts": "export const greeting = 'hi';\n",
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      baseRefOid: git(root, "rev-parse", "HEAD"),
      headRefOid: "c".repeat(40),
      files: [{ path: "src/index.ts" }],
      changedFiles: 1,
    }),
  };

  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned), request: "update the greeting", minConvergence: 0 });
  const convergence = data.checks.find((check) => check.name === "Convergence");
  assert.equal(convergence.status, "FAIL");
  assert.match(convergence.summary, /not the exact GitHub PR head/);
});

test("PR convergence fails closed when GitHub omits exact OIDs or a complete file list", async () => {
  const root = gitInit("incomplete-subject", {
    ".gitignore": ".solumbe/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  });
  const missingOid = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), baseRefOid: undefined }),
  };
  const incompleteFiles = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), changedFiles: 2 }),
  };

  for (const canned of [missingOid, incompleteFiles]) {
    const data = await evaluatePR(root, "42", { runner: fakeRunner(canned), request: "review the change", minConvergence: 0 });
    assert.equal(data.checks.find((check) => check.name === "PR snapshot").status, "WARN");
    assert.equal(data.checks.find((check) => check.name === "Convergence").status, "FAIL");
  }
});

test("evaluatePR FAILS when PR is a draft", async () => {
  const root = gitInit("draft", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), isDraft: true }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.verdict, "FAIL");
  assert.equal(data.checks.find((c) => c.name === "PR state").status, "FAIL");
});

test("evaluatePR FAILS on requested changes", async () => {
  const root = gitInit("changes", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), reviewDecision: "CHANGES_REQUESTED" }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.verdict, "FAIL");
  assert.equal(data.checks.find((c) => c.name === "Review decision").status, "FAIL");
});

test("evaluatePR FAILS on a failed status check", async () => {
  const root = gitInit("failing-ci", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      statusCheckRollup: [{ name: "tests", conclusion: "FAILURE", detailsUrl: "" }],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.verdict, "FAIL");
  assert.equal(data.checks.find((c) => c.name === "Status checks").status, "FAIL");
});

test("evaluatePR FAILS on CODEOWNERS approval missing for changed files", async () => {
  const root = gitInit("codeowners", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    "src/payment.ts": "export const refund = 1;\n",
    ".github/CODEOWNERS": "src/payment.ts @bob\n",
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      reviews: [{ author: { login: "alice" }, state: "APPROVED" }],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.checks.find((c) => c.name === "CODEOWNERS").status, "FAIL");
  assert.equal(data.verdict, "FAIL");
});

test("evaluatePR passes CODEOWNERS when the owner has approved", async () => {
  const root = gitInit("codeowners-approved", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    "src/payment.ts": "export const refund = 1;\n",
    ".github/CODEOWNERS": "src/payment.ts @alice\n",
  });
  const data = await evaluatePR(root, "42", { runner: fakeRunner(baselineCanned) });
  assert.equal(data.checks.find((c) => c.name === "CODEOWNERS").status, "PASS");
  // Risk review WARNs because src/payment.ts is a money-flow path, so the
  // overall verdict is WARN. CODEOWNERS itself must PASS.
  assert.equal(data.verdict, "WARN");
});

test("evaluatePR WARNs when branch protection is missing", async () => {
  const root = gitInit("no-protection", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api repos/org/repo/branches/main/protection": new Error("HTTP 404: Branch not protected"),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const protection = data.checks.find((c) => c.name === "Branch protection");
  assert.equal(protection.status, "WARN");
  assert.match(protection.summary, /not protected/);
});

test("evaluatePR FAILs under high-risk policy when sensitive paths change without CODEOWNERS pass", async () => {
  const root = gitInit("high-risk", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      files: [{ path: "prisma/schema.prisma" }, { path: "src/payment.ts" }],
      changedFiles: 2,
    }),
  };
  const data = await evaluatePR(root, "42", { policy: "high-risk", runner: fakeRunner(canned) });
  const policy = data.checks.find((c) => c.name === "Policy profile");
  assert.notEqual(policy.status, "PASS", `expected non-PASS policy under high-risk, got ${policy.status}`);
});

// --- Finding #3 (gate kind-awareness): test/doc-only PR changes do not warn Risk review ---

test("evaluatePR does not warn Risk review when only a test file and a doc change", async () => {
  const root = gitInit("gate-test-doc", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      files: [{ path: "tests/checkout.spec.ts" }, { path: "docs/git-checkout-guide.md" }],
      changedFiles: 2,
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const risk = data.checks.find((c) => c.name === "Risk review");
  assert.equal(risk.status, "PASS", `test/doc-only PR should not trip risk gate, got ${risk.status}: ${JSON.stringify(risk.details)}`);
});

test("evaluatePR does not FAIL Secret safety for an env-substring source path", async () => {
  const root = gitInit("gate-secret-fp", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      files: [{ path: "src/config/dev.environments.ts" }],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const secret = data.checks.find((c) => c.name === "Secret safety");
  assert.equal(secret.status, "PASS", `env-substring source should not fail secret gate, got ${secret.status}`);
});

// --- Finding #8: branch-protection "present but incomplete" path ---

test("evaluatePR WARNs when branch protection exists but is missing recommended safeguards", async () => {
  const root = gitInit("protection-incomplete", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api repos/org/repo/branches/main/protection": JSON.stringify({
      required_pull_request_reviews: { required_approving_review_count: 0, require_code_owner_reviews: false },
      required_status_checks: { contexts: [], checks: [] },
      required_conversation_resolution: { enabled: false },
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: true },
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const protection = data.checks.find((c) => c.name === "Branch protection");
  assert.equal(protection.status, "WARN");
  assert.match(protection.summary, /missing recommended safeguards/);
  // Every individual safeguard gap should be reported.
  assert.ok(protection.details.some((d) => /approving review/i.test(d)));
  assert.ok(protection.details.some((d) => /CODEOWNERS review/i.test(d)));
  assert.ok(protection.details.some((d) => /status checks/i.test(d)));
  assert.ok(protection.details.some((d) => /Conversation resolution/i.test(d)));
  assert.ok(protection.details.some((d) => /Force pushes/i.test(d)));
  assert.ok(protection.details.some((d) => /deletion/i.test(d)));
});

test("evaluatePR WARNs when required_pull_request_reviews is entirely absent", async () => {
  const root = gitInit("protection-no-reviews", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api repos/org/repo/branches/main/protection": JSON.stringify({
      required_status_checks: { contexts: ["tests"] },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const protection = data.checks.find((c) => c.name === "Branch protection");
  assert.equal(protection.status, "WARN");
  assert.ok(protection.details.some((d) => /Pull request reviews are not required/i.test(d)));
});

test("evaluatePR reports Branch protection as SKIPPED when the protection API errors unexpectedly", async () => {
  const root = gitInit("protection-error", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api repos/org/repo/branches/main/protection": new Error("HTTP 500: server exploded"),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const protection = data.checks.find((c) => c.name === "Branch protection");
  assert.equal(protection.status, "SKIPPED");
  assert.match(protection.summary, /could not inspect branch protection/);
});

test("a review decision GitHub did not return is SKIPPED and leaves the verdict to the other checks", async () => {
  const root = gitInit("no-review-decision", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/utils/format.ts": "export const fmt = 1;\n",
    ".github/CODEOWNERS": "src/utils/format.ts @alice\n",
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), files: [{ path: "src/utils/format.ts" }], reviewDecision: "" }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  assert.equal(data.checks.find((c) => c.name === "Review decision").status, "SKIPPED");
  assert.equal(data.verdict, "PASS");
  const terminal = formatPassPrTerminal(data, (options) => createRenderer({ ...options, color: false, emoji: false }));
  assert.match(terminal, /ready to merge once review decision is confirmed/);

  // A profile that requires the evidence still fails without it.
  const strict = await evaluatePR(root, "42", { policy: "company", runner: fakeRunner(canned) });
  assert.equal(strict.verdict, "FAIL");
  assert.ok(strict.checks.find((c) => c.name === "Policy profile").details.some((d) => /Review decision must be PASS, got SKIPPED/.test(d)));
});

test("CODEOWNERS that cannot be read or checked automatically are SKIPPED, and a missing approval still fails", async () => {
  const files = {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/utils/format.ts": "export const fmt = 1;\n",
  };
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), files: [{ path: "src/utils/format.ts" }] }),
  };
  // An owner outside GitHub (an email address) cannot be matched to a reviewer.
  const external = gitInit("codeowners-external", { ...files, ".github/CODEOWNERS": "src/utils/format.ts owner@example.com\n" });
  const unverifiable = (await evaluatePR(external, "42", { runner: fakeRunner(canned) })).checks.find((c) => c.name === "CODEOWNERS");
  assert.equal(unverifiable.status, "SKIPPED");
  assert.match(unverifiable.summary, /could not be verified automatically/);

  const missing = gitInit("codeowners-missing-approval", { ...files, ".github/CODEOWNERS": "src/utils/format.ts @bob\n" });
  assert.equal((await evaluatePR(missing, "42", { runner: fakeRunner(canned) })).checks.find((c) => c.name === "CODEOWNERS").status, "FAIL");
});

// --- Finding #8: unresolved review conversations ---

test("evaluatePR FAILS when there are unresolved review conversations", async () => {
  const root = gitInit("unresolved", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api graphql": JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false, path: "src/payment.ts", line: 12, comments: { nodes: [{ author: { login: "bob" }, url: "https://gh/c/1" }] } },
                { isResolved: true, path: "src/other.ts", line: 3, comments: { nodes: [] } },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const conv = data.checks.find((c) => c.name === "Review conversations");
  assert.equal(conv.status, "FAIL");
  assert.ok(conv.details.some((d) => d.includes("src/payment.ts:12")));
  assert.ok(conv.details.some((d) => d.includes("@bob")));
  assert.equal(data.verdict, "FAIL");
});

test("evaluatePR paginates review threads across multiple pages", async () => {
  const root = gitInit("unresolved-paged", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const page1 = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ isResolved: true, path: "a.ts", line: 1, comments: { nodes: [] } }],
            pageInfo: { hasNextPage: true, endCursor: "CUR1" },
          },
        },
      },
    },
  });
  const page2 = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ isResolved: false, startLine: 7, path: "b.ts", comments: { nodes: [] } }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  });
  // Route page 2 by matching the cursor argument in the graphql call.
  const runner = {
    run(_cwd, args) {
      const joined = args.join(" ");
      if (joined.startsWith("api graphql")) {
        return joined.includes("cursor=CUR1") ? page2 : page1;
      }
      for (const [prefix, response] of Object.entries(baselineCanned)) {
        if (joined === prefix || joined.startsWith(`${prefix} `)) {
          if (response instanceof Error) throw response;
          return response;
        }
      }
      throw new Error(`missing canned response for "${joined}"`);
    },
  };
  const data = await evaluatePR(root, "42", { runner });
  const conv = data.checks.find((c) => c.name === "Review conversations");
  assert.equal(conv.status, "FAIL");
  assert.ok(
    conv.details.some((d) => d.includes("b.ts:7")),
    `expected paged unresolved thread, got ${JSON.stringify(conv.details)}`,
  );
});

test("evaluatePR WARNs Review conversations when the threads API errors", async () => {
  const root = gitInit("unresolved-error", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "api graphql": new Error("HTTP 502: bad gateway"),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const conv = data.checks.find((c) => c.name === "Review conversations");
  assert.equal(conv.status, "WARN");
  assert.match(conv.summary, /Could not inspect review conversations/);
});

// --- Finding #8: status-check fallback paths (pending, status-only, enrichment) ---

test("evaluatePR WARNs Status checks when a check is still pending", async () => {
  const root = gitInit("pending-ci", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      statusCheckRollup: [
        { name: "tests", conclusion: "SUCCESS" },
        { name: "build", conclusion: "", status: "IN_PROGRESS" },
      ],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const checks = data.checks.find((c) => c.name === "Status checks");
  assert.equal(checks.status, "WARN");
  assert.ok(checks.details.some((d) => d.includes("build")));
});

test("evaluatePR WARNs Status checks when no status checks are reported", async () => {
  const root = gitInit("no-ci", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), statusCheckRollup: [] }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const checks = data.checks.find((c) => c.name === "Status checks");
  assert.equal(checks.status, "WARN");
  assert.match(checks.summary, /No status checks/);
});

test("evaluatePR treats NEUTRAL/SKIPPED conclusions as passing and ignores legacy state field", async () => {
  const root = gitInit("neutral-ci", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      statusCheckRollup: [
        { name: "lint", conclusion: "NEUTRAL" },
        { name: "optional", conclusion: "SKIPPED" },
        { context: "legacy", state: "COMPLETED" },
      ],
    }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const checks = data.checks.find((c) => c.name === "Status checks");
  assert.equal(checks.status, "PASS");
});

test("evaluatePR enriches a failed check with CI-readiness annotations from the check-runs API", async () => {
  const root = gitInit("ci-annotations", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      statusCheckRollup: [
        {
          name: "ci",
          workflowName: "CI",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/org/repo/actions/runs/1/job/99",
        },
      ],
    }),
    "api repos/org/repo/check-runs/99/annotations": JSON.stringify([{ message: "The job was not started because your spending limit was reached." }]),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const checks = data.checks.find((c) => c.name === "Status checks");
  assert.equal(checks.status, "FAIL");
  assert.ok(
    checks.details.some((d) => /ci readiness/i.test(d)),
    `expected ci-readiness annotation, got ${JSON.stringify(checks.details)}`,
  );
});

// --- Finding #8: review-decision and PR-state edge cases (uncovered branches) ---

test("evaluatePR WARNs Review decision in solo governance when review is required", async () => {
  const root = gitInit("solo-review", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), reviewDecision: "REVIEW_REQUIRED" }),
  };
  const data = await evaluatePR(root, "42", { governance: "solo", runner: fakeRunner(canned) });
  const decision = data.checks.find((c) => c.name === "Review decision");
  assert.equal(decision.status, "WARN");
  assert.match(decision.summary, /Solo-maintainer/);
});

test("evaluatePR WARNs PR state when GitHub mergeability is unsettled", async () => {
  const root = gitInit("unsettled", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const state = data.checks.find((c) => c.name === "PR state");
  assert.equal(state.status, "WARN");
  assert.match(state.summary, /not settled/);
});

test("evaluatePR FAILS PR state on merge conflicts", async () => {
  const root = gitInit("conflict", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });
  const state = data.checks.find((c) => c.name === "PR state");
  assert.equal(state.status, "FAIL");
  assert.match(state.summary, /merge conflicts/);
});

// --- PR lifecycle: merged and closed PRs are not gated as if still open ---

// Answer `gh pr view --json <fields>` the way gh does, with only the fields
// requested, so a state the gate never asks for never reaches it.
function prView(overrides) {
  const pr = { ...JSON.parse(baselineCanned["pr view"]), ...overrides };
  return (args) => {
    const fields = args[args.indexOf("--json") + 1].split(",");
    return JSON.stringify(Object.fromEntries(fields.filter((field) => field in pr).map((field) => [field, pr[field]])));
  };
}

function renderTerminal(data) {
  const plain = formatPassPrTerminal(data, (opts) => createRenderer({ ...opts, emoji: false, width: 100 }));
  return { plain, nextStep: plain.split("\n").find((line) => line.includes("next step")) };
}

test("evaluatePR still gates an OPEN PR on GitHub mergeability", async () => {
  const root = gitInit("state-open", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  const clean = await evaluatePR(root, "42", { runner: fakeRunner({ ...baselineCanned, "pr view": prView({ state: "OPEN" }) }) });
  assert.equal(clean.pr.state, "OPEN");
  assert.equal(clean.pr.mergedAt, "");
  assert.equal(clean.checks.find((c) => c.name === "PR state").status, "PASS");

  const unsettled = await evaluatePR(root, "42", {
    runner: fakeRunner({ ...baselineCanned, "pr view": prView({ state: "OPEN", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }) }),
  });
  const state = unsettled.checks.find((c) => c.name === "PR state");
  assert.equal(state.status, "WARN");
  assert.match(state.summary, /not settled/);
});

test("evaluatePR reports a MERGED PR as merged, not pending, and keeps its review evidence", async () => {
  const root = gitInit("state-merged", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/utils/format.ts": "export const fmt = 1;\n",
    ".github/CODEOWNERS": "src/utils/format.ts @alice\n",
  });
  // What GitHub returns once a PR merges (BASHBOP/solumbe#214): mergeability UNKNOWN.
  const merged = { state: "MERGED", mergedAt: "2026-09-26T17:33:49Z", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
  const data = await evaluatePR(root, "42", {
    runner: fakeRunner({ ...baselineCanned, "pr view": prView({ ...merged, files: [{ path: "src/utils/format.ts" }] }) }),
  });
  const state = data.checks.find((c) => c.name === "PR state");
  assert.equal(state.status, "PASS");
  assert.equal(state.summary, "PR is already merged; there is nothing left to gate.");
  assert.ok(state.details.includes("Merged at 2026-09-26T17:33:49Z"));
  assert.equal(data.pr.state, "MERGED");
  assert.equal(data.pr.mergedAt, "2026-09-26T17:33:49Z");
  // Post-merge attestation records these, so a merged PR still gets them.
  for (const name of ["Review decision", "CODEOWNERS", "Review conversations", "Branch protection", "Status checks"]) {
    assert.equal(data.checks.find((c) => c.name === name)?.status, "PASS", name);
  }
  assert.equal(data.verdict, "PASS");
  assert.match(renderTerminal(data).nextStep, /already merged/);
});

test("evaluatePR FAILs a MERGED PR on missing CODEOWNERS approval, not on its state", async () => {
  const root = gitInit("state-merged-unowned", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }),
    "src/payment.ts": "export const refund = 1;\n",
    ".github/CODEOWNERS": "src/payment.ts @bob\n",
  });
  const data = await evaluatePR(root, "42", {
    runner: fakeRunner({
      ...baselineCanned,
      "pr view": prView({ state: "MERGED", mergedAt: "2026-09-26T17:33:49Z", mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
    }),
  });
  assert.equal(data.checks.find((c) => c.name === "PR state").status, "PASS");
  assert.equal(data.checks.find((c) => c.name === "CODEOWNERS").status, "FAIL");
  assert.equal(data.verdict, "FAIL");
  const { plain, nextStep } = renderTerminal(data);
  assert.doesNotMatch(plain, /blocked by/, "nothing can block a merge that already happened");
  assert.match(nextStep, /already merged/);
});

test("evaluatePR FAILs a CLOSED PR as closed, whatever mergeability GitHub last reported", async () => {
  const root = gitInit("state-closed", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0" }) });
  // BASHBOP/solumbe#188 closed BLOCKED and #153 closed CONFLICTING; a closed draft is closed first.
  for (const last of [{ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, { isDraft: true }]) {
    const data = await evaluatePR(root, "42", { runner: fakeRunner({ ...baselineCanned, "pr view": prView({ state: "CLOSED", ...last }) }) });
    const state = data.checks.find((c) => c.name === "PR state");
    assert.equal(state.status, "FAIL", JSON.stringify(last));
    assert.equal(state.summary, "PR is closed without merging and cannot merge unless it is reopened.");
    assert.equal(data.pr.state, "CLOSED");
    assert.equal(data.verdict, "FAIL");
    assert.match(renderTerminal(data).nextStep, /reopen/);
  }
});

// --- Finding #8: renderers (terminal + markdown) exercised end-to-end ---

test("formatPassPrTerminal and formatPassPrMarkdown render the verdict and checks", async () => {
  const root = gitInit("render", {
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/utils/format.ts": "export const fmt = 1;\n",
    ".github/CODEOWNERS": "src/utils/format.ts @alice\n",
  });
  const canned = {
    ...baselineCanned,
    "pr view": JSON.stringify({ ...JSON.parse(baselineCanned["pr view"]), files: [{ path: "src/utils/format.ts" }] }),
  };
  const data = await evaluatePR(root, "42", { runner: fakeRunner(canned) });

  const plain = formatPassPrTerminal(data, (opts) => createRenderer({ ...opts, emoji: false, width: 80 }));
  assert.match(plain, /solumbe pass-pr/);
  assert.match(plain, /Context evidence/);

  const fancy = formatPassPrTerminal(data, (opts) => createRenderer({ ...opts, emoji: true, width: 80 }));
  assert.match(fancy, /merge readiness/);

  const markdown = formatPassPrMarkdown(data);
  assert.match(markdown, /# solumbe pass-pr/);
  assert.match(markdown, /Verdict:/);
  assert.match(markdown, /## Checks/);
  assert.match(markdown, /Branch protection/);
});

// --- Release discipline in PR mode reads the PR's own commits ---

function releaseRepo(prefix, extra = {}) {
  const root = gitInit(prefix, {
    ".gitignore": ".solumbe/\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { left: "1.0.0" } }),
    "src/index.ts": "export const greeting = 'hi';\n",
    ...extra,
  });
  const baseSha = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feature");
  return { root, baseSha };
}

function commitFiles(root, files, message) {
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function prRunner(baseSha, headSha, headRefName, files) {
  return fakeRunner({
    ...baselineCanned,
    "pr view": JSON.stringify({
      ...JSON.parse(baselineCanned["pr view"]),
      baseRefOid: baseSha,
      headRefOid: headSha,
      headRefName,
      changedFiles: files.length,
      files: files.map((file) => ({ path: file })),
    }),
  });
}

test("evaluatePR judges Release discipline by the PR head commit, not by a later checkout", async () => {
  const { root, baseSha } = releaseRepo("release-head");
  const headSha = commitFiles(
    root,
    { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" }, dependencies: { left: "1.1.0" } }) },
    "bump a dependency",
  );
  // The checkout has moved past the PR head onto a release.
  commitFiles(root, { "package.json": JSON.stringify({ name: "fixture", version: "3.0.0" }) }, "release 3.0.0");

  const data = await evaluatePR(root, "42", { runner: prRunner(baseSha, headSha, "feature", ["package.json"]) });
  const release = data.checks.find((check) => check.name === "Release discipline");
  assert.equal(release.status, "PASS", release.summary);
  assert.match(release.summary, /project version is unchanged/);
});

test("evaluatePR flags a hand-made bump in a Release Please repository and passes the release PR", async () => {
  const { root, baseSha } = releaseRepo("release-please", { "release-please-config.json": JSON.stringify({ packages: { ".": {} } }) });
  const headSha = commitFiles(
    root,
    { "package.json": JSON.stringify({ name: "fixture", version: "1.1.0", scripts: { test: "node --test" }, dependencies: { left: "1.0.0" } }) },
    "bump the version",
  );

  const manual = await evaluatePR(root, "42", { runner: prRunner(baseSha, headSha, "feature", ["package.json"]) });
  const finding = manual.checks.find((check) => check.name === "Release discipline");
  assert.equal(finding.status, "FAIL");
  assert.match(finding.summary, /bumped by hand in a Release Please repository/);
  assert.equal(manual.verdict, "FAIL");

  const release = await evaluatePR(root, "42", { runner: prRunner(baseSha, headSha, "release-please--branches--main", ["package.json"]) });
  assert.equal(release.checks.find((check) => check.name === "Release discipline").status, "PASS");
});

test("PR reports render a SKIPPED check without changing the verdict", async () => {
  const root = gitInit("skipped-render", { "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }) });
  const data = await evaluatePR(root, "42", { runner: fakeRunner(baselineCanned) });
  const withSkipped = { ...data, checks: [...data.checks, { name: "Compliance controls", status: "SKIPPED", summary: "Not checked here." }] };

  const terminal = formatPassPrTerminal(withSkipped, (opts) => createRenderer({ ...opts, emoji: false, width: 80 }));
  assert.match(terminal, /Compliance controls/);
  assert.match(terminal, /Not checked here/);
  assert.match(formatPassPrMarkdown(withSkipped), /### SKIPPED {2}· {2}Compliance controls/);
  assert.equal(data.verdict, aggregateVerdictOf(withSkipped.checks));
});

function aggregateVerdictOf(checks) {
  return checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "WARN") ? "WARN" : "PASS";
}
