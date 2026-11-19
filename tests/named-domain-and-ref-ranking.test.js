// Regression tests for ranking and check failures seen when a feature that
// lives in one module (`src/floor-plans`) was built in git worktrees while the
// indexed checkout was behind its upstream. evals/fixtures/named-domain-api
// is a small API with such a module; evals/corpus.json holds the retrieval
// and risk cases.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { generateContextPack } from "../src/lib/context-engine.js";
import { predictionConfidence } from "../src/lib/converge.js";
import { generateImpact } from "../src/lib/impact.js";
import { startMcpServer } from "../src/lib/mcp.js";
import { getRankingCodeMap } from "../src/lib/ref-snapshot.js";
import { classifyPath, conceptsFromQuery, isGateRiskPath, RISK_FLAGS, riskReviewSummary } from "../src/lib/risk-paths.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evals", "fixtures", "named-domain-api");

function copyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-named-domain-"));
  fs.cpSync(fixture, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function commitAll(root, message) {
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
}

async function callTools(calls) {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => (buffer += chunk));
  const done = startMcpServer({ input, output });
  calls.forEach((params, index) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params })}\n`));
  input.end();
  await done;
  const messages = buffer
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return calls.map((_, index) => messages.find((message) => message.id === index + 1));
}

test("a domain the request names keeps its primary slots instead of two", (t) => {
  const root = copyFixture(t);
  const { data } = generateContextPack("floor plan builder rows numbering reverse start, fixture shape block, slot labels", { path: root });
  const primary = data.primaryFiles.map((file) => file.path);
  const top = primary.slice(0, 4);
  // The cap handed slots three to five to payment, shipment and carrier
  // services, all scoring below the floor-plans files it left out.
  for (const file of ["floor-plan-builder.schema.ts", "slot-names.ts", "slot-together.ts", "floor-plan-viewer.service.ts"]) {
    assert.ok(top.includes(`src/floor-plans/${file}`), `${file} belongs in the first four, got ${primary.join(", ")}`);
  }
  const scores = data.primaryFiles.map((file) => file.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a),
    "an uncapped named domain leaves the list in score order",
  );
});

test("a request that names no domain still spreads primary files across domains", (t) => {
  const root = copyFixture(t);
  const { data } = generateContextPack("labels for a shipment", { path: root, limit: 4 });
  const perDomain = new Map();
  for (const file of data.primaryFiles.slice(0, 3)) perDomain.set(file.domain, (perDomain.get(file.domain) ?? 0) + 1);
  assert.ok(
    [...perDomain.values()].every((count) => count <= 2),
    JSON.stringify([...perDomain]),
  );
});

test("a file imported by many ranked files gains a capped boost and stays below the owner", (t) => {
  const root = copyFixture(t);
  const { topFiles } = generateImpact("readStoredBuilder floor-plan-builder.schema rotation floor-plan-layout", { path: root, top: 8 }).data;
  assert.equal(topFiles[0].path, "src/floor-plans/floor-plan-builder.schema.ts");
  const paths = topFiles.map((file) => file.path);
  // Every floor-plans service imports PrismaService; uncapped, prisma.module
  // and prisma.service ranked fourth and fifth for a schema-validation change.
  assert.ok(!paths.includes("src/prisma/prisma.module.ts"), paths.join(", "));
  for (const file of topFiles) {
    const gained = file.reasons
      .map((reason) => /related through imports.*\(\+([\d.]+)\)/.exec(reason))
      .reduce((sum, match) => sum + (match ? Number(match[1]) : 0), 0);
    // Each reason prints one decimal, so the printed parts can sum a little over the cap of 16.
    assert.ok(gained <= 16.5, `${file.path} gained ${gained} from imports`);
  }
});

test("a validation schema is not a data-model or auth risk; the database schema still is", (t) => {
  assert.deepEqual(classifyPath("src/floor-plans/floor-plan-builder.schema.ts", { kind: "schema" }), []);
  assert.deepEqual(classifyPath("schemas/shipment.ts", { kind: "schema" }), []);
  assert.equal(isGateRiskPath("src/floor-plans/floor-plan-builder.schema.ts"), false);
  for (const file of [
    "prisma/schema.prisma",
    "src/db/schema.ts",
    "db/schema.sql",
    "prisma/migrations/20261118_add_builder/migration.sql",
    "db/migrations/001_init.js",
  ]) {
    assert.ok(classifyPath(file).includes(RISK_FLAGS.dataModel), file);
  }
  // A file the request names by its dotted name is not a concept.
  assert.deepEqual(conceptsFromQuery("readStoredBuilder floor-plan-builder.schema rotation floor-plan-layout"), []);
  assert.ok(conceptsFromQuery("update the database schema").includes(RISK_FLAGS.dataModel));
  assert.ok(conceptsFromQuery("fix bay-pick.service.ts refund").includes(RISK_FLAGS.moneyFlow), "words outside the file name still count");

  const root = copyFixture(t);
  const impact = generateImpact("validate the floor plan builder Json in floor-plan-builder.schema.ts: reject reversed row numbering", { path: root }).data;
  assert.ok(!impact.concepts.includes(RISK_FLAGS.dataModel));
  assert.ok(!impact.risks.some((risk) => /Data-model/.test(risk)), impact.risks.join(" | "));
  assert.ok(!impact.classifications.requiredOwners.includes("prisma/schema.prisma"));
  assert.ok(!impact.classifications.requiredOwners.includes("src/shipments/shipments.controller.ts"));
});

test("the Risk review warning says which risk each flagged file carries", () => {
  assert.equal(
    riskReviewSummary(["src/payments/payments.service.ts", "src/payment/gateway.webhook.ts", "src/auth/roles.guard.ts"]),
    "Risk-sensitive files changed (money flow: 2, auth/security: 1); maintainer review should be explicit.",
  );
  assert.equal(riskReviewSummary([]), "Risk-sensitive files changed; maintainer review should be explicit.");
});

test("prediction confidence is low when the diff names the task and the predicted owners were not touched", () => {
  const task = "floor plan builder rows numbering reverse start";
  const planFiles = ["src/floor-plans/floor-plan-builder.schema.ts", "src/floor-plans/slot-names.ts", "src/floor-plans/floor-plan-builder.schema.spec.ts"];
  const low = predictionConfidence({ task, changedFiles: planFiles, confirmedDirect: [], predictedDirect: 3, declared: false });
  assert.equal(low.confidence, "low");
  assert.deepEqual([low.ownersConfirmed, low.ownersPredicted, low.changedNamingTask, low.changedSource], [0, 3, 2, 2]);
  assert.match(low.note, /ranking likely missed the owners/);

  const high = predictionConfidence({ task, changedFiles: planFiles, confirmedDirect: [planFiles[0], planFiles[1]], predictedDirect: 3, declared: false });
  assert.equal(high.confidence, "high");

  // Real drift: the changed files carry none of the task's words.
  const drift = predictionConfidence({
    task,
    changedFiles: ["src/notifications/notifications.service.ts", "src/payments/payments.service.ts"],
    confirmedDirect: [],
    predictedDirect: 3,
    declared: false,
  });
  assert.equal(drift.confidence, "medium");

  assert.equal(predictionConfidence({ task, changedFiles: planFiles, confirmedDirect: [], predictedDirect: 3, declared: true }).confidence, "declared");
  assert.equal(predictionConfidence({ task, changedFiles: planFiles, confirmedDirect: [], predictedDirect: 0, declared: false }), null);
});

test("a call without query says what is missing and why; convergence_score takes it from the intent", async (t) => {
  const root = copyFixture(t);
  git(root, "init", "-q", "-b", "main");
  commitAll(root, "base");
  const request = "floor plan supervisor assign free slot named worker shipment";
  const [declared] = await callTools([{ name: "change_impact", arguments: { path: root, query: request, declare: true } }]);
  const intent = JSON.parse(declared.result.content[0].text).intent;
  assert.equal(intent.request, request);
  fs.appendFileSync(path.join(root, "src/floor-plans/floor-plan-assign-worker.service.ts"), "// assign\n");

  const [pack, score, blank, fromIntent, noBase] = await callTools([
    { name: "context_pack", arguments: { path: root } },
    { name: "convergence_score", arguments: { path: root, base: "HEAD" } },
    { name: "convergence_score", arguments: { path: root, base: "HEAD", query: "  " } },
    { name: "convergence_score", arguments: { path: root, base: "HEAD", intent } },
    { name: "convergence_score", arguments: { path: root, query: request } },
  ]);
  assert.equal(pack.error.code, -32602);
  assert.match(pack.error.message, /^query is required \(it was not passed\): the pack ranks files against the task/);
  assert.match(score.error.message, /^query is required \(it was not passed\): the score measures the diff against the task/);
  assert.match(blank.error.message, /^query is required \(it was blank\)/);
  assert.match(noBase.error.message, /^base is required \(it was not passed\): the diff is measured from a git ref/);
  assert.equal(fromIntent.error, undefined, JSON.stringify(fromIntent.error));
  assert.notEqual(fromIntent.result.isError, true, fromIntent.result.content[0].text);
});

test("a clean checkout behind its upstream is ranked against the upstream tree, without touching the checkout", (t) => {
  const origin = copyFixture(t);
  git(origin, "init", "-q", "-b", "main");
  commitAll(origin, "base");
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-named-domain-clone-"));
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  git(clone, "clone", "-q", origin, ".");

  const added = "src/floor-plans/floor-plan-assignments-dialog.service.ts";
  fs.writeFileSync(path.join(origin, added), "export class FloorPlanAssignmentsDialogService {\n  giveFreeSlotToNamedWorker() {}\n}\n");
  commitAll(origin, "add the assignments dialog service");
  git(clone, "fetch", "-q", "origin");
  const statusBefore = git(clone, "status", "--porcelain=v2", "--branch");
  const headBefore = git(clone, "rev-parse", "HEAD");

  // Unasked, the library ranks the files on disk.
  assert.ok(!getRankingCodeMap(clone).files.some((file) => file.path === added));

  const map = getRankingCodeMap(clone, { ref: "auto" });
  assert.equal(map.repo.root, clone, "the report still names the repository, not the cache directory");
  assert.equal(map.repo.snapshot.ref, "origin/main");
  assert.equal(map.repo.snapshot.behind, 1);
  assert.equal(map.repo.snapshot.reason, "behind-upstream");
  assert.ok(
    map.files.some((file) => file.path === added),
    "the file added upstream is indexed",
  );

  const { data } = generateContextPack("floor plan assignments dialog give a free slot to a named worker", { path: clone, ref: "auto" });
  assert.ok(
    data.primaryFiles.some((file) => file.path === added),
    data.primaryFiles.map((file) => file.path).join(", "),
  );
  assert.match(data.conflicts.join("\n"), /was ranked against origin\/main @ [0-9a-f]{7}, 1 commit\(s\) ahead of the checkout/);
  assert.equal(data.repos[0].snapshot.ref, "origin/main");
  const impact = generateImpact("floor plan assignments dialog give a free slot to a named worker", { path: clone, ref: "auto" }).data;
  assert.ok(impact.topFiles.some((file) => file.path === added));
  assert.match(impact.repo.note, /ranked against origin\/main/);

  assert.equal(git(clone, "status", "--porcelain=v2", "--branch"), statusBefore, "index, branch and working tree are untouched");
  assert.equal(git(clone, "rev-parse", "HEAD"), headBefore);
  assert.equal(fs.existsSync(path.join(clone, added)), false);
  assert.equal(git(clone, "worktree", "list").trim().split("\n").length, 1, "no worktree is added to the repository");

  // Uncommitted work exists only on disk: the checkout is ranked as it is.
  fs.appendFileSync(path.join(clone, "src/floor-plans/slot-names.ts"), "// local edit\n");
  assert.equal(getRankingCodeMap(clone, { ref: "auto" }).repo.snapshot, undefined);
  // Asked for by name, the ref is ranked even then.
  assert.equal(getRankingCodeMap(clone, { ref: "origin/main" }).repo.snapshot.reason, "requested");
  assert.throws(() => getRankingCodeMap(clone, { ref: "origin/no-such-branch" }), /does not resolve to a commit/);
});

test("a checkout level with its upstream, or with none, is ranked from disk", (t) => {
  const root = copyFixture(t);
  assert.equal(getRankingCodeMap(root, { ref: "auto" }).repo.snapshot, undefined, "not a git repository");
  git(root, "init", "-q", "-b", "main");
  commitAll(root, "base");
  assert.equal(getRankingCodeMap(root, { ref: "auto" }).repo.snapshot, undefined, "no upstream");
  assert.equal(getRankingCodeMap(root, { ref: "HEAD" }).repo.snapshot, undefined, "HEAD of a clean checkout is the checkout");
});
