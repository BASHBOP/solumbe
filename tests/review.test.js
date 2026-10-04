import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatReviewTerminal, generateReview } from "../src/lib/review.js";
import { createRenderer } from "../src/lib/render/fancy.js";

function gitInit(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `review-${prefix}-`));
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

test("generateReview returns unified verdict + confidence + summaries", async () => {
  const root = gitInit("composite", {
    "package.json": JSON.stringify({ name: "review-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": "export class StripeProcessor { refund() {} }\n",
    "src/booking/booking.controller.ts": "export class BookingController {}\n",
  });
  const { data } = await generateReview(root, { request: "add Stripe refunds to bookings", base: "HEAD" });
  assert.equal(data.ok, true);
  assert.ok(["PASS", "WARN", "FAIL"].includes(data.verdict));
  assert.ok(typeof data.confidence === "number" && data.confidence >= 0 && data.confidence <= 100);
  assert.ok(data.impactSummary.concepts.includes("money flow"), `expected money-flow concept, got ${data.impactSummary.concepts.join(", ")}`);
  assert.ok(data.impactSummary.topFiles.some((file) => file.path.includes("stripe.processor.ts")));
  assert.ok(Array.isArray(data.pass.checks) && data.pass.checks.length >= 5);
});

test("generateReview reports the PR comparison statistics instead of zeroes", async () => {
  const root = gitInit("comparison-stats", {
    "package.json": JSON.stringify({ name: "review-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/index.ts": "export const initial = true;\n",
  });
  fs.writeFileSync(path.join(root, "src/index.ts"), "export const initial = true;\nexport const changed = true;\n");

  const { data } = await generateReview(root, { request: "add the changed export", base: "HEAD" });

  assert.equal(data.prReviewSummary.changedFiles, 1);
  assert.equal(data.prReviewSummary.additions, 1);
  assert.equal(data.prReviewSummary.deletions, 0);
});

// Regression (dogfood, bashbop-event-web): a review of a merged range counted
// untracked scratch files, reporting 88 changed files for a 51-file PR, and
// `--head` reached review context but not impact or the gate.
test("generateReview with a head reviews exactly base..head in every engine", async () => {
  const root = gitInit("exact-head", {
    "package.json": JSON.stringify({ name: "review-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/paystack/bvn.service.ts": "export const verifyBvn = () => false;\n",
  });
  fs.writeFileSync(path.join(root, "src/paystack/bvn.service.ts"), "export const verifyBvn = () => true;\n");
  spawnSync("git", ["commit", "-q", "-am", "verify bvn"], { cwd: root });
  fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
  fs.writeFileSync(path.join(root, "scratch/notes.ts"), "export const notes = 1;\n");

  const { data, fullReports } = await generateReview(root, { request: "verify the paystack bvn", base: "HEAD~1", head: "HEAD" });

  assert.deepEqual(fullReports.pass.changedFiles, ["src/paystack/bvn.service.ts"]);
  assert.equal(fullReports.pass.scope, "commit");
  assert.deepEqual(fullReports.impact.diffEvidence.mappedFiles, ["src/paystack/bvn.service.ts"]);
  assert.equal(data.prReviewSummary.changedFiles, 1);
  assert.ok(!data.impactSummary.topFiles.some((file) => file.path.startsWith("scratch/")));
});

test("formatReviewTerminal renders a verdict line with bars in fancy mode", async () => {
  const root = gitInit("fancy", {
    "package.json": JSON.stringify({ name: "review-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/index.ts": "export const ok = 1;\n",
  });
  const { data } = await generateReview(root, { request: "tweak something", base: "HEAD" });
  const fancy = formatReviewTerminal(data, (opts) => createRenderer({ ...opts, emoji: true }));
  assert.match(fancy, /solumbe review/);
  assert.match(fancy, /verdict/);
  assert.match(fancy, /confidence/);
});

test("formatReviewTerminal stays legible in plain mode", async () => {
  const root = gitInit("plain", {
    "package.json": JSON.stringify({ name: "review-fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/index.ts": "export const ok = 1;\n",
  });
  const { data } = await generateReview(root, { request: "tweak something", base: "HEAD" });
  const plain = formatReviewTerminal(data, (opts) => createRenderer({ ...opts, emoji: false }));
  assert.ok(!plain.includes("🚦"));
  assert.match(plain, /Confidence/);
  assert.match(plain, /\[#+\.*\]|\[\.*\]/, "expected an ASCII bar somewhere");
});

// A web client and its API, side by side, as bashbop-event-web and
// bashbop-api are: the web decides "BVN required" from the user's location
// while the API decides it from the profile country. A review of the web side
// must point at the API file, or the mismatch is never seen.
function companionFixture({ companions = ["../api"] } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-companions-")));
  const repo = (name, files) => {
    const root = path.join(parent, name);
    fs.mkdirSync(root);
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
  };
  const api = repo("api", {
    "package.json": JSON.stringify({ name: "api", version: "1.0.0", scripts: { test: "node --test" } }),
    "src/paystack/paystack.service.ts":
      "export class PaystackService {\n  bvnRequired(profile) { return profile.country === 'NG'; }\n  verifyBvn(bvn) { return bvn; }\n}\n",
    "src/users/users.controller.ts": "export class UsersController {}\n",
  });
  const web = repo("web", {
    "package.json": JSON.stringify({ name: "web", version: "1.0.0", scripts: { test: "node --test" } }),
    ...(companions ? { ".solumberc.json": JSON.stringify({ companions }) } : {}),
    "src/checkout/bvn-gate.tsx": "export function BvnGate({ location }) { return location.country === 'NG'; }\n",
    "src/home/home.page.tsx": "export function HomePage() { return null; }\n",
  });
  return { parent, web, api };
}

test("generateReview adds the companion repository's leads for the same request", async () => {
  const { parent, web, api } = companionFixture();
  const { data } = await generateReview(web, { request: "decide when BVN verification is required", base: "HEAD" });

  assert.equal(data.schemaVersion, 2);
  assert.ok(
    data.impactSummary.topFiles.every((file) => !file.path.includes("paystack")),
    "the web repo's own owner files stay its own",
  );
  const [lead, ...rest] = data.impactSummary.companions;
  assert.equal(rest.length, 0);
  assert.equal(lead.repo, "api");
  assert.equal(lead.root, api);
  assert.equal(lead.topFiles[0].path, "src/paystack/paystack.service.ts");
  assert.ok(lead.topFiles.length <= 3);
  assert.ok(lead.topFiles.every((file) => file.score > 0 && Array.isArray(file.riskFlags)));

  const plain = formatReviewTerminal(data, (opts) => createRenderer({ ...opts, emoji: false }));
  assert.match(plain, /Companion repository leads\n\s+\S+ api: src\/paystack\/paystack\.service\.ts \(score \d+(\.\d+)?\)/);
  fs.rmSync(parent, { recursive: true });
});

test("generateReview omits companion leads when none are configured or no request is given", async () => {
  const unconfigured = companionFixture({ companions: null });
  const { data: plain } = await generateReview(unconfigured.web, { request: "decide when BVN verification is required", base: "HEAD" });
  assert.equal(plain.schemaVersion, 2);
  assert.ok(!("companions" in plain.impactSummary), "no .solumberc.json companions, no field");
  assert.doesNotMatch(
    formatReviewTerminal(plain, (opts) => createRenderer({ ...opts, emoji: false })),
    /Companion/,
  );
  fs.rmSync(unconfigured.parent, { recursive: true });

  const configured = companionFixture();
  const { data: unasked } = await generateReview(configured.web, { base: "HEAD" });
  assert.equal(unasked.request, "review this change");
  assert.ok(!("companions" in unasked.impactSummary), "the placeholder request does not rank the companions");
  fs.rmSync(configured.parent, { recursive: true });
});

test("an attestation built from a companion verdict records schema 2 and only the repo's own files", async () => {
  const { buildAttestation } = await import("../src/lib/attest.js");
  const { parent, web } = companionFixture();
  const { data } = await generateReview(web, { request: "decide when BVN verification is required", base: "HEAD" });
  const record = buildAttestation({ verdict: data, merge: "abc123" }, []);
  assert.equal(record.verdictSchemaVersion, 2);
  assert.deepEqual(
    record.impactedFiles,
    data.impactSummary.topFiles.map((file) => file.path),
  );
  assert.ok(!JSON.stringify(record).includes("paystack"), "companion leads never enter the ledger record");
  fs.rmSync(parent, { recursive: true });
});
