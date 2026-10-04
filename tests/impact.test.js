import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { computeTokenDocFrequency, generateImpact, tokenWeightFactor, tokenize, weightedQueryTerms } from "../src/lib/impact.js";
import { generateConvergence } from "../src/lib/converge.js";

test("tokenize splits camelCase and kebab-case identifiers, drops stop-words", () => {
  const tokens = tokenize("addStripeRefunds to bookings");
  assert.deepEqual(tokens, ["stripe", "refunds", "bookings"]);
});

test("weightedQueryTerms boosts domain keywords and adds singular forms", () => {
  const weights = weightedQueryTerms("add Stripe refunds to bookings");
  assert.ok(weights.has("stripe"), "expected stripe present");
  assert.ok(weights.has("refunds"), "expected refunds present");
  assert.ok(weights.has("refund"), "expected singular refund derived");
  assert.ok(weights.get("stripe") >= 3, `stripe weight should be boosted, got ${weights.get("stripe")}`);
});

function writeFixture(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `impact-${prefix}-`));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test("generateImpact ranks the owner controller above a generic validation service for an auth query", () => {
  const root = writeFixture("auth", {
    "package.json": JSON.stringify({ name: "auth-fixture", scripts: { test: "node --test" } }),
    "src/shared/validation/currency-validation.service.ts": [
      "export class CurrencyValidationService {",
      "  validation = true;",
      "  validate() { return this.validation; }",
      "}",
      "",
    ].join("\n"),
    "src/authentication/auth.controller.ts": [
      "export interface MobileAppleSessionBody { token: string }",
      "export interface AppleIdentityTokenPayload { sub: string }",
      "export class AuthController { sign() { return true; } }",
      "",
    ].join("\n"),
  });

  const result = generateImpact("fix Apple sign-in token validation", { path: root });
  const top = result.data.topFiles.map((f) => f.path);
  const authIdx = top.indexOf("src/authentication/auth.controller.ts");
  const currencyIdx = top.indexOf("src/shared/validation/currency-validation.service.ts");
  assert.ok(authIdx >= 0, `auth controller missing from top: ${top.join(", ")}`);
  assert.ok(authIdx < currencyIdx || currencyIdx === -1, `auth (#${authIdx}) should beat currency-validation (#${currencyIdx})`);
  assert.ok(result.data.concepts.includes("auth/security"), "expected auth concept to be inferred");
});

test("generateImpact promotes payment processor above an operational script for a refund query", () => {
  const root = writeFixture("refunds", {
    "package.json": JSON.stringify({ name: "refund-fixture", scripts: { test: "node --test" } }),
    "scripts/sync-database-with-stripe.ts": "export function syncStripe() { return 'stripe'; }\n",
    "src/payment/processors/stripe.processor.ts": ["export class StripeProcessor {", "  refund(bookingId: string) { return bookingId; }", "}", ""].join("\n"),
  });

  const result = generateImpact("add Stripe refunds to bookings", { path: root });
  const top = result.data.topFiles.map((f) => f.path);
  const ownerIdx = top.indexOf("src/payment/processors/stripe.processor.ts");
  const scriptIdx = top.indexOf("scripts/sync-database-with-stripe.ts");
  assert.ok(ownerIdx === 0, `expected processor at #1, got top: ${top.join(", ")}`);
  assert.ok(ownerIdx < scriptIdx, `processor should beat script (script idx ${scriptIdx})`);
});

test("generateImpact flags risk hotspots from concept + classifyPath", () => {
  const root = writeFixture("risks", {
    "package.json": JSON.stringify({ name: "risk-fixture" }),
    "src/payment/refund.ts": "export const refund = true;\n",
  });
  const result = generateImpact("issue Stripe refunds", { path: root });
  assert.ok(result.data.risks.some((r) => r.toLowerCase().includes("money") || r.toLowerCase().includes("refund")));
});

test("generateImpact recognises plural template requests and predictable locale, flag-snapshot, and focused-test fan-out", () => {
  const root = gitFixture("audience-preview", {
    "src/audience/AudienceEmailPreview.tsx": "export function AudienceEmailPreview() { return null; }\n",
    "src/audience/audience.controller.ts": "export class AudienceController { createCampaign() {} }\n",
    "src/audience/create-campaign.dto.ts": "export class CreateCampaignDto {}\n",
    "src/email/templates/responsive-base.hbs": "{{organisationAudiencePreview}}\n",
    "messages/en-GB.json": JSON.stringify({ "audience.preview.title": "Preview" }),
    "src/feature-flags/config/environments/production.json": JSON.stringify({ audienceStudio: false }),
    "src/feature-flags/config/.snapshot": "organisationAudienceStudio=false\n",
    "src/audience/audience-email-preview.test.ts": "import test from 'node:test'; test('preview', () => {});\n",
  });
  fs.writeFileSync(path.join(root, "src/audience/AudienceEmailPreview.tsx"), "export function AudienceEmailPreview() { return 'preview'; }\n");
  fs.writeFileSync(path.join(root, "src/email/templates/responsive-base.hbs"), "{{organisationAudiencePreview}}\n{{previewTitle}}\n");
  fs.writeFileSync(path.join(root, "messages/en-GB.json"), JSON.stringify({ "audience.preview.title": "Preview email" }));
  fs.writeFileSync(path.join(root, "src/feature-flags/config/environments/production.json"), JSON.stringify({ audienceStudio: true }));
  fs.writeFileSync(path.join(root, "src/feature-flags/config/.snapshot"), "organisationAudienceStudio=true\n");
  fs.writeFileSync(path.join(root, "src/audience/audience-email-preview.test.ts"), "import test from 'node:test'; test('preview email', () => {});\n");

  const result = generateImpact("add organisation audience email preview templates with feature flags", { path: root, diffBase: "HEAD", top: 10 });

  assert.ok(result.data.classifications.requiredOwners.includes("src/audience/AudienceEmailPreview.tsx"));
  assert.ok(result.data.classifications.supportingFiles.includes("src/email/templates/responsive-base.hbs"));
  assert.ok(result.data.classifications.advisoryFiles.includes("src/audience/audience.controller.ts"));
  assert.ok(result.data.classifications.advisoryFiles.includes("src/audience/create-campaign.dto.ts"));
  assert.ok(result.data.classifications.supportingFiles.includes("messages/en-GB.json"));
  assert.ok(result.data.classifications.supportingFiles.includes("src/feature-flags/config/environments/production.json"));
  assert.ok(result.data.classifications.supportingFiles.includes("src/feature-flags/config/.snapshot"));
  assert.ok(result.data.classifications.supportingFiles.includes("src/audience/audience-email-preview.test.ts"));
  assert.equal(result.data.topFiles.find((file) => file.path === "src/email/templates/responsive-base.hbs")?.role, "supporting");
  assert.deepEqual(result.data.validation.missedChangedFiles, []);
  assert.ok(result.data.validation.confirmedRelated.includes("messages/en-GB.json"));
  assert.ok(result.data.validation.confirmedRelated.includes("src/feature-flags/config/environments/production.json"));
  assert.ok(result.data.validation.confirmedRelated.includes("src/feature-flags/config/.snapshot"));

  spawnSync("git", ["add", "."], { cwd: root });
  const convergence = generateConvergence("add organisation audience email preview templates with feature flags", { path: root, base: "HEAD", staged: true });
  assert.ok(convergence.convergence >= 80, `expected supporting fan-out not to depress convergence, got ${convergence.convergence}`);
  assert.deepEqual(convergence.drivers.missedChangedFiles, []);
});

test("generateImpact keeps unrelated drift visible beside expected template fan-out", () => {
  const root = gitFixture("audience-preview-drift", {
    "src/audience/AudienceEmailPreview.tsx": "export function AudienceEmailPreview() { return null; }\n",
    "src/email/templates/campaign-message.hbs": "{{campaignMessage}}\n",
    "messages/en-GB.json": JSON.stringify({ "audience.preview.title": "Preview" }),
    "src/feature-flags/config/environments/production.json": JSON.stringify({ audienceStudio: false }),
    "src/payment/refund.service.ts": "export function refund() { return false; }\n",
  });
  fs.writeFileSync(path.join(root, "src/audience/AudienceEmailPreview.tsx"), "export function AudienceEmailPreview() { return 'preview'; }\n");
  fs.writeFileSync(path.join(root, "src/email/templates/campaign-message.hbs"), "{{campaignMessage}}\n{{previewTitle}}\n");
  fs.writeFileSync(path.join(root, "messages/en-GB.json"), JSON.stringify({ "audience.preview.title": "Preview email" }));
  fs.writeFileSync(path.join(root, "src/feature-flags/config/environments/production.json"), JSON.stringify({ audienceStudio: true }));
  fs.writeFileSync(path.join(root, "src/payment/refund.service.ts"), "export function refund() { return true; }\n");

  const result = generateImpact("update audience email preview templates with feature flags", { path: root, diffBase: "HEAD", top: 10 });
  assert.ok(result.data.validation.confirmedRelated.includes("src/email/templates/campaign-message.hbs"));
  assert.ok(result.data.validation.confirmedRelated.includes("messages/en-GB.json"));
  assert.ok(result.data.validation.confirmedRelated.includes("src/feature-flags/config/environments/production.json"));
  assert.deepEqual(result.data.validation.missedChangedFiles, ["src/payment/refund.service.ts"]);
});

test("generateImpact suggests related tests by overlapping path tokens", () => {
  const root = writeFixture("tests", {
    "package.json": JSON.stringify({ name: "test-fixture", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": "export class StripeProcessor { refund() {} }\n",
    "src/payment/processors/stripe.processor.spec.ts": "import test from 'node:test';\ntest('refund stripe', () => {});\n",
    "src/booking/booking.controller.ts": "export class BookingController {}\n",
  });
  const result = generateImpact("add Stripe refunds to bookings", { path: root });
  assert.ok(
    result.data.testSuggestions.some((s) => s.includes("stripe.processor.spec.ts")),
    `expected stripe spec in suggestions, got ${result.data.testSuggestions.join(" | ")}`,
  );
});

test("generateImpact returns markdown that mentions the query and top file", () => {
  const root = writeFixture("markdown", {
    "package.json": JSON.stringify({ name: "md-fixture" }),
    "src/payment/processors/stripe.processor.ts": "export class StripeProcessor { refund() {} }\n",
  });
  const result = generateImpact("add Stripe refunds to bookings", { path: root });
  assert.match(result.markdown, /# Change Impact: add Stripe refunds to bookings/);
  assert.match(result.markdown, /src\/payment\/processors\/stripe\.processor\.ts/);
});

test("generateImpact rejects empty queries", () => {
  assert.throws(() => generateImpact("   ", { path: "." }), /non-empty/);
});

// --- Finding #1 (via impact): a noisy substring concept no longer skews ranking ---

test("generateImpact does not demote files when a request word is only a substring of a concept synonym", () => {
  // "payload" must not infer a money-flow concept (it used to via the "pay"
  // substring). With no concept inferred, the parser file is not demoted and
  // ranks on its own merits.
  const root = writeFixture("payload", {
    "package.json": JSON.stringify({ name: "payload-fixture", scripts: { test: "node --test" } }),
    "src/parsing/payload-parser.service.ts": ["export class PayloadParserService {", "  parsePayload(input: string) { return input; }", "}", ""].join("\n"),
  });
  const result = generateImpact("fix payload parsing", { path: root });
  assert.ok(!result.data.concepts.includes("money flow"), `payload query should infer no money-flow concept, got ${result.data.concepts.join(", ")}`);
  const top = result.data.topFiles.map((f) => f.path);
  assert.equal(top[0], "src/parsing/payload-parser.service.ts", `parser should rank first, got ${top.join(", ")}`);
  const parser = result.data.topFiles[0];
  assert.ok(!parser.reasons.some((r) => r.includes("demoted")), `parser should not be concept-demoted, reasons: ${parser.reasons.join(" | ")}`);
});

// --- Finding #5: concept demotion is proportional and never erases a strong match ---

test("generateImpact keeps a strong owner ahead of an off-concept file under a single concept", () => {
  // Regression guard for the original behavior the safer demotion must preserve.
  const root = writeFixture("demote-single", {
    "package.json": JSON.stringify({ name: "demote-fixture", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": ["export class StripeProcessor {", "  refund(bookingId: string) { return bookingId; }", "}", ""].join("\n"),
    "src/shared/validation/refund-validation.service.ts": ["export class RefundValidationService {", "  validate() { return true; }", "}", ""].join("\n"),
  });
  const result = generateImpact("add Stripe refunds to bookings", { path: root });
  const top = result.data.topFiles.map((f) => f.path);
  const ownerIdx = top.indexOf("src/payment/processors/stripe.processor.ts");
  const valIdx = top.indexOf("src/shared/validation/refund-validation.service.ts");
  assert.ok(ownerIdx >= 0, `owner missing: ${top.join(", ")}`);
  assert.ok(ownerIdx < valIdx || valIdx === -1, `payment owner (#${ownerIdx}) should beat off-concept validation (#${valIdx})`);
});

test("generateImpact softens the off-concept demotion when multiple concepts disagree", () => {
  // A query that infers BOTH a money-flow and an auth concept. A file that
  // owns one concept but not the other should not be demoted as hard as the
  // single-concept case, so the off-concept (but path-relevant) file keeps a
  // meaningful score instead of being crushed by a flat 0.5.
  const root = writeFixture("demote-multi", {
    "package.json": JSON.stringify({ name: "multi-fixture", scripts: { test: "node --test" } }),
    "src/payment/refund.service.ts": ["export class RefundService { refund() { return true; } }", ""].join("\n"),
    "src/checkout/checkout-summary.component.ts": ["export class CheckoutSummaryComponent { render() { return 'summary'; } }", ""].join("\n"),
  });
  const result = generateImpact("add login tokens to the checkout payment flow", { path: root });
  // Multiple concepts should be inferred (auth + money flow).
  assert.ok(result.data.concepts.length >= 2, `expected multiple concepts, got ${result.data.concepts.join(", ")}`);
  const summary = result.data.topFiles.find((f) => f.path === "src/checkout/checkout-summary.component.ts");
  if (summary) {
    const demoteReason = summary.reasons.find((r) => r.includes("demoted"));
    if (demoteReason) {
      const match = demoteReason.match(/×([0-9.]+)/);
      assert.ok(match, `expected a demotion factor in reason: ${demoteReason}`);
      const factor = Number(match[1]);
      assert.ok(factor > 0.5, `multi-concept demotion factor should be softer than 0.5, got ${factor}`);
    }
  }
});

// --- Finding #9: diff validation runs git via the arg-array runner (no shell) ---

test("generateImpact validates against a real diff base using the arg-array git runner", () => {
  const root = gitFixture("validate", {
    "package.json": JSON.stringify({ name: "validate-fixture", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": ["export class StripeProcessor {", "  refund(bookingId) { return bookingId; }", "}", ""].join("\n"),
  });
  // Modify a tracked file so the diff against HEAD is non-empty.
  fs.writeFileSync(
    path.join(root, "src/payment/processors/stripe.processor.ts"),
    ["export class StripeProcessor {", "  refund(bookingId) { return bookingId; }", "  chargeback(id) { return id; }", "}", ""].join("\n"),
  );

  const result = generateImpact("add Stripe refunds", { path: root, diffBase: "HEAD" });
  assert.ok(result.data.validation, "expected a validation block");
  assert.equal(result.data.validation.ok, true, `validation should succeed, got ${JSON.stringify(result.data.validation)}`);
  assert.equal(result.data.validation.base, "HEAD");
  assert.ok(result.data.validation.changedFiles.includes("src/payment/processors/stripe.processor.ts"));
});

test("generateImpact fixes rename semantics independently of local Git config", () => {
  const root = gitFixture("rename-config", {
    "package.json": JSON.stringify({ name: "rename-fixture" }),
    "src/old-name.ts": "export const renamed = true;\n",
  });
  fs.renameSync(path.join(root, "src/old-name.ts"), path.join(root, "src/new-name.ts"));
  spawnSync("git", ["add", "-A"], { cwd: root });

  spawnSync("git", ["config", "diff.renames", "false"], { cwd: root });
  const disabled = generateImpact("rename the source file", { path: root, diffBase: "HEAD" });
  spawnSync("git", ["config", "diff.renames", "copies"], { cwd: root });
  spawnSync("git", ["config", "diff.renameLimit", "1"], { cwd: root });
  spawnSync("git", ["config", "diff.algorithm", "histogram"], { cwd: root });
  const copies = generateImpact("rename the source file", { path: root, diffBase: "HEAD" });

  assert.deepEqual(disabled.data.validation.changedFiles, ["src/new-name.ts"]);
  assert.deepEqual(copies.data.validation.changedFiles, disabled.data.validation.changedFiles);
});

test("generateImpact includes untracked files in diff validation before staging", () => {
  const root = gitFixture("validate-untracked", {
    "package.json": JSON.stringify({ name: "validate-untracked-fixture", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": "export class StripeProcessor { refund() {} }\n",
  });
  fs.mkdirSync(path.join(root, "src/payment/refunds"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/payment/refunds/refund-policy.ts"), "export const refundPolicy = 'safe';\n");

  const result = generateImpact("add a safe refund policy", { path: root, diffBase: "HEAD" });
  assert.equal(result.data.validation.ok, true);
  assert.ok(result.data.validation.changedFiles.includes("src/payment/refunds/refund-policy.ts"));
});

test("generateImpact surfaces exact diff evidence without concealing unexplained changes", () => {
  const root = gitFixture("diff-evidence", {
    "package.json": JSON.stringify({ name: "diff-evidence-fixture" }),
    "src/access/permission.service.ts": "export const canAccess = () => false;\n",
    "src/orders/order.service.ts": "export const findOrder = () => null;\n",
    "src/ui/copy.ts": "export const heading = 'Welcome';\n",
  });
  fs.writeFileSync(path.join(root, "src/access/permission.service.ts"), "export const canAccess = () => true;\n");
  fs.writeFileSync(path.join(root, "src/orders/order.service.ts"), "export const findOrder = (id) => id;\n");

  const result = generateImpact("adjust the welcome message", { path: root, diffBase: "HEAD", top: 1 });
  const exactFiles = ["src/access/permission.service.ts", "src/orders/order.service.ts"];

  assert.deepEqual(result.data.diffEvidence?.mappedFiles, exactFiles);
  for (const file of exactFiles) {
    const entry = result.data.topFiles.find((candidate) => candidate.path === file);
    assert.ok(entry, `changed file missing from surfaced impact: ${file}`);
    assert.ok(
      entry.reasons.some((reason) => reason.includes("exact Git diff evidence")),
      `missing evidence label for ${file}`,
    );
  }
  assert.deepEqual(result.data.validation.missedChangedFiles, exactFiles);
  assert.deepEqual(result.data.validation.heuristic.missedChangedFiles, exactFiles);
});

test("generateImpact reports a clean validation error for a bad diff base instead of throwing", () => {
  const root = gitFixture("validate-bad", {
    "package.json": JSON.stringify({ name: "validate-bad-fixture", scripts: { test: "node --test" } }),
    "src/payment/processors/stripe.processor.ts": ["export class StripeProcessor { refund() {} }", ""].join("\n"),
  });
  // A ref that does not exist; the arg-array runner returns a non-zero status
  // rather than letting a shell interpret it.
  const result = generateImpact("add Stripe refunds", { path: root, diffBase: "no-such-ref-xyz" });
  assert.ok(result.data.validation, "expected a validation block");
  assert.equal(result.data.validation.ok, false);
  assert.match(result.data.validation.error, /git diff failed/);
});

function gitFixture(prefix, files) {
  const root = writeFixture(prefix, files);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: root });
  spawnSync("git", ["config", "user.name", "T"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

// Regression: a library/CLI repository whose implementation files all classify
// as `kind: "source"` could never ground a task. `requiredOwners` stayed empty,
// convergence reported `grounded: false`, and an exactly-correct change scored
// identically to a wholly unrelated one — which made `--min-convergence`
// unusable on that shape of repository.
test("generateImpact grounds a source-kind owner when no conventional owner kind matches", () => {
  const root = writeFixture("source-kind-grounding", {
    "package.json": JSON.stringify({ name: "lib-fixture", scripts: { test: "node --test" } }),
    "src/lib/telemetry.js": [
      "export const DEFAULT_TELEMETRY_SHARE_ENDPOINT = 'https://example.test/analytics';",
      "export function shareTelemetryEvent(record) { return record; }",
      "",
    ].join("\n"),
    "src/lib/obsidian.js": "export function exportObsidianVault() { return 'vault'; }\n",
    "src/lib/catalog.js": "export function listCatalog() { return []; }\n",
  });

  const result = generateImpact("change the telemetry share endpoint", { path: root, top: 10 });
  assert.equal(result.data.topFiles[0]?.path, "src/lib/telemetry.js");
  assert.ok(
    result.data.classifications.requiredOwners.includes("src/lib/telemetry.js"),
    `expected the source-kind owner to ground, got: ${result.data.classifications.requiredOwners.join(", ") || "(none)"}`,
  );
  assert.ok(!result.data.classifications.requiredOwners.includes("src/lib/obsidian.js"), "an unrelated source file must not become a coverage obligation");
});

test("convergence separates an aligned change from drift in a source-kind repository", () => {
  const files = {
    "package.json": JSON.stringify({ name: "lib-fixture", scripts: { test: "node --test" } }),
    "src/lib/telemetry.js": "export const TELEMETRY_SHARE_ENDPOINT = 'https://example.test/a';\n",
    "src/lib/obsidian.js": "export function exportObsidianVault() { return 'vault'; }\n",
  };

  const aligned = gitFixture("source-kind-aligned", files);
  fs.writeFileSync(path.join(aligned, "src/lib/telemetry.js"), "export const TELEMETRY_SHARE_ENDPOINT = 'https://example.test/b';\n");
  spawnSync("git", ["add", "."], { cwd: aligned });
  const alignedScore = generateConvergence("change the telemetry share endpoint", { path: aligned, base: "HEAD", staged: true });

  const drifted = gitFixture("source-kind-drift", files);
  fs.writeFileSync(path.join(drifted, "src/lib/telemetry.js"), "export const TELEMETRY_SHARE_ENDPOINT = 'https://example.test/c';\n");
  spawnSync("git", ["add", "."], { cwd: drifted });
  const driftedScore = generateConvergence("rewrite the obsidian vault export layout", { path: drifted, base: "HEAD", staged: true });

  assert.equal(alignedScore.drivers.grounded, true, "an exactly-correct change must ground");
  assert.ok(alignedScore.convergence >= 80, `aligned change should score high, got ${alignedScore.convergence}`);
  assert.ok(
    driftedScore.convergence < alignedScore.convergence,
    `an unrelated request must score below an aligned one (drift ${driftedScore.convergence} vs aligned ${alignedScore.convergence})`,
  );
});

test("a weak incidental match does not become a coverage obligation", () => {
  const root = writeFixture("weak-fallback", {
    "package.json": JSON.stringify({ name: "lib-fixture", scripts: { test: "node --test" } }),
    "src/lib/catalog.js": "export function listCatalog() { return []; }\n",
    "src/lib/report.js": "export function buildReport() { return 'report'; }\n",
  });

  const result = generateImpact("integrate a third-party payment provider", { path: root, top: 10 });
  assert.deepEqual(result.data.classifications.requiredOwners, [], "no file matches this request; nothing should ground");
});

// Regression: a run could report `verdict: "missed"` while `missedChangedFiles`
// was empty, which reads as a contradiction. Files that were ranked but only as
// advisory leads now have their own bucket, so the verdict is explainable.
test("changed files ranked only as advisory leads are reported separately from drift", () => {
  const root = gitFixture("advisory-changed", {
    "package.json": JSON.stringify({ name: "advisory-fixture", scripts: { test: "node --test" } }),
    "src/orders/orders.controller.ts": "export class OrdersController { list() { return []; } }\n",
    "src/orders/orders.service.ts": "export class OrdersService { list() { return []; } }\n",
  });
  fs.writeFileSync(path.join(root, "src/orders/orders.service.ts"), "export class OrdersService { list() { return [1]; } }\n");

  const result = generateImpact("update the orders controller", { path: root, diffBase: "HEAD", top: 10 });
  const validation = result.data.validation;
  assert.ok(Array.isArray(validation.advisoryChangedFiles), "validation must expose an advisoryChangedFiles bucket");
  const accounted = [...validation.confirmedDirect, ...validation.confirmedRelated, ...validation.advisoryChangedFiles, ...validation.missedChangedFiles];
  for (const file of validation.changedFiles) {
    assert.ok(accounted.includes(file), `${file} must land in exactly one reported bucket`);
  }
});

// Regression: markdown was absent from the code map entirely, so a request
// naming a skill ranked unrelated library files that merely shared vocabulary
// with it — a confident answer resting on the wrong evidence.
function skillFixture(prefix) {
  return writeFixture(prefix, {
    "package.json": JSON.stringify({ name: "skill-fixture" }),
    "codex/skills/model-router/SKILL.md": [
      "---",
      "name: model-router",
      "---",
      "",
      "# Model router",
      "",
      "## Sync",
      "",
      "Canonical: `solumbe/codex/skills/model-router/`.",
      "",
    ].join("\n"),
    "docs/18-model-routing/README.md": "# Model routing\n\n## The advisory footer\n",
    "src/lib/model-route.js": "export function scoreModelRoute(containment) { return containment; }\n",
    "src/lib/telemetry.js": "export function recordRoutePath(path) { return path; }\n",
  });
}

test("generateImpact ranks a skill's SKILL.md as the owner of a request naming that skill", () => {
  const root = skillFixture("skill-owner");
  const result = generateImpact("make the model-router skill layout-agnostic: remove the canvas fallback path", { path: root });
  const top = result.data.topFiles.map((file) => file.path);

  assert.equal(top[0], "codex/skills/model-router/SKILL.md", `expected the skill at #1, got: ${top.join(", ")}`);
  assert.deepEqual(result.data.classifications.requiredOwners, ["codex/skills/model-router/SKILL.md"]);
});

test("generateImpact keeps a skill advisory when the request is about the code, not the skill", () => {
  const root = skillFixture("skill-not-owner");
  const result = generateImpact("fix the model route scoring bug so containment is measured correctly", { path: root });
  const byPath = Object.fromEntries(result.data.topFiles.map((file) => [file.path, file]));

  assert.deepEqual(result.data.classifications.requiredOwners, ["src/lib/model-route.js"]);
  assert.equal(byPath["codex/skills/model-router/SKILL.md"]?.role, "advisory", "a skill must not own a code change that merely shares its vocabulary");
});

test("generateImpact ranks a docs page as the owner of a documentation request", () => {
  const root = skillFixture("docs-owner");
  const result = generateImpact("update the model routing documentation to explain the advisory footer", { path: root });
  const top = result.data.topFiles.map((file) => file.path);

  assert.equal(top[0], "docs/18-model-routing/README.md", `expected the docs page at #1, got: ${top.join(", ")}`);
  assert.deepEqual(result.data.classifications.requiredOwners, ["docs/18-model-routing/README.md"]);
});

// Regressions from the bashbop-event-web review (2026-09-27). The fixture
// mirrors that repository: five locales of one catalog, `utils/create-event.ts`
// defining the `combineDateAndTime` that `services/event-service.ts` imports,
// an unused duplicate in `utils/combineDateAndTime.ts`, and a local copy in
// `aiEventSchema.ts`.
const multiLocaleFixture = path.resolve("evals/fixtures/multi-locale-web");
const overnightRequest =
  "fix overnight event bug: combineDateAndTime doesn't roll over to next day; event-service.ts basic time validation only compares getHours; EditableDate.tsx inline edit blocks overnight ranges";

test("generateImpact pins files the request names as required owners, ahead of every unnamed file", () => {
  const result = generateImpact(overnightRequest, { path: multiLocaleFixture, top: 12 });
  const top = result.data.topFiles.map((file) => file.path);

  assert.deepEqual(top.slice(0, 2), ["services/event-service.ts", "components/inline-edit/EditableDate.tsx"], `named files must lead, got ${top.join(", ")}`);
  for (const file of ["services/event-service.ts", "components/inline-edit/EditableDate.tsx"]) {
    assert.ok(result.data.classifications.requiredOwners.includes(file), `${file} is named, so it must be a required owner`);
  }
  assert.match(result.data.topFiles[0].reasons.join(" | "), /named in the request as `event-service\.ts`/);
});

test("generateImpact ranks the imported definition of a named symbol above an unused duplicate that shares its name", () => {
  const result = generateImpact(overnightRequest, { path: multiLocaleFixture, top: 12 });
  const top = result.data.topFiles.map((file) => file.path);
  const used = top.indexOf("utils/create-event.ts");
  const duplicate = top.indexOf("utils/combineDateAndTime.ts");

  assert.ok(
    used >= 0 && used < duplicate,
    `the definition event-service.ts imports (#${used}) must beat the unused duplicate (#${duplicate}): ${top.join(", ")}`,
  );
  assert.ok(result.data.classifications.requiredOwners.includes("utils/create-event.ts"));
  assert.match(result.data.topFiles[used].reasons.join(" | "), /defines `combineDateAndTime` \(line 1\).*imported by 1 file/);
  assert.ok(top.includes("components/conversational/utils/aiEventSchema.ts"), "a local definition of the named symbol must surface too");
});

test("generateImpact does not score the extension of a named file", () => {
  const result = generateImpact(overnightRequest, { path: multiLocaleFixture, top: 12 });
  for (const file of result.data.topFiles) {
    for (const reason of file.reasons) assert.doesNotMatch(reason, /matches: .*\b(ts|tsx)\b/, `${file.path}: ${reason}`);
  }
});

test("generateImpact demotes a translation catalog for a code request and folds its locales into one entry", () => {
  const result = generateImpact("validate that an overnight event end time is not before the start date", { path: multiLocaleFixture, top: 12 });
  const catalogs = result.data.topFiles.filter((file) => file.kind === "translation");

  assert.ok(catalogs.length <= 1, `one entry per catalog, got ${catalogs.map((file) => file.path).join(", ")}`);
  if (catalogs.length) {
    assert.deepEqual(catalogs[0].siblings, ["messages/en-NG.json", "messages/en-US.json", "messages/fr.json", "messages/pcm-NG.json"]);
    assert.ok(catalogs[0].reasons.some((reason) => reason.startsWith("translation catalog, demoted")));
    const top = result.data.topFiles.map((file) => file.path);
    assert.ok(top.indexOf(catalogs[0].path) > top.indexOf("services/event-service.ts"), "the catalog must rank below the code that owns the rule");
    // Folded locales keep the catalog's role, so changing one is not drift.
    for (const sibling of catalogs[0].siblings) assert.ok(!result.data.classifications.requiredOwners.includes(sibling));
    assert.ok(catalogs[0].siblings.every((sibling) => result.data.classifications.advisoryFiles.includes(sibling)));
  }
});

test("generateImpact keeps a translation catalog at full weight for a copy request, still as one entry", () => {
  const result = generateImpact("fix the wording and translation of the overnight event end time warning", { path: multiLocaleFixture, top: 12 });
  const catalogs = result.data.topFiles.filter((file) => file.kind === "translation");

  assert.equal(catalogs.length, 1, `expected one catalog entry, got ${catalogs.map((file) => file.path).join(", ")}`);
  assert.ok(!catalogs[0].reasons.some((reason) => reason.includes("demoted")), catalogs[0].reasons.join(" | "));
  assert.equal(catalogs[0].siblings?.length, 4);
});

test("generateImpact suggests only tests a runner executes", () => {
  const result = generateImpact("fix the event service date and time validation tests", { path: multiLocaleFixture, top: 12 });
  const suggested = result.data.testSuggestions.filter((line) => line.startsWith("Inspect or run related test"));
  assert.ok(suggested.length > 0, "expected related test suggestions");
  for (const line of suggested) assert.match(line, /\.(test|spec)\.[jt]sx?`$/, line);
});

// --- Regression: three recorded gaps from a real cross-repo review, all in
// the "required owners" ranking (see solumbe's investigation of itself) ---

test("tokenWeightFactor dampens a query term that recurs across most of an indexed repo, and leaves a rare one at full weight", () => {
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: `src/module-${index}/index.ts`,
    kind: "source",
    domain: `module-${index}`,
    exports: index < 15 ? ["ticket"] : [],
    imports: [],
    symbols: [],
  }));
  files[0].exports = [...files[0].exports, "refund"];
  const weightedQuery = weightedQueryTerms("fix the ticket refund flow");

  const stats = computeTokenDocFrequency(files, weightedQuery);
  assert.equal(stats.totalFiles, 20);
  assert.equal(stats.docFreq.get("ticket"), 15, "expected ticket counted in 15/20 files");
  assert.equal(stats.docFreq.get("refund"), 1, "expected refund counted in 1/20 files");
  // 15/20 = 75%: a term that generic gets dampened hard.
  assert.equal(tokenWeightFactor("ticket", stats), 0.2);
  // 1/20 = 5%: a rare, specific term keeps full weight.
  assert.equal(tokenWeightFactor("refund", stats), 1);
  // Below the minimum repo size the signal is too noisy to trust, so every
  // term is neutral — matches context-engine.js's tokenWeightFactor exactly.
  const smallStats = computeTokenDocFrequency(files.slice(0, 5), weightedQuery);
  assert.equal(tokenWeightFactor("ticket", smallStats), 1);
});

test("generateImpact does not let a UI page route require literal API-boundary wording to become a required owner", () => {
  // Recorded gap: "deprecate web scan-ticket page, direct organisers to iOS
  // app download to scan tickets" named no API/route/endpoint word, so the
  // changed, top-scored page.tsx was gated out of requiredOwners entirely and
  // a components that only shared the word "ticket" became "required" instead.
  const root = writeFixture("route-boundary", {
    "package.json": JSON.stringify({ name: "route-fixture", scripts: { test: "node --test" } }),
    "app/dashboard/scan-ticket/page.tsx": ["export default function ScanTicketPage() {", "  return null;", "}", ""].join("\n"),
    "components/TicketBadge.tsx": ["export function TicketBadge() {", "  return null;", "}", ""].join("\n"),
  });

  const result = generateImpact("deprecate the scan ticket page, send organisers to the app store instead", { path: root, top: 10 });
  assert.deepEqual(result.data.classifications.requiredOwners, ["app/dashboard/scan-ticket/page.tsx"]);
  assert.equal(result.data.topFiles[0]?.path, "app/dashboard/scan-ticket/page.tsx");
});

test("generateImpact still gates a NestJS controller/dto behind API-boundary wording", () => {
  // The other half of the same fix: `route` (a UI page) came out of
  // REQUEST_BOUNDARY_KINDS, but `controller`/`dto`/`apiRoute`/`apiClient` (an
  // actual request/response contract) must still require the request to be
  // about that boundary, unchanged from before.
  const root = writeFixture("controller-boundary", {
    "package.json": JSON.stringify({ name: "controller-fixture", scripts: { test: "node --test" } }),
    "src/booking/booking.controller.ts": ["export class BookingController {", "  scanTicket() { return true; }", "}", ""].join("\n"),
  });

  const result = generateImpact("write documentation explaining how ticket scanning works for support staff", { path: root, top: 10 });
  assert.ok(
    !result.data.classifications.requiredOwners.includes("src/booking/booking.controller.ts"),
    "a controller must still need boundary wording to become a required owner",
  );
});

test("generateImpact lets a strong source-kind owner outrank a weaker conventional-kind owner instead of being excluded outright", () => {
  // Recorded gap: the real fix lived in a `*.util.ts` file (kind "source"),
  // but because an unrelated controller also matched the query on the
  // generic word "ticket", the utility file was never even considered —
  // genericOwnerFallback only ran when NO conventional owner kind matched at
  // all, so the weaker, wrong controller became the sole required owner.
  const root = writeFixture("owner-pool-merge", {
    "package.json": JSON.stringify({ name: "merge-fixture", scripts: { test: "node --test" } }),
    "src/booking/utils/ticket-qr.util.ts": [
      "export function parseTicketQrPayload(payload) {",
      "  return payload.replace(/-ticket-\\d+$/, '');",
      "}",
      "export function buildTicketQrPayload(bookingId, ticketNumber) {",
      "  return `${bookingId}-ticket-${ticketNumber}`;",
      "}",
      "",
    ].join("\n"),
    "src/seller/organizer-ticket-sales.controller.ts": ["export class OrganizerTicketSalesController {", "  getTicketSales() { return []; }", "}", ""].join(
      "\n",
    ),
  });

  const result = generateImpact("fix the ticket QR payload suffix parsing so scanning a ticket doesn't fail", { path: root, top: 10 });
  assert.deepEqual(result.data.classifications.requiredOwners, ["src/booking/utils/ticket-qr.util.ts"]);
  assert.ok(
    !result.data.classifications.requiredOwners.includes("src/seller/organizer-ticket-sales.controller.ts"),
    "the weaker, unrelated controller must not also become required",
  );
});

test("generateImpact raises no risk from a domain only an advisory lead touches", () => {
  const root = writeFixture("advisory-risk", {
    "package.json": JSON.stringify({ name: "advisory-risk-fixture" }),
    "app/rsvp/[eventId]/RsvpByEventId.tsx": "export function RsvpByEventId() { return 'rsvp gallery photos'; }\n",
    "app/rsvp/[eventId]/page.tsx": "import { RsvpByEventId } from './RsvpByEventId';\nexport default function Page() { return RsvpByEventId(); }\n",
    "app/rsvp-payment-success/page.tsx": "export default function RsvpPaymentSuccessPage() { return 'paid'; }\n",
  });
  const result = generateImpact("RSVP page should show the event gallery photos", { path: root });
  const advisory = result.data.classifications.advisoryFiles;
  assert.ok(!result.data.classifications.requiredOwners.includes("app/rsvp-payment-success/page.tsx"));
  assert.ok(
    !result.data.risks.some((r) => r.startsWith("Money-flow")),
    `payment page (advisory: ${advisory.includes("app/rsvp-payment-success/page.tsx")}) must not raise money flow: ${result.data.risks.join(" | ")}`,
  );
});

test("generateImpact ranks a configured companion repository only when asked", async () => {
  const { companionLeads, formatImpactMarkdown } = await import("../src/lib/impact.js");
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "impact-companions-")));
  const write = (root, files) => {
    for (const [relative, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    }
  };
  const web = path.join(parent, "web");
  const api = path.join(parent, "api");
  const docs = path.join(parent, "docs");
  write(api, {
    "package.json": JSON.stringify({ name: "api" }),
    "src/paystack/paystack.service.ts": "export class PaystackService { bvnRequired(profile) { return profile.country === 'NG'; } }\n",
  });
  write(docs, { "src/theme.ts": "export const theme = {};\n" });
  write(web, {
    "package.json": JSON.stringify({ name: "web" }),
    ".solumberc.json": JSON.stringify({ companions: ["../api", "../docs", "."] }),
    "src/checkout/bvn-gate.tsx": "export function BvnGate({ location }) { return location.country === 'NG'; }\n",
  });
  const query = "decide when BVN verification is required";

  assert.ok(!("companions" in generateImpact(query, { path: web }).data), "off unless the caller asks");
  const { data, markdown } = generateImpact(query, { path: web, companions: true });
  assert.deepEqual(
    data.companions.map((lead) => lead.repo),
    ["api", "docs"],
    "the repository itself is not its own companion",
  );
  assert.equal(data.companions[0].topFiles[0].path, "src/paystack/paystack.service.ts");
  assert.deepEqual(data.companions[1].topFiles, [], "a companion with nothing scoring is kept, with no files");
  assert.match(markdown, /## Companion Repository Leads\n\n- api: `src\/paystack\/paystack\.service\.ts` \(score [\d.]+[^)]*\)\n- docs: no matching files/);
  assert.equal(formatImpactMarkdown(data), markdown);

  assert.deepEqual(companionLeads(query, api), [], "no .solumberc.json, no leads");
  assert.ok(!("companions" in generateImpact(query, { path: api, companions: true }).data));
  fs.rmSync(parent, { recursive: true });
});
