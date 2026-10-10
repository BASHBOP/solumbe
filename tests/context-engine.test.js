import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AMBIGUOUS_ACTION_QUESTION, compoundPartners, formatContextPackTerminal, generateContextPack, uniqueConcepts } from "../src/lib/context-engine.js";
import { joinedCamelCaseWords } from "../src/lib/code-map/text.js";
import { createRenderer } from "../src/lib/render/fancy.js";

test("generateContextPack returns task-aware files, tests, and commands", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "context-fixture",
      scripts: {
        test: "node --test",
      },
      bin: {
        solumbe: "./src/cli.js",
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, "src", "cli.js"),
    [
      "import { startMcpServer } from './lib/mcp.js';",
      "const commandHandlers = { mcp: startMcpServer };",
      "function handleAgentTools() { return true; }",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "lib", "mcp.js"),
    [
      "const tools = [{ name: 'repo_inspect' }];",
      "export function startMcpServer() { return tools; }",
      "function dispatchTool(name) { return name; }",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "src", "lib", "agent-tools.js"), ["export function getAgentTools() { return { tools: [] }; }", ""].join("\n"));
  fs.writeFileSync(path.join(root, "tests", "mcp.test.js"), ["import test from 'node:test';", "test('mcp tools', () => {});", ""].join("\n"));

  const result = generateContextPack("add a new MCP tool", { path: root });

  assert.equal(result.data.ok, true);
  assert.equal(result.data.intent.action, "add");
  assert.ok(result.data.primaryFiles.some((file) => file.path === "src/lib/mcp.js"));
  const pack = [...result.data.primaryFiles, ...result.data.relatedFiles];
  assert.ok(pack.some((file) => file.path === "src/lib/agent-tools.js"));
  assert.ok(pack.some((file) => file.path === "src/cli.js"));
  assert.ok(result.data.tests.some((file) => file.path === "tests/mcp.test.js"));
  assert.ok(result.data.commands.some((command) => command.command === "npm test"));
  assert.ok(result.data.tokenEstimate.fullJson > 0);
  assert.match(result.markdown, /# Context Pack: add a new MCP tool/);
});

test("generateContextPack gates imports/exports/symbols evidence behind includeEvidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-evidence-"));
  fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "evidence-fixture", scripts: { test: "node --test" } }));
  fs.writeFileSync(
    path.join(root, "src", "lib", "mcp.js"),
    ["import { helper } from './helper.js';", "export function startMcpServer() { return helper(); }", ""].join("\n"),
  );
  fs.writeFileSync(path.join(root, "src", "lib", "helper.js"), ["export function helper() { return 1; }", ""].join("\n"));

  const without = generateContextPack("add a new MCP tool", { path: root });
  for (const file of without.data.primaryFiles) {
    assert.equal(file.imports, undefined, "imports omitted by default");
    assert.equal(file.exports, undefined, "exports omitted by default");
    assert.equal(file.symbols, undefined, "symbols omitted by default");
    // The always-on fields survive.
    assert.ok(typeof file.path === "string");
    assert.ok(typeof file.kind === "string");
    assert.ok(typeof file.score === "number");
    assert.ok(Array.isArray(file.reasons));
  }

  const withEvidence = generateContextPack("add a new MCP tool", { path: root, includeEvidence: true });
  assert.ok(
    withEvidence.data.primaryFiles.some((file) => Array.isArray(file.imports) || Array.isArray(file.exports) || Array.isArray(file.symbols)),
    "includeEvidence:true attaches evidence slices",
  );

  // The default packet's token estimate must reflect the stripped (smaller) payload.
  assert.ok(without.data.tokenEstimate.fullJson < withEvidence.data.tokenEstimate.fullJson);
});

test("generateContextPack falls back to entrypoints and configs when no task keywords match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-fallback-"));
  fs.mkdirSync(path.join(root, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fallback-fixture", scripts: { build: "vite build" } }));
  fs.writeFileSync(path.join(root, "vite.config.ts"), "export default { plugins: [] };\n");
  fs.writeFileSync(path.join(root, "src", "main.tsx"), "import { Layout } from './components/Layout';\nexport function bootstrap() { return Layout; }\n");
  fs.writeFileSync(path.join(root, "src", "App.tsx"), "export function Root() { return null; }\n");
  fs.writeFileSync(path.join(root, "src", "components", "Layout.tsx"), "export function Layout() { return null; }\n");

  const result = generateContextPack("improve SEO, performance, accessibility and content of the portfolio site", { path: root });

  assert.equal(result.data.ok, true);
  assert.ok(result.data.primaryFiles.length > 0, "fallback must produce primary files on a small repo");
  const primaryPaths = result.data.primaryFiles.map((file) => file.path);
  assert.ok(primaryPaths.includes("src/main.tsx"));
  assert.ok(primaryPaths.includes("src/App.tsx"));
  assert.ok(primaryPaths.includes("vite.config.ts"));
  assert.ok(result.data.primaryFiles.every((file) => file.reasons.some((reason) => reason.startsWith("fallback"))));
  assert.ok(result.data.openQuestions.some((question) => question.includes("fall back to repo entrypoints")));
  assert.ok(!result.data.openQuestions.some((question) => question.includes("No strong primary files matched")));
});

test("generateContextPack fallback ranking is deterministic across runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-fallback-det-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fallback-det-fixture" }));
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export function bootstrap() { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "helpers.ts"), "export function helper() { return 2; }\n");

  const first = generateContextPack("polish visual styling", { path: root });
  const second = generateContextPack("polish visual styling", { path: root });

  assert.deepEqual(
    first.data.primaryFiles.map((file) => file.path),
    second.data.primaryFiles.map((file) => file.path),
  );
  assert.equal(first.data.primaryFiles[0].path, "src/main.ts");
});

test("generateContextPack falls back to low-scored matches for narrow symbol queries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-symbol-"));
  fs.mkdirSync(path.join(root, "src", "services"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "symbol-fixture" }));
  fs.writeFileSync(path.join(root, "src", "services", "events-service.ts"), "export function submitRsvp() { return true; }\n");

  const result = generateContextPack("submit rsvp", { path: root });

  assert.equal(result.data.ok, true);
  assert.ok(result.data.primaryFiles.some((file) => file.path === "src/services/events-service.ts"));
});

test("generateContextPack ranks email service methods as hotspots over booking controllers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-hotspots-"));
  fs.mkdirSync(path.join(root, "src", "email"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "booking"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "hotspot-fixture", scripts: { test: "node --test" } }));
  fs.writeFileSync(
    path.join(root, "src", "email", "email.service.ts"),
    [
      "import { Injectable } from '@nestjs/common';",
      "@Injectable()",
      "export class EmailService {",
      "  async sendRsvpConfirmationEmail() {}",
      "  async sendBookingCancellation() {}",
      "  async sendBookingAbandonmentRecovery() {}",
      "  private async resolveEventEmailBranding() {}",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "booking", "booking.controller.ts"),
    [
      "import { Controller, Post } from '@nestjs/common';",
      "@Controller('bookings')",
      "export class BookingController {",
      "  @Post('cancel')",
      "  cancel() {}",
      "  @Post('recover/:id')",
      "  recover() {}",
      "}",
      "",
    ].join("\n"),
  );

  const result = generateContextPack("extend organisation branding to RSVP confirmation booking cancellation abandonment recovery emails", { path: root });

  assert.equal(result.data.contextEngineVersion, 4);
  assert.ok(result.data.primaryFiles.some((file) => file.path === "src/email/email.service.ts"));
  assert.ok(result.data.hotspots.some((item) => item.path === "src/email/email.service.ts" && item.symbol === "resolveEventEmailBranding"));
  assert.ok(result.data.hotspots.some((item) => item.symbol === "sendRsvpConfirmationEmail"));
  assert.match(result.markdown, /## Hotspots/);
});

test("generateContextPack keeps the signup verification auth flow ahead of generic email services", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-auth-flow-"));
  fs.mkdirSync(path.join(root, "src", "authentication"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "email"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "auth-flow-fixture", scripts: { test: "node --test" } }));
  fs.writeFileSync(
    path.join(root, "src", "authentication", "auth.controller.ts"),
    [
      "@Controller('auth')",
      "export class AuthController {",
      "  @Post('register')",
      "  async register() { return this.sendRegistrationOtp(); }",
      "  @Post('validate-otp')",
      "  async validateOtp() { return true; }",
      "  private async sendRegistrationOtp() { return true; }",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "authentication", "auth.service.ts"),
    [
      "export class AuthService {",
      "  async registerUser() { return true; }",
      "  validateOTP() { return true; }",
      "  login() { return 'Please verify your email before logging in'; }",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "src", "email", "email.service.ts"),
    ["export class EmailService {", "  async sendEmail() { return true; }", "  async emailStatus() { return true; }", "}", ""].join("\n"),
  );

  const result = generateContextPack("where is email verification implemented during signup?", { path: root });
  const primaryPaths = result.data.primaryFiles.map((file) => file.path);

  assert.equal(primaryPaths[0], "src/authentication/auth.controller.ts");
  assert.ok(primaryPaths.slice(0, 3).includes("src/authentication/auth.service.ts"));
  assert.ok(result.data.hotspots.some((hotspot) => hotspot.path === "src/authentication/auth.controller.ts" && hotspot.symbol === "sendRegistrationOtp"));

  const terminal = formatContextPackTerminal(result.data, (options) => createRenderer({ ...options, emoji: true, color: true, width: 78 }));
  assert.match(terminal, /solumbe context · repository guide/);
  assert.match(terminal, /🔥 Start here/);
  assert.match(terminal, /🥇 Primary files/);
  assert.match(terminal, /POST register/);
  assert.ok(terminal.includes("\x1b[36m") || terminal.includes("\x1b[1m"));
  assert.doesNotMatch(terminal, /# Context Pack:/);
});

test("generateContextPack routes a plain-language QR check-in question to its controller hotspot", () => {
  const root = path.resolve("evals/fixtures/checkin-api");
  const result = generateContextPack("where is QR booking check-in handled for event staff?", { path: root });

  assert.equal(result.data.primaryFiles[0].path, "src/booking/ticket.controller.ts");
  assert.ok(result.data.hotspots.some((hotspot) => hotspot.path === "src/booking/ticket.controller.ts" && hotspot.symbol === "scanTicket"));
});

test("generateContextPack keeps the RSVP privacy configuration control in the top three", () => {
  const root = path.resolve("evals/fixtures/rsvp-configuration-web");
  const result = generateContextPack("where do organisers configure the RSVP page to keep venue details private?", { path: root });

  const primaryPaths = result.data.primaryFiles.slice(0, 3).map((file) => file.path);
  assert.ok(primaryPaths.includes("components/conversational/questions/RsvpStudioQuestion.tsx"));
});

test("generateContextPack keeps the mobile host screen and RSVP screen ahead of type declarations", () => {
  const root = path.resolve("evals/fixtures/mobile-host-rsvp");
  const result = generateContextPack("where does the mobile app show an event host bio and let an attendee RSVP?", { path: root });
  const primaryPaths = result.data.primaryFiles.slice(0, 2).map((file) => file.path);

  assert.deepEqual(primaryPaths, ["app/(tabs)/explore/[id].tsx", "app/rsvp/[eventId].tsx"]);
  assert.ok(result.data.hotspots.some((hotspot) => hotspot.path === "app/(tabs)/explore/[id].tsx" && hotspot.symbol === "HostCard"));
});

test("generateContextPack keeps an explicit Handlebars message template beside its campaign service", () => {
  const root = path.resolve("evals/fixtures/campaign-email");
  const result = generateContextPack("where is the branded campaign email Handlebars template rendered?", { path: root });

  assert.equal(result.data.contextEngineVersion, 4);
  const primaryPaths = result.data.primaryFiles.slice(0, 3).map((file) => file.path);
  assert.ok(primaryPaths.includes("src/email/template/campaign-message-responsive.hbs"));
  assert.ok(primaryPaths.includes("src/audience/campaign.service.ts"));
});

// Regression for a field-tracing query where "date" and "booking" recur across
// many unrelated files: Hotspots/Primary Files must surface the files that
// literally reference the compound field (dateOfBirth), not files that merely
// share one or two generic single-token overlaps with the query.
test("generateContextPack surfaces literal dateOfBirth references over generic date/booking token overlap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-dob-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "sample-events-app", scripts: { test: "node --test" } }));

  const write = (relPath, content) => {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  // Generic "date"/"booking" noise - these are the exact kind of false
  // positives reported: symbols and paths that share single generic tokens
  // ("date", "booking") with the query but have nothing to do with DOB.
  write("src/booking/booking-helpers.ts", "export function formatBookingDate(date: string) { return date; }\n");
  write("src/booking/event-types.ts", "export interface SelectedBookingDate { date: string; bookingId: string }\n");
  write("src/booking/booking-api.ts", "export interface BookingApiResponse { bookingDate: string; checkoutDate: string; bookingId: string }\n");
  write(
    "src/booking/booking.controller.ts",
    ["export class BookingController {", "  updateBookingDate() { return true; }", "  cancelBooking() { return true; }", "}", ""].join("\n"),
  );
  write("src/booking/booking.service.ts", ["export class BookingService {", "  rescheduleBookingDate() { return true; }", "}", ""].join("\n"));
  write("src/booking/booking-summary.ts", "export function summarizeBookingDate(date: string) { return date; }\n");
  write("src/checkout/checkout-date-picker.tsx", "export function CheckoutDatePicker() { return null; }\n");
  write("src/checkout/checkout.service.ts", ["export class CheckoutService {", "  getCheckoutDate() { return new Date(); }", "}", ""].join("\n"));
  write("src/event/event-date-utils.ts", "export function formatEventDate(date: string) { return date; }\n");
  write("src/event/event-scheduler.ts", "export function scheduleEventDate(date: string) { return date; }\n");

  // Unrelated filler across other domains so document-frequency ratios reflect
  // a repo (like the ~1728-file one in the report) where "date"/"booking" are
  // common but "birth" is rare.
  const fillerDomains = ["payments", "notifications", "profile", "media", "search", "auth", "venue", "rsvp", "analytics", "settings", "api"];
  fillerDomains.forEach((domain, index) => {
    write(`src/${domain}/${domain}-service-${index}.ts`, `export function run${domain[0].toUpperCase()}${domain.slice(1)}Task${index}() { return true; }\n`);
    write(`src/${domain}/${domain}-helper-${index}.ts`, `export function support${domain[0].toUpperCase()}${domain.slice(1)}Task${index}() { return true; }\n`);
  });

  // The files that actually collect date of birth.
  write(
    "src/utils/age-assurance.ts",
    ["export function isValidDateOfBirth(dateOfBirth: string): boolean {", "  return Boolean(dateOfBirth);", "}", ""].join("\n"),
  );
  write(
    "app/signup/SignUpPageClient.tsx",
    [
      "import { useForm } from 'react-hook-form';",
      "export function SignUpPageClient() {",
      "  const { register } = useForm();",
      "  const dateOfBirth = register('dateOfBirth');",
      "  return dateOfBirth;",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "app/signup/parentalConsent.ts",
    [
      "export function requiresParentalConsent(input: { dateOfBirth: string }) {",
      "  const dateOfBirth = input.dateOfBirth;",
      "  return Boolean(dateOfBirth);",
      "}",
      "",
    ].join("\n"),
  );
  write("components/settings/account-privacy-defaults.ts", "export const dateOfBirthVisibility = 'private';\n");

  const query =
    "Why do we collect date of birth from every attendee? Find all places DOB/age is collected in signup, checkout, ticket booking, and attendee forms.";
  const result = generateContextPack(query, { path: root });

  const dobPaths = [
    "src/utils/age-assurance.ts",
    "app/signup/SignUpPageClient.tsx",
    "app/signup/parentalConsent.ts",
    "components/settings/account-privacy-defaults.ts",
  ];
  const genericBookingDatePaths = ["src/booking/booking-helpers.ts", "src/booking/event-types.ts", "src/booking/booking-api.ts"];

  const allFiles = [...result.data.primaryFiles, ...result.data.relatedFiles];
  const scoreOf = (filePath) => allFiles.find((file) => file.path === filePath)?.score ?? 0;

  // The literal dateOfBirth identifier must outrank files that only share a
  // generic single token ("date"/"booking") with the query.
  for (const dobPath of dobPaths) {
    for (const genericPath of genericBookingDatePaths) {
      assert.ok(
        scoreOf(dobPath) > scoreOf(genericPath),
        `${dobPath} (score ${scoreOf(dobPath)}) should outrank ${genericPath} (score ${scoreOf(genericPath)})`,
      );
    }
  }

  // None of the reported false positives should lead Primary Files.
  const primaryPaths = result.data.primaryFiles.map((file) => file.path);
  assert.ok(!genericBookingDatePaths.includes(primaryPaths[0]), `expected a DOB file first, got ${primaryPaths[0]}`);
  assert.ok(dobPaths.includes(primaryPaths[0]));

  // The real hotspot (isValidDateOfBirth) must rank above the reported false
  // positive hotspots (formatBookingDate / SelectedBookingDate).
  const hotspotScore = (symbol) => result.data.hotspots.find((hotspot) => hotspot.symbol === symbol)?.score ?? -1;
  assert.ok(hotspotScore("isValidDateOfBirth") >= 0, "isValidDateOfBirth should appear as a hotspot");
  assert.ok(hotspotScore("isValidDateOfBirth") > hotspotScore("formatBookingDate"));
  assert.ok(!result.data.hotspots.some((hotspot) => hotspot.symbol === "SelectedBookingDate"));
});

test("generateContextPack reports the live working tree, not the one the cached index saw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-live-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "live-git-fixture" }));
  fs.writeFileSync(path.join(root, "src", "billing.js"), "export function chargeCard() { return true; }\n");
  git("add", ".");
  git("commit", "-qm", "init");

  // Index while a tracked file is modified, then commit it. Committing changes
  // no file's size or mtime, so the index fingerprint, and the cached map, stay
  // the same while the working tree goes from dirty to clean.
  fs.writeFileSync(path.join(root, "src", "billing.js"), "export function chargeCard() { return false; }\n");
  const dirty = generateContextPack("charge card billing", { path: root });
  assert.ok(dirty.data.conflicts.some((c) => c.includes("1 uncommitted git change")));

  git("commit", "-qam", "change");
  const clean = generateContextPack("charge card billing", { path: root });
  assert.deepEqual(clean.data.conflicts, []);
  assert.equal(clean.data.repos[0].git.clean, true);
});

// Regressions from the bashbop-event-web review (2026-09-27); see the
// multi-locale-web fixture in tests/impact.test.js.
const multiLocaleFixture = path.resolve("evals/fixtures/multi-locale-web");

test("generateContextPack keeps translation keys out of the hotspots and the catalog to one slot for a git request", () => {
  const result = generateContextPack("PR 588 merged - verify merge state, sync local main branch, check CI on main after merge", {
    path: multiLocaleFixture,
    limit: 6,
  });
  const listed = [...result.data.primaryFiles, ...result.data.relatedFiles];

  assert.ok(listed.filter((file) => file.kind === "translation").length <= 1, listed.map((file) => file.path).join(", "));
  assert.equal(result.data.primaryFiles[0].path, ".github/workflows/main-branch-checks.yml");
  // `mainBanner`, `addMainImage` and the rest share one word, `main`, with the request.
  const catalogHotspots = result.data.hotspots.filter((hotspot) => hotspot.kind === "translation");
  assert.ok(
    catalogHotspots.every((hotspot) => new Set(hotspot.matchedTokens).size >= 2),
    catalogHotspots.map((hotspot) => hotspot.symbol).join(", "),
  );
  assert.ok(result.data.hotspots[0]?.kind !== "translation", "a catalog key must not lead the hotspots");
});

test("generateContextPack folds a catalog's locales into one entry that names them", () => {
  const result = generateContextPack("fix the wording of the overnight event end time copy", { path: multiLocaleFixture, limit: 6 });
  const catalogs = [...result.data.primaryFiles, ...result.data.relatedFiles].filter((file) => file.kind === "translation");

  assert.equal(catalogs.length, 1, catalogs.map((file) => file.path).join(", "));
  assert.deepEqual(catalogs[0].siblings, ["messages/en-NG.json", "messages/en-US.json", "messages/fr.json", "messages/pcm-NG.json"]);
  assert.ok(catalogs[0].reasons.includes("locale catalog, also en-NG, en-US, fr, pcm-NG"), catalogs[0].reasons.join(", "));
  assert.ok(!catalogs[0].reasons.includes("translation catalog, demoted"), "a copy request must not demote the catalog");
});

test("generateContextPack leads with named files and the named symbol's imported definition", () => {
  const result = generateContextPack(
    "fix overnight event bug: combineDateAndTime doesn't roll over; event-service.ts only compares getHours; EditableDate.tsx blocks overnight ranges",
    { path: multiLocaleFixture },
  );
  const primary = result.data.primaryFiles.map((file) => file.path);

  assert.deepEqual(primary.slice(0, 3), ["services/event-service.ts", "components/inline-edit/EditableDate.tsx", "utils/create-event.ts"], primary.join(", "));
  assert.ok(primary.indexOf("utils/create-event.ts") < primary.indexOf("utils/combineDateAndTime.ts") || !primary.includes("utils/combineDateAndTime.ts"));
  assert.equal(result.data.hotspots[0]?.symbol, "combineDateAndTime");
  assert.equal(result.data.hotspots[0]?.path, "utils/create-event.ts");
  assert.ok(!result.data.intent.topics.includes("ts") && !result.data.intent.topics.includes("tsx"), result.data.intent.topics.join(", "));
});

test("generateContextPack lists only runnable tests, never notes or snapshots under __tests__", () => {
  const result = generateContextPack("review event date and time validation tests for overnight events", { path: multiLocaleFixture });
  const tests = result.data.tests.map((file) => file.path);

  assert.ok(tests.length > 0, "expected tests");
  for (const file of tests) assert.match(file, /\.(test|spec)\.[jt]sx?$/, file);
});

test("generateContextPack puts a named test note in Primary Files rather than dropping it", () => {
  const result = generateContextPack("update __tests__/TEST_SUITE_SUMMARY.md for the overnight tests", { path: multiLocaleFixture });
  assert.equal(result.data.primaryFiles[0]?.path, "__tests__/TEST_SUITE_SUMMARY.md");
  assert.ok(!result.data.tests.some((file) => file.path.endsWith(".md")));
});

// --- Regression: "review/debug bugs" queries with no action verb, and a
// multi-repo request naming one repo by a word from its own folder name ---
// Recorded gap: `solumbe context "ticket scanning (QR check-in) and date/time
// display formatting bugs in the mobile app"` across [mobile, api] repos came
// back with intent "unknown", the ambiguous-action open question, and primary
// files almost entirely from the larger API repo even though the request said
// "in the mobile app".

test("generateContextPack infers a debug intent from bug-report language that names no action verb", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-bugreport-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bugreport-fixture", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "scanner.ts"), "export function scanTicket(code) { return code; }\n");

  const result = generateContextPack("ticket scanning (QR check-in) and date/time display formatting bugs", { path: root });

  assert.equal(result.data.intent.action, "debug", JSON.stringify(result.data.intent));
  assert.ok(!result.data.openQuestions.includes(AMBIGUOUS_ACTION_QUESTION), result.data.openQuestions.join(" | "));

  fs.rmSync(root, { recursive: true, force: true });
});

test("generateContextPack still reports an unknown intent when the request names neither a verb nor a bug word", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-noaction-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "noaction-fixture", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "scanner.ts"), "export function scanTicket(code) { return code; }\n");

  const result = generateContextPack("ticket scanner", { path: root });

  assert.equal(result.data.intent.action, "unknown", JSON.stringify(result.data.intent));
  assert.ok(result.data.openQuestions.includes(AMBIGUOUS_ACTION_QUESTION), result.data.openQuestions.join(" | "));

  fs.rmSync(root, { recursive: true, force: true });
});

test("generateContextPack boosts the repo a multi-repo request names by a word from its own folder name", () => {
  // repoA's folder is named "...mobile-fixture-<rand>" — "mobile" is a
  // discriminating segment repoB's folder does not share (both share "app"
  // and "fixture", which is why those two are not enough on their own).
  const repoA = fs.mkdtempSync(path.join(os.tmpdir(), "app-mobile-fixture-"));
  fs.writeFileSync(path.join(repoA, "package.json"), JSON.stringify({ name: "mobile-fixture", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(repoA, "lib"), { recursive: true });
  fs.writeFileSync(path.join(repoA, "lib", "scan-ticket.ts"), "export function scanTicket(code) {\n  return code;\n}\n");

  const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "app-api-fixture-"));
  fs.writeFileSync(path.join(repoB, "package.json"), JSON.stringify({ name: "api-fixture", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(repoB, "src", "ticket"), { recursive: true });
  fs.writeFileSync(
    path.join(repoB, "src", "ticket", "ticket-scan-reports.controller.ts"),
    ["export class TicketScanReportsController {", "  scanTicket() { return true; }", "}", ""].join("\n"),
  );

  // Unhinted control: repoB's file is the intrinsically stronger match (more
  // fields — path, domain, symbol — repeat "ticket"/"scan") and leads on its
  // own merits when the request names no repo.
  const unhinted = generateContextPack("fix ticket scan bugs", { paths: [repoA, repoB], limit: 8 });
  assert.equal(unhinted.data.primaryFiles[0]?.repo.root, repoB, unhinted.data.primaryFiles.map((f) => f.path).join(", "));

  // Naming "the mobile app" in an otherwise identical request must not be
  // silently discarded: repoA's weaker file should now lead, and its reasons
  // should say why.
  const hinted = generateContextPack("fix ticket scan bugs in the mobile app", { paths: [repoA, repoB], limit: 8 });
  assert.equal(hinted.data.primaryFiles[0]?.repo.root, repoA, hinted.data.primaryFiles.map((f) => f.path).join(", "));
  assert.ok(hinted.data.primaryFiles[0]?.reasons.includes("repo named in request"), hinted.data.primaryFiles[0]?.reasons.join(", "));
  const otherRepoFile = hinted.data.primaryFiles.find((f) => f.repo.root === repoB);
  assert.ok(otherRepoFile?.reasons.includes("a different repo than the one named in the request"), otherRepoFile?.reasons.join(", "));

  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

test("generateContextPack does not apply a repo hint for a single-repo request", () => {
  // computeRepoHints only has anything to discriminate between across 2+
  // repos; a single-repo call must score exactly as it did before the fix,
  // whether or not the query happens to contain a word from the repo's own
  // folder name.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "app-mobile-fixture-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "mobile-fixture", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "scan-ticket.ts"), "export function scanTicket(code) {\n  return code;\n}\n");

  const result = generateContextPack("fix ticket scan bugs in the mobile app", { path: root });
  const file = result.data.primaryFiles.find((f) => f.path === "lib/scan-ticket.ts");
  assert.ok(file, result.data.primaryFiles.map((f) => f.path).join(", "));
  assert.ok(!file.reasons.includes("repo named in request"), file.reasons.join(", "));

  fs.rmSync(root, { recursive: true, force: true });
});

// Regression (dogfood, bashbop-api + bashbop-go): a request about the Go fee
// service named it ("the Go fee server"), but a two-letter folder segment was
// never a hint, and the 1,000-file API filled every primary slot.
test("generateContextPack names a repo by a capitalised short segment and keeps a slot for each repo", () => {
  const big = fs.mkdtempSync(path.join(os.tmpdir(), "shop-api-"));
  fs.writeFileSync(path.join(big, "package.json"), JSON.stringify({ name: "api", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(big, "src", "fees"), { recursive: true });
  for (const name of ["fee-calculator", "fee-shadow", "fee-config", "fee-report", "fee-export", "fee-audit"]) {
    fs.writeFileSync(path.join(big, "src", "fees", `${name}.service.ts`), `export class FeeServer${name.length} { fees() { return "fee server"; } }\n`);
  }
  const small = fs.mkdtempSync(path.join(os.tmpdir(), "shop-go-"));
  fs.writeFileSync(path.join(small, "go.mod"), "module example.com/fees\n");
  fs.mkdirSync(path.join(small, "cmd", "fees"), { recursive: true });
  fs.writeFileSync(path.join(small, "cmd", "fees", "main.go"), "package main\n\n// Fee server.\nfunc serveFees() {}\n");

  const pack = generateContextPack("rename the Go fee server", { paths: [big, small], limit: 5 });
  const primaryRepos = pack.data.primaryFiles.map((file) => file.repo.root);
  assert.ok(primaryRepos.includes(small), pack.data.primaryFiles.map((f) => `${f.repo.name}:${f.path}`).join(", "));

  const lowercase = generateContextPack("go rename the fee server", { paths: [big, small], limit: 5 });
  assert.ok(!lowercase.data.primaryFiles.some((file) => file.reasons.includes("repo named in request")));

  fs.rmSync(big, { recursive: true, force: true });
  fs.rmSync(small, { recursive: true, force: true });
});

// Regression (dogfood): "dogfood solumbe by reviewing bashbop" came back with
// intent "unknown" because only the bare verb "review" counted.
test("generateContextPack reads an inflected action word as the intent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intent-inflect-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "intent", scripts: { test: "node --test" } }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "payout.ts"), "export function payout() { return 1; }\n");

  for (const [query, action] of [
    ["reviewing the payout change", "review"],
    ["fixed payout rounding", "fix"],
    ["creating a payout export", "create"],
    ["debugging payouts", "debug"],
    ["rename the payout helper", "rename"],
  ]) {
    const pack = generateContextPack(query, { path: root, limit: 3 });
    assert.equal(pack.data.intent.action, action, query);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const telemetryFixture = path.resolve("evals/fixtures/telemetry-web");
const replayErrorsQuery =
  "session replay / session playback for critical user errors: error tracking, Sentry, PostHog, monitoring, error boundary, global error handler";
const openPanelQuery = "add session replay to the OpenPanel analytics provider";

test("uniqueConcepts counts a repeated word or its plural once, keeping the plural", () => {
  assert.deepEqual(uniqueConcepts(["session", "replay", "session", "error", "errors", "error"]), ["session", "replay", "errors"]);
  assert.deepEqual(uniqueConcepts(["check", "checkin", "qr", "ticket"]), ["check", "checkin", "qr", "ticket"]);
});

test("compoundPartners ties the words of a camelCase name together unless the request also uses them alone", () => {
  assert.deepEqual(Object.fromEntries(compoundPartners("add OpenPanel and PostHog")), {
    open: ["panel"],
    panel: ["open"],
    post: ["hog"],
    hog: ["post"],
  });
  assert.deepEqual(Object.fromEntries(compoundPartners("open the OpenPanel panel")), {});
});

test("joinedCamelCaseWords joins each camelCase word of a request, and nothing else", () => {
  assert.deepEqual(joinedCamelCaseWords("add OpenPanel and PostHog to the open panel"), ["openpanel", "posthog"]);
  assert.deepEqual(joinedCamelCaseWords("track ticket scans"), []);
});

test("generateContextPack reaches a file named with the joined spelling of a camelCase name", () => {
  // The bashbop-mobile-app request of 2026-10-08: the OpenPanel client lives in
  // `lib/openpanel.ts`, one joined word, and ranked behind files matching one
  // other word of the request.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-context-joined-"));
  const files = {
    "package.json": JSON.stringify({ name: "joined-fixture", private: true }),
    "lib/openpanel.ts":
      "import { createClient } from '@openpanel/sdk';\n\nexport const client = createClient();\n\nexport function trackTimelineEvent(name: string) {\n  client.track(name);\n}\n",
    "hooks/useScanner.ts":
      "export function trackScan(result: string) {\n  return result;\n}\n\nexport function useScanner() {\n  return { scanTicket: (code: string) => trackScan(code) };\n}\n",
    "hooks/useGuests.ts": "export function useCheckInGuest() {\n  return { checkInGuest: (guestId: string) => guestId };\n}\n",
    "contexts/AuthContext.tsx": "export function useSignedInAccount() {\n  return { account: null };\n}\n",
    "components/FilterPanel.tsx": "export function FilterPanel({ open }: { open: boolean }) {\n  return open ? 'filters' : null;\n}\n",
    "lib/deeplinks.ts": "export function openTicketLink(id: string) {\n  return `app://tickets/${id}`;\n}\n",
  };
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }

  const pack = generateContextPack("identify the signed-in account in OpenPanel and track ticket scans and guest check-ins", { path: root });
  const ranked = pack.data.primaryFiles.map((/** @type {{ path: string }} */ file) => file.path);

  assert.ok(ranked.indexOf("lib/openpanel.ts") >= 0 && ranked.indexOf("lib/openpanel.ts") < ranked.indexOf("hooks/useGuests.ts"), ranked.join(", "));
  fs.rmSync(root, { recursive: true, force: true });
});

test("generateContextPack scores a word the request repeats once per hotspot", () => {
  const pack = generateContextPack(replayErrorsQuery, { path: telemetryFixture });
  for (const hotspot of pack.data.hotspots) {
    assert.equal(new Set(hotspot.matchedTokens).size, hotspot.matchedTokens.length, `${hotspot.symbol}: ${hotspot.matchedTokens}`);
  }
  assert.deepEqual(
    pack.data.primaryFiles
      .slice(0, 2)
      .map((file) => file.path)
      .sort(),
    ["app/global-error.tsx", "components/common/ErrorBoundary.tsx"],
  );
});

test("generateContextPack does not match one word of a camelCase name on its own", () => {
  const errors = generateContextPack(replayErrorsQuery, { path: telemetryFixture });
  assert.ok(!errors.data.hotspots.some((hotspot) => hotspot.matchedTokens.includes("post")), "post from PostHog matched alone");

  const openPanel = generateContextPack(openPanelQuery, { path: telemetryFixture });
  const symbols = openPanel.data.hotspots.map((hotspot) => hotspot.symbol);
  assert.ok(symbols.includes("OpenPanelProvider"), symbols.join(", "));
  for (const decoy of ["OpenHouseCard", "createVendorSubscriptionCheckout", "StreamAnalyticsPanel"]) {
    const hotspot = openPanel.data.hotspots.find((item) => item.symbol === decoy);
    assert.ok(!hotspot?.matchedTokens.includes("open") && !hotspot?.matchedTokens.includes("panel"), `${decoy}: ${hotspot?.matchedTokens}`);
  }
});

test("generateContextPack counts the action verb only in a symbol's own name", () => {
  const pack = generateContextPack("add a completed session flag", { path: telemetryFixture });
  const completed = pack.data.hotspots.find((hotspot) => hotspot.symbol === "handleCheckoutSessionCompleted");
  assert.ok(completed, pack.data.hotspots.map((hotspot) => hotspot.symbol).join(", "));
  assert.ok(!completed.matchedTokens.includes("add"), `add matched the addOnIds variable: ${completed.matchedTokens}`);

  const openPanel = generateContextPack(openPanelQuery, { path: telemetryFixture });
  assert.ok(!openPanel.data.primaryFiles.some((file) => file.path === "services/seller-checkout.ts"));
});
