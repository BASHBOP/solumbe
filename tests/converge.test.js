import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bandFor, formatConvergenceMarkdown, generateConvergence, inferInScopeFiles, makeReceipt } from "../src/lib/converge.js";

// The engine's git/diff scoring path is integration-tested end-to-end in
// tests/mcp-dispatch.test.js ("convergence_score scores intent vs diff against a
// real git fixture"); here we lock the pure, deterministic pieces: the receipt's
// recomputability (the "tamper-evident attestation" claim), owner-adjacent
// inference, and the band thresholds, plus the base..head and untracked modes
// against small Git fixtures.

const baseReceiptInput = {
  engine: "0.1.0",
  task: "add Stripe refunds",
  base: "origin/main",
  commit: "abc123",
  convergence: 72,
  subScores: { coverage: 80, scope: 70, riskAlignment: 60 },
  changedFiles: ["src/payment/refund.js", "src/payment/checkout.js"],
  confirmedDirect: ["src/payment/refund.js"],
  confirmedRelated: ["src/payment/checkout.js"],
  unconfirmedCandidates: [],
  missedChangedFiles: [],
};

test("receipt is deterministic — same inputs produce the same id and hash", () => {
  const a = makeReceipt(baseReceiptInput);
  const b = makeReceipt({ ...baseReceiptInput });
  assert.equal(a.inputsHash, b.inputsHash);
  assert.equal(a.id, b.id);
  assert.equal(a.algorithm, "sha256");
  assert.match(a.id, /^rcpt_[0-9a-f]{12}$/);
  assert.equal(a.id, "rcpt_d5d0ce15cc98", "legacy receipt display IDs must remain stable");
  assert.equal(a.inputsHash, "d5d0ce15cc986ca6c0a548f8ddd0307e74b76f7af78bdda72ccb4891be7fdfc8");
  assert.equal(a.receiptVersion, undefined);
  assert.equal(a.subject, undefined);
});

test("receipt is order-independent — file list ordering does not change the hash", () => {
  const a = makeReceipt(baseReceiptInput);
  const b = makeReceipt({
    ...baseReceiptInput,
    changedFiles: ["src/payment/checkout.js", "src/payment/refund.js"],
  });
  assert.equal(a.inputsHash, b.inputsHash, "sorting the canonical payload makes the receipt order-independent");
});

test("receipt changes when a load-bearing input changes", () => {
  const base = makeReceipt(baseReceiptInput);
  const score = makeReceipt({ ...baseReceiptInput, convergence: 73 });
  const commit = makeReceipt({ ...baseReceiptInput, commit: "def456" });
  const task = makeReceipt({ ...baseReceiptInput, task: "add Stripe payouts" });
  const drift = makeReceipt({ ...baseReceiptInput, missedChangedFiles: ["src/auth/login.js"] });
  for (const variant of [score, commit, task, drift]) {
    assert.notEqual(base.inputsHash, variant.inputsHash);
  }
});

test("v2 receipt canonicalises the exact change subject", () => {
  const subject = {
    kind: "github-pr",
    repository: "org/repo",
    number: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const reordered = {
    headSha: subject.headSha.toUpperCase(),
    number: subject.number,
    baseSha: subject.baseSha.toUpperCase(),
    repository: "Org/Repo",
    kind: subject.kind,
  };
  const a = makeReceipt({ ...baseReceiptInput, commit: subject.headSha, subject });
  const b = makeReceipt({ ...baseReceiptInput, commit: subject.headSha.toUpperCase(), subject: reordered });

  assert.equal(a.inputsHash, b.inputsHash);
  assert.equal(a.receiptVersion, 2);
  assert.deepEqual(a.subject, subject);
});

test("v2 receipt changes when only an exact subject identifier changes", () => {
  const staged = {
    kind: "git-index",
    baseSha: "a".repeat(40),
    parentSha: "b".repeat(40),
    treeSha: "c".repeat(40),
  };
  const pr = {
    kind: "github-pr",
    repository: "org/repo",
    number: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  };
  const stagedReceipt = makeReceipt({ ...baseReceiptInput, commit: staged.parentSha, subject: staged });
  const changedTree = makeReceipt({ ...baseReceiptInput, commit: staged.parentSha, subject: { ...staged, treeSha: "d".repeat(40) } });
  assert.notEqual(stagedReceipt.inputsHash, changedTree.inputsHash);

  const prReceipt = makeReceipt({ ...baseReceiptInput, commit: pr.headSha, subject: pr });
  const changedBase = makeReceipt({ ...baseReceiptInput, commit: pr.headSha, subject: { ...pr, baseSha: "d".repeat(40) } });
  const changedHead = makeReceipt({ ...baseReceiptInput, commit: "d".repeat(40), subject: { ...pr, headSha: "d".repeat(40) } });
  assert.notEqual(prReceipt.inputsHash, changedBase.inputsHash);
  assert.notEqual(prReceipt.inputsHash, changedHead.inputsHash);
});

test("v2 receipt refuses incomplete or invented subjects", () => {
  assert.throws(
    () => makeReceipt({ ...baseReceiptInput, subject: { kind: "github-pr", baseSha: "a".repeat(40), headSha: "b".repeat(40) } }),
    /invalid exact change subject/,
  );
  assert.throws(
    () => makeReceipt({ ...baseReceiptInput, subject: { kind: "custom", baseSha: "a".repeat(40), headSha: "b".repeat(40) } }),
    /invalid exact change subject/,
  );
  assert.throws(
    () =>
      makeReceipt({
        ...baseReceiptInput,
        commit: "c".repeat(40),
        subject: {
          kind: "github-pr",
          repository: "org/repo",
          number: 42,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
        },
      }),
    /commit does not match/,
  );
});

test("v2 receipt binds a git-commit subject to its head commit and tree", () => {
  const subject = { kind: "git-commit", baseSha: "a".repeat(40), headSha: "b".repeat(40), treeSha: "c".repeat(40) };
  const receipt = makeReceipt({ ...baseReceiptInput, commit: subject.headSha, subject: { ...subject, headSha: subject.headSha.toUpperCase() } });
  assert.equal(receipt.receiptVersion, 2);
  assert.deepEqual(receipt.subject, subject);
  assert.equal(receipt.commit, subject.headSha);

  const otherTree = makeReceipt({ ...baseReceiptInput, commit: subject.headSha, subject: { ...subject, treeSha: "d".repeat(40) } });
  assert.notEqual(receipt.inputsHash, otherTree.inputsHash);

  assert.throws(
    () => makeReceipt({ ...baseReceiptInput, commit: subject.headSha, subject: { ...subject, treeSha: undefined } }),
    /invalid exact change subject/,
  );
  assert.throws(() => makeReceipt({ ...baseReceiptInput, commit: "e".repeat(40), subject }), /commit does not match/);
});

test("receipt carries inferred files only when there are some, keeping older payloads byte-stable", () => {
  const plain = makeReceipt(baseReceiptInput);
  assert.equal(makeReceipt({ ...baseReceiptInput, inferredRelated: [] }).inputsHash, plain.inputsHash);
  const inferred = makeReceipt({ ...baseReceiptInput, inferredRelated: ["src/payment/refund-reason.js"] });
  assert.notEqual(inferred.inputsHash, plain.inputsHash);
});

// --- owner-adjacent inference: a feature's own fan-out is not drift ---

const inferenceInput = {
  confirmedDirect: ["components/people/PeopleTable.tsx"],
  confirmedRelated: ["components/ui/SmartTable.tsx", "lib/organisation-people.ts"],
  candidates: [],
  addedFiles: [],
  mappedFiles: [],
};

/** @param {Partial<typeof inferenceInput>} overrides */
function inferred(overrides) {
  return inferInScopeFiles({ ...inferenceInput, ...overrides }).map((entry) => `${entry.rule}:${entry.file}<-${entry.anchor}`);
}

test("a new mapped file beside a confirmed owner is inferred in scope", () => {
  const file = "components/people/PersonDialog.tsx";
  assert.deepEqual(inferred({ candidates: [file], addedFiles: [file], mappedFiles: [file] }), [`owner-sibling:${file}<-components/people/PeopleTable.tsx`]);
});

test("owner-sibling inference needs a new, mapped, non-secret file in the owner's own directory", () => {
  const modified = "components/people/PeopleFilters.tsx";
  assert.deepEqual(inferred({ candidates: [modified], mappedFiles: [modified] }), [], "a modified sibling is still drift");

  const unmapped = "components/people/dump.rdb";
  assert.deepEqual(inferred({ candidates: [unmapped], addedFiles: [unmapped] }), [], "an unmapped by-product is still drift");

  const nested = "components/people/dialogs/PersonDialog.tsx";
  assert.deepEqual(inferred({ candidates: [nested], addedFiles: [nested], mappedFiles: [nested] }), [], "a subdirectory is not beside the owner");

  const secret = "components/people/.env";
  assert.deepEqual(inferred({ candidates: [secret], addedFiles: [secret], mappedFiles: [secret] }), []);

  const beside = "components/people/PersonDialog.tsx";
  assert.deepEqual(
    inferred({
      confirmedDirect: [],
      confirmedRelated: ["components/people/PeopleTable.tsx"],
      candidates: [beside],
      addedFiles: [beside],
      mappedFiles: [beside],
    }),
    [],
    "only a confirmed required owner anchors siblings",
  );

  const rootFile = "helpers.ts";
  assert.deepEqual(
    inferred({ confirmedDirect: ["index.ts"], candidates: [rootFile], addedFiles: [rootFile], mappedFiles: [rootFile] }),
    [],
    "an owner at the repository root anchors nothing",
  );
});

test("a new sibling carrying a risk flag its owner lacks stays drift", () => {
  const risky = "components/people/auth-token.ts";
  assert.deepEqual(inferred({ candidates: [risky], addedFiles: [risky], mappedFiles: [risky] }), []);
});

test("tests of confirmed files and of inferred siblings are inferred in scope", () => {
  const sibling = "components/people/PersonDialog.tsx";
  const tests = [
    "__tests__/components/people/PersonDialog.test.tsx",
    "__tests__/components/ui/SmartTable.selection.test.tsx",
    "__tests__/lib/organisation-people.test.ts",
    "e2e/people-table.spec.ts",
  ];
  assert.deepEqual(inferred({ candidates: [sibling, ...tests], addedFiles: [sibling], mappedFiles: [sibling] }), [
    "owner-test:__tests__/components/people/PersonDialog.test.tsx<-components/people/PersonDialog.tsx",
    "owner-test:__tests__/components/ui/SmartTable.selection.test.tsx<-components/ui/SmartTable.tsx",
    "owner-test:__tests__/lib/organisation-people.test.ts<-lib/organisation-people.ts",
    `owner-sibling:${sibling}<-components/people/PeopleTable.tsx`,
  ]);
});

test("a test named after a generic stem must sit beside its file", () => {
  const input = { confirmedDirect: ["src/billing/index.ts"], confirmedRelated: [] };
  assert.deepEqual(inferred({ ...input, candidates: ["tests/index.test.ts"] }), [], "a distant index test identifies nothing");
  assert.deepEqual(inferred({ ...input, candidates: ["src/billing/__tests__/index.test.ts"] }), [
    "owner-test:src/billing/__tests__/index.test.ts<-src/billing/index.ts",
  ]);
});

test("band thresholds: aligned >= 80, partial >= 50, else drift", () => {
  assert.equal(bandFor(100), "aligned");
  assert.equal(bandFor(80), "aligned");
  assert.equal(bandFor(79), "partial");
  assert.equal(bandFor(50), "partial");
  assert.equal(bandFor(49), "drift");
  assert.equal(bandFor(0), "drift");
});

// --- drift weighting: a file is not the risk surface its name mentions ---

function convergeGit(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function driftFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-converge-drift-"));
  for (const [file, body] of Object.entries({
    "src/index.ts": "export const a = 1;\n",
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hi ${name}`; }\n",
    "src/payment/checkout.service.ts": "export const c = 1;\n",
    "docs/auth-guide.md": "# auth\n",
    "docs/setup-guide.md": "# setup\n",
    "tests/checkout.spec.ts": "export const t = 1;\n",
    "tests/util.spec.ts": "export const u = 1;\n",
  })) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  convergeGit(root, "init", "-q", "-b", "main");
  convergeGit(root, "config", "commit.gpgsign", "false");
  convergeGit(root, "add", ".");
  convergeGit(root, "commit", "-q", "-m", "base");
  return root;
}

function riskAlignmentAfterDrifting(root, file) {
  fs.appendFileSync(path.join(root, file), "// drift\n");
  convergeGit(root, "add", file);
  try {
    const data = generateConvergence("update the greeting message", { path: root, base: "HEAD", staged: true });
    assert.equal(data.drivers.grounded, true, "the task must ground, or risk alignment is not measured at all");
    return data.subScores.riskAlignment;
  } finally {
    convergeGit(root, "restore", "--staged", file);
    convergeGit(root, "checkout", "--", file);
  }
}

test("drifted docs are weighted by being docs, not by the concept their name mentions", () => {
  const root = driftFixture();
  const auth = riskAlignmentAfterDrifting(root, "docs/auth-guide.md");
  const setup = riskAlignmentAfterDrifting(root, "docs/setup-guide.md");
  assert.equal(auth, setup, `two docs should carry the same drift weight, got auth=${auth} setup=${setup}`);
});

test("drifted specs are weighted by being tests, not by the domain they test", () => {
  const root = driftFixture();
  const checkout = riskAlignmentAfterDrifting(root, "tests/checkout.spec.ts");
  const util = riskAlignmentAfterDrifting(root, "tests/util.spec.ts");
  assert.equal(checkout, util, `two specs should carry the same drift weight, got checkout=${checkout} util=${util}`);
});

test("a genuinely risky drifted path is still penalised more than a doc", () => {
  const root = driftFixture();
  const service = riskAlignmentAfterDrifting(root, "src/payment/checkout.service.ts");
  const doc = riskAlignmentAfterDrifting(root, "docs/auth-guide.md");
  assert.ok(service < doc, `payment service drift should cost more than doc drift, got service=${service} doc=${doc}`);
});

// --- a task that predicts nothing has no score ---

function stagedConvergence(root, task, file) {
  fs.appendFileSync(path.join(root, file), "// change\n");
  convergeGit(root, "add", file);
  try {
    return generateConvergence(task, { path: root, base: "HEAD", staged: true });
  } finally {
    convergeGit(root, "restore", "--staged", file);
    convergeGit(root, "checkout", "--", file);
  }
}

test("a task that predicts no owner file is inconclusive, with no score and no sub-scores", () => {
  const root = driftFixture();
  const data = stagedConvergence(root, "tidy things up", "docs/setup-guide.md");

  assert.equal(data.drivers.grounded, false);
  assert.equal(data.band, "inconclusive");
  assert.equal(data.convergence, null);
  assert.deepEqual(data.subScores, { coverage: null, scope: null, riskAlignment: null });
  assert.match(data.recommendations[0], /did not ground .* inconclusive: there is no score/);
  assert.ok(!data.recommendations.some((rec) => /scope drift/.test(rec)), "nothing was predicted, so nothing can be called drift");
  assert.match(data.receipt.id, /^rcpt_[0-9a-f]{12}$/, "an inconclusive result still has a recomputable receipt");

  const markdown = formatConvergenceMarkdown(data);
  assert.match(markdown, /^# Convergence: inconclusive$/m);
  assert.ok(!markdown.includes("/100"), "no number is printed for a result that was not measured");
  assert.match(markdown, /Not measured: the task predicted no owner file/);
  assert.match(markdown, /Changed, not predicted: `docs\/setup-guide\.md`/);
});

test("an ungrounded task reads the same for a harmless change and a risky one, and names the risky path", () => {
  const root = driftFixture();
  const harmless = stagedConvergence(root, "tidy things up", "docs/setup-guide.md");
  const risky = stagedConvergence(root, "tidy things up", "src/payment/checkout.service.ts");

  assert.equal(harmless.band, "inconclusive");
  assert.equal(risky.band, "inconclusive");
  assert.equal(risky.convergence, null);
  assert.ok(risky.recommendations.some((rec) => /Risk-sensitive paths changed: `src\/payment\/checkout\.service\.ts`/.test(rec)));
  assert.match(formatConvergenceMarkdown(risky), /Risk-sensitive changes: src\/payment\/checkout\.service\.ts \[/);
});

// --- exact commit subject: score base..head without the working tree ---

function featureCommitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-converge-head-"));
  const write = (files) => {
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), body);
    }
  };
  convergeGit(root, "init", "-q", "-b", "main");
  convergeGit(root, "config", "commit.gpgsign", "false");
  write({
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hi ${name}`; }\n",
    "src/cache/store.ts": "export const store = new Map();\n",
    "src/notes.ts": "export const notes = [];\n",
  });
  convergeGit(root, "add", ".");
  convergeGit(root, "commit", "-q", "-m", "base");
  write({
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `hello ${name}`; }\n",
    "src/greeting/banner.ts": "export const banner = () => '*';\n",
    "src/cache/store.ts": "export const store = new WeakMap();\n",
  });
  convergeGit(root, "add", ".");
  convergeGit(root, "commit", "-q", "-m", "feature");
  // Local state that is not part of the commit: a dirty tracked file and an
  // untracked by-product.
  write({ "src/notes.ts": "export const notes = ['dirty'];\n", "dump.rdb": "REDIS0011" });
  return root;
}

const TASK = "update the greeting message";

test("head scores exactly base..head and binds the receipt to the head commit and tree", () => {
  const root = featureCommitFixture();
  const baseSha = convergeGit(root, "rev-parse", "HEAD~1").trim();
  const headSha = convergeGit(root, "rev-parse", "HEAD").trim();
  const treeSha = convergeGit(root, "rev-parse", "HEAD^{tree}").trim();

  const data = generateConvergence(TASK, { path: root, base: baseSha, head: headSha });
  assert.deepEqual(data.subject, { kind: "git-commit", baseSha, headSha, treeSha });
  assert.deepEqual(data.receipt.subject, data.subject);
  assert.equal(data.receipt.receiptVersion, 2);
  assert.equal(data.receipt.commit, headSha);
  assert.equal(data.head, headSha);
  assert.equal(data.untracked, undefined, "an exact subject has no untracked files to report");
  assert.equal(data.drivers.changedFiles, 3, "only the commit's three files are scored");
  const everyFile = JSON.stringify(data.drivers);
  assert.ok(!everyFile.includes("src/notes.ts"), "a dirty tracked file is not part of base..head");
  assert.ok(!everyFile.includes("dump.rdb"), "an untracked file is not part of base..head");
  assert.deepEqual(data.drivers.confirmedDirect, ["src/greeting/greeting.ts"]);
  assert.deepEqual(data.drivers.inferredRelated, [{ file: "src/greeting/banner.ts", rule: "owner-sibling", anchor: "src/greeting/greeting.ts" }]);
  assert.deepEqual(data.drivers.missedChangedFiles, ["src/cache/store.ts"]);
  assert.equal(data.subScores.scope, 67);

  // Moving on from the commit — more dirty edits, a new commit on top — cannot
  // change the receipt for the same base..head.
  fs.writeFileSync(path.join(root, "src/greeting/greeting.ts"), "export function greetingMessage() { return 'uncommitted'; }\n");
  convergeGit(root, "add", "src/notes.ts");
  convergeGit(root, "commit", "-q", "-m", "later");
  const again = generateConvergence(TASK, { path: root, base: baseSha, head: headSha });
  assert.equal(again.receipt.inputsHash, data.receipt.inputsHash);

  const later = generateConvergence(TASK, { path: root, base: baseSha, head: "HEAD" });
  assert.notEqual(later.receipt.inputsHash, data.receipt.inputsHash, "a different head is a different subject");
});

test("head refuses staged mode and forged commit subjects", () => {
  const root = featureCommitFixture();
  assert.throws(() => generateConvergence(TASK, { path: root, base: "HEAD~1", head: "HEAD", staged: true }), /either --head <ref> or --staged/);
  assert.throws(() => generateConvergence(TASK, { path: root, base: "HEAD~1", head: "no-such-ref" }), /could not resolve head commit/);

  const { subject } = generateConvergence(TASK, { path: root, base: "HEAD~1", head: "HEAD" });
  const files = ["src/cache/store.ts", "src/greeting/banner.ts", "src/greeting/greeting.ts"];
  assert.equal(generateConvergence(TASK, { path: root, base: "HEAD~1", subject, diffFiles: files }).subject.treeSha, subject.treeSha);
  assert.throws(
    () => generateConvergence(TASK, { path: root, base: "HEAD~1", subject: { ...subject, treeSha: subject.baseSha }, diffFiles: files }),
    /tree does not match its head commit/,
  );
  assert.throws(() => generateConvergence(TASK, { path: root, base: "HEAD~1", subject, diffFiles: ["src/notes.ts"] }), /do not match the Git commit subject/);
});

test("working-tree mode lists untracked files instead of scoring them, unless asked", () => {
  const root = featureCommitFixture();
  const tracked = generateConvergence(TASK, { path: root, base: "HEAD~1" });
  assert.equal(tracked.subject, undefined);
  assert.deepEqual(tracked.untracked, { included: false, count: 1, files: ["dump.rdb"] });
  assert.ok(!tracked.drivers.missedChangedFiles.includes("dump.rdb"));
  assert.ok(tracked.drivers.missedChangedFiles.includes("src/notes.ts"), "tracked working-tree edits are still scored");
  assert.match(tracked.recommendations.join("\n"), /Untracked files were not scored: `dump\.rdb`/);

  const withUntracked = generateConvergence(TASK, { path: root, base: "HEAD~1", includeUntracked: true });
  assert.deepEqual(withUntracked.untracked, { included: true, count: 1, files: ["dump.rdb"] });
  assert.ok(withUntracked.drivers.missedChangedFiles.includes("dump.rdb"));
  assert.ok(withUntracked.subScores.scope < tracked.subScores.scope);
});

test("inferInScopeFiles keeps a change's suffixed tests, changelog and eval data in scope", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: ["src/lib/mcp.js"],
    confirmedRelated: [],
    candidates: [
      "tests/mcp-dispatch.test.js",
      "CHANGELOG.md",
      "evals/corpus.json",
      "evals/fixtures/telemetry-web/middleware/admin-auth.ts",
      "docs/EVALS.md",
      "src/lib/billing.js",
    ],
    addedFiles: [],
    mappedFiles: [],
  }).map((entry) => `${entry.rule}:${entry.file}`);

  assert.deepEqual(inferred, [
    "owner-changelog:CHANGELOG.md",
    "owner-test-data:evals/corpus.json",
    "owner-test-data:evals/fixtures/telemetry-web/middleware/admin-auth.ts",
    "owner-test:tests/mcp-dispatch.test.js",
  ]);
});

test("inferInScopeFiles needs a confirmed owner before the changelog or eval data count", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: [],
    confirmedRelated: [],
    candidates: ["CHANGELOG.md", "evals/corpus.json"],
    addedFiles: [],
    mappedFiles: [],
  });
  assert.deepEqual(inferred, []);
});

test("inferInScopeFiles does not read a suffix after a generic stem as naming the file", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: ["src/lib/index.js"],
    confirmedRelated: [],
    candidates: ["tests/index-cache.test.js"],
    addedFiles: [],
    mappedFiles: [],
  });
  assert.deepEqual(inferred, []);
});

test("inferInScopeFiles keeps what the change wires to a confirmed file, from the lines it adds", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: ["src/lib/context-engine.js"],
    confirmedRelated: ["src/lib/code-map/text.js"],
    candidates: [
      "src/lib/code-map/ast.js",
      "tests/registered-names.test.js",
      "docs/EVALS.md",
      "docs/gap-note.md",
      "src/lib/auth/session.js",
      "docs/unrelated.md",
      "src/lib/reporter.js",
    ],
    addedFiles: [],
    mappedFiles: [],
    addedLines: new Map([
      ["src/lib/code-map/ast.js", ['import { isIdentifierShaped, lineNumberAt } from "./text.js";']],
      ["tests/registered-names.test.js", ['import { generateContextPack } from "../src/lib/context-engine.js";']],
      ["docs/EVALS.md", ["The change pins `src/lib/context-engine.js` for a named tool."]],
      ["docs/gap-note.md", ["- `ast.js` indexes registered names"]],
      // Imports a confirmed file but carries an auth flag that file lacks.
      ["src/lib/auth/session.js", ['import { x } from "../context-engine.js";']],
      ["docs/unrelated.md", ["Setup notes for the new release."]],
      // Already imported the confirmed file; this change added nothing that wires them.
      ["src/lib/reporter.js", ["export const header = 'report';"]],
    ]),
  }).map((entry) => `${entry.rule}:${entry.file}<-${entry.anchor}`);

  assert.deepEqual(inferred, [
    "owner-doc:docs/EVALS.md<-src/lib/context-engine.js",
    "owner-doc:docs/gap-note.md<-src/lib/code-map/ast.js",
    "owner-import:src/lib/code-map/ast.js<-src/lib/code-map/text.js",
    "owner-test:tests/registered-names.test.js<-src/lib/context-engine.js",
  ]);
});

test("inferInScopeFiles follows root-alias imports to a confirmed file", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: ["components/providers/openpanel-provider.tsx"],
    confirmedRelated: ["utils/analytics.ts", "src/lib/session.ts"],
    candidates: [
      "app/dashboard/guests/GuestsTable.tsx",
      "components/faq/FaqItem.tsx",
      "app/(customer)/pricing/Pricing.tsx",
      "components/billing/PayoutDialog.tsx",
      "__tests__/utils/analytics.test.ts",
      "app/dashboard/home/page.tsx",
    ],
    addedFiles: [],
    mappedFiles: [],
    addedLines: new Map([
      ["app/dashboard/guests/GuestsTable.tsx", ["import { analytics } from '@/utils/analytics';"]],
      ["components/faq/FaqItem.tsx", ['import { analytics } from "~/utils/analytics";']],
      // `@/lib/session` resolves under `src/` when the root has no `lib/`.
      ["app/dashboard/home/page.tsx", ["import { readSession } from '@/lib/session';"]],
      // A money-flow file the change wired up still needs its own review.
      ["components/billing/PayoutDialog.tsx", ["import { analytics } from '@/utils/analytics';"]],
      ["__tests__/utils/analytics.test.ts", ["import { analytics } from '@/utils/analytics';"]],
      // An alias to a file the change did not confirm wires nothing.
      ["app/(customer)/pricing/Pricing.tsx", ["import { formatPrice } from '@/utils/price';"]],
    ]),
  }).map((entry) => `${entry.rule}:${entry.file}<-${entry.anchor}`);

  assert.deepEqual(inferred, [
    "owner-test:__tests__/utils/analytics.test.ts<-utils/analytics.ts",
    "owner-import:app/dashboard/guests/GuestsTable.tsx<-utils/analytics.ts",
    "owner-import:app/dashboard/home/page.tsx<-src/lib/session.ts",
    "owner-import:components/faq/FaqItem.tsx<-utils/analytics.ts",
  ]);
});

test("a doc naming only a generic file name names nothing", () => {
  const inferred = inferInScopeFiles({
    confirmedDirect: ["src/lib/index.js"],
    confirmedRelated: [],
    candidates: ["docs/notes.md"],
    addedFiles: [],
    mappedFiles: [],
    addedLines: new Map([["docs/notes.md", ["Run `index.js` to start."]]]),
  });
  assert.deepEqual(inferred, []);
});

test("head mode reads the lines a commit adds to place its docs", () => {
  const root = featureCommitFixture();
  const write = (files) => {
    for (const [file, body] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), body);
    }
  };
  write({ "docs/greeting.md": "# Greeting\n", "docs/setup.md": "# Setup\n" });
  convergeGit(root, "add", "docs");
  convergeGit(root, "commit", "-q", "-m", "docs");
  const baseSha = convergeGit(root, "rev-parse", "HEAD").trim();
  write({
    "src/greeting/greeting.ts": "export function greetingMessage(name) { return `welcome ${name}`; }\n",
    "tests/welcome.test.ts": 'import { greetingMessage } from "../src/greeting/greeting";\n',
    "src/cache/store.ts": 'import { greetingMessage } from "../greeting/greeting.js";\nexport const store = new Map([["hi", greetingMessage("x")]]);\n',
    "docs/greeting.md": "# Greeting\n\n`src/greeting/greeting.ts` now says welcome.\n",
    "docs/setup.md": "# Setup\n\nInstall with npm.\n",
  });
  convergeGit(root, "add", "src/greeting/greeting.ts", "tests/welcome.test.ts", "src/cache/store.ts", "docs/greeting.md", "docs/setup.md");
  convergeGit(root, "commit", "-q", "-m", "welcome");
  const headSha = convergeGit(root, "rev-parse", "HEAD").trim();

  const data = generateConvergence(TASK, { path: root, base: baseSha, head: headSha });
  assert.deepEqual(data.drivers.confirmedDirect, ["src/greeting/greeting.ts"]);
  // The import graph already relates the new test and the importing module.
  assert.deepEqual(data.drivers.confirmedRelated, ["src/cache/store.ts", "tests/welcome.test.ts"]);
  // The doc is placed from the line the commit adds to it, read through git.
  assert.deepEqual(data.drivers.inferredRelated, [{ file: "docs/greeting.md", rule: "owner-doc", anchor: "src/greeting/greeting.ts" }]);
  assert.deepEqual(data.drivers.missedChangedFiles, ["docs/setup.md"]);
});
