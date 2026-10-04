import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK_FLAGS,
  classifyPath,
  conceptsFromQuery,
  glyphFor,
  isDocPath,
  isGateRiskPath,
  isProseFile,
  isSecretPath,
  isTestDataPath,
  matchRiskPaths,
  matchSecretPaths,
  singularizeToken,
} from "../src/lib/risk-paths.js";

test("classifyPath flags auth/security paths by substring", () => {
  const flags = classifyPath("src/authentication/session.ts");
  assert.ok(flags.includes(RISK_FLAGS.authSecurity), `expected auth flag, got ${flags.join(", ")}`);
});

test("classifyPath flags money flow from stripe path", () => {
  const flags = classifyPath("src/payment/processors/stripe.processor.ts");
  assert.ok(flags.includes(RISK_FLAGS.moneyFlow));
});

test("classifyPath flags data model from prisma schema path", () => {
  const flags = classifyPath("prisma/schema.prisma");
  assert.ok(flags.includes(RISK_FLAGS.dataModel));
});

test("classifyPath promotes controller kind to request surface", () => {
  const flags = classifyPath("src/booking/booking.controller.ts", { kind: "controller" });
  assert.ok(flags.includes(RISK_FLAGS.requestSurface));
});

test("classifyPath adds large file diff flag at threshold", () => {
  const flags = classifyPath("src/booking/booking.controller.ts", { additions: 200, deletions: 100 });
  assert.ok(flags.includes(RISK_FLAGS.largeFileDiff));
});

test("classifyPath stays empty for unmatched plain source", () => {
  const flags = classifyPath("src/utils/format-date.ts");
  assert.deepEqual(flags, []);
});

test("isSecretPath matches .env and credential paths", () => {
  assert.equal(isSecretPath(".env.local"), true);
  assert.equal(isSecretPath("credentials/google.json"), true);
  assert.equal(isSecretPath("certs/private-key.pem"), true);
  assert.equal(isSecretPath("src/index.ts"), false);
});

test("isSecretPath leaves committed env templates to the content scan", () => {
  for (const file of [".env.example", ".env.sample", ".env.template", "apps/api/.env.dist"]) {
    assert.equal(isSecretPath(file), false, file);
  }
  assert.equal(isSecretPath(".env.production"), true);
  assert.equal(isSecretPath(".env.example.local"), true);
});

test("matchSecretPaths and matchRiskPaths filter cleanly", () => {
  const paths = [".env", "src/payment/stripe.ts", "src/util/date.ts", "prisma/schema.prisma"];
  assert.deepEqual(matchSecretPaths(paths), [".env"]);
  const risky = matchRiskPaths(paths);
  assert.ok(risky.includes("src/payment/stripe.ts"));
  assert.ok(risky.includes("prisma/schema.prisma"));
  assert.ok(!risky.includes("src/util/date.ts"));
});

test("conceptsFromQuery infers auth from Apple sign-in", () => {
  const flags = conceptsFromQuery("fix Apple sign-in token validation");
  assert.ok(flags.includes(RISK_FLAGS.authSecurity), `expected auth, got ${flags.join(", ")}`);
});

test("conceptsFromQuery infers money flow from refund request", () => {
  const flags = conceptsFromQuery("add Stripe refunds to bookings");
  assert.ok(flags.includes(RISK_FLAGS.moneyFlow));
});

test("conceptsFromQuery returns empty when no concept matches", () => {
  const flags = conceptsFromQuery("rename the foo variable to bar");
  assert.deepEqual(flags, []);
});

test("glyphFor returns the right emoji and empty for unknown", () => {
  assert.equal(glyphFor(RISK_FLAGS.authSecurity), "🔐");
  assert.equal(glyphFor(RISK_FLAGS.moneyFlow), "💳");
  assert.equal(glyphFor("not-a-flag"), "");
});

// --- Finding #1: conceptsFromQuery whole-token matching (no substring leaks) ---

test("conceptsFromQuery does not infer money flow from 'payload' (substring 'pay')", () => {
  const flags = conceptsFromQuery("fix payload parsing");
  assert.ok(!flags.includes(RISK_FLAGS.moneyFlow), `payload should not imply money flow, got ${flags.join(", ")}`);
});

test("conceptsFromQuery does not infer data model from 'feedback' (substring 'db')", () => {
  const flags = conceptsFromQuery("improve feedback widget");
  assert.ok(!flags.includes(RISK_FLAGS.dataModel), `feedback should not imply data model, got ${flags.join(", ")}`);
});

test("conceptsFromQuery does not infer configuration from 'pricing' (substring 'ci')", () => {
  const flags = conceptsFromQuery("fix pricing display");
  assert.ok(!flags.includes(RISK_FLAGS.configuration), `pricing should not imply configuration, got ${flags.join(", ")}`);
});

test("conceptsFromQuery does not infer auth from a bare 'apple' (emoji, not sign-in)", () => {
  const flags = conceptsFromQuery("add apple emoji to fruit picker");
  assert.ok(!flags.includes(RISK_FLAGS.authSecurity), `apple emoji should not imply auth, got ${flags.join(", ")}`);
});

test("conceptsFromQuery still infers auth from the 'apple sign-in' phrase", () => {
  assert.ok(conceptsFromQuery("add apple sign-in support").includes(RISK_FLAGS.authSecurity));
  assert.ok(conceptsFromQuery("let users sign in with google").includes(RISK_FLAGS.authSecurity));
});

test("conceptsFromQuery matches the bare whole-word 'pay' but not 'payload'", () => {
  assert.ok(conceptsFromQuery("split the pay between vendors").includes(RISK_FLAGS.moneyFlow));
  assert.ok(!conceptsFromQuery("decode the request payload").includes(RISK_FLAGS.moneyFlow));
});

// --- Finding #2: classifyPath singularizes path tokens ---

test("classifyPath flags auth/security for singular/plural security path tokens", () => {
  assert.ok(classifyPath("src/authentication/roles.guard.ts").includes(RISK_FLAGS.authSecurity), "roles.guard.ts should be auth");
  assert.ok(classifyPath("src/sessions/sessions.service.ts").includes(RISK_FLAGS.authSecurity), "sessions.service.ts should be auth");
  assert.ok(classifyPath("src/auth/permissions.guard.ts").includes(RISK_FLAGS.authSecurity), "permissions.guard.ts should be auth");
});

test("singularizeToken folds common plurals but leaves short/ss words alone", () => {
  assert.equal(singularizeToken("roles"), "role");
  assert.equal(singularizeToken("sessions"), "session");
  assert.equal(singularizeToken("policies"), "policy");
  assert.equal(singularizeToken("classes"), "class");
  assert.equal(singularizeToken("css"), "css");
  assert.equal(singularizeToken("api"), "api");
});

// --- Finding #6 support: ambiguous 'token' must not fold a generic plural ---

test("classifyPath does not flag a generic tokens.js as auth/security", () => {
  const flags = classifyPath("src/lib/tokens.js");
  assert.ok(!flags.includes(RISK_FLAGS.authSecurity), `tokens.js should not be auth, got ${flags.join(", ")}`);
});

test("classifyPath still flags a literal token.service.ts as auth/security", () => {
  assert.ok(classifyPath("src/auth/token.service.ts").includes(RISK_FLAGS.authSecurity));
});

test("isProseFile reads the code map kind when the caller has one", () => {
  // `doc`, `skill` and `changelog` are all edited as English. None of them
  // executes, so none can carry the risk its subject matter names.
  assert.equal(isProseFile("docs/AUTH_TOKEN_VALIDATION.md", "doc"), true);
  assert.equal(isProseFile("skills/session-helper/SKILL.md", "skill"), true);
  assert.equal(isProseFile("CHANGELOG.md", "changelog"), true);
  assert.equal(isProseFile("src/auth/session.service.ts", "service"), false);
});

test("a known non-prose kind keeps its flags even under docs/", () => {
  // The kind is more precise than the path: real SQL that happens to live
  // under `docs/` is still a data-model change. The path-shape fallback, which
  // the merge gates have always used, cannot make this distinction.
  assert.equal(isProseFile("docs/api/payment-schema.sql", "source"), false);
  assert.equal(isProseFile("docs/api/payment-schema.sql"), true);
});

test("isProseFile falls back to the path when no kind is available", () => {
  assert.equal(isProseFile("docs/AUTH_TOKEN_VALIDATION.md"), true);
  assert.equal(isProseFile("auth-guide.md"), true);
  assert.equal(isProseFile("src/auth/session.service.ts"), false);
});

// --- Finding #3: gate-facing matcher ignores tests and docs ---

test("isGateRiskPath ignores test files even when the name looks risky", () => {
  assert.equal(isGateRiskPath("tests/checkout.spec.ts"), false);
  assert.equal(isGateRiskPath("src/payment/__tests__/refund.test.ts"), false);
});

test("isGateRiskPath ignores documentation files even when the name looks risky", () => {
  assert.equal(isGateRiskPath("docs/git-checkout-guide.md"), false);
  assert.equal(isGateRiskPath("docs/auth-and-sessions.md"), false);
});

test("isGateRiskPath still flags real risk-sensitive implementation paths", () => {
  assert.equal(isGateRiskPath("src/payment/payment.service.ts"), true);
  assert.equal(isGateRiskPath("src/authentication/session.ts"), true);
});

test("matchRiskPaths gate mode filters tests/docs but default mode reports them", () => {
  const paths = ["tests/checkout.spec.ts", "docs/git-checkout-guide.md", "src/payment/stripe.ts"];
  assert.deepEqual(matchRiskPaths(paths, { gate: true }), ["src/payment/stripe.ts"]);
  const reported = matchRiskPaths(paths);
  assert.ok(reported.includes("src/payment/stripe.ts"));
  assert.ok(reported.includes("tests/checkout.spec.ts"), "default (non-gate) mode still reports the test path for ranking");
});

test("isDocPath recognizes markdown and docs directories", () => {
  assert.equal(isDocPath("README.md"), true);
  assert.equal(isDocPath("docs/anything.txt"), true);
  assert.equal(isDocPath("documentation/guide.rst"), true);
  assert.equal(isDocPath("src/index.ts"), false);
});

// --- Finding #4: tightened secret-path detection (basename/segment semantics) ---

test("isSecretPath does not flag a source file that merely contains '.env' as a substring", () => {
  assert.equal(isSecretPath("src/config/dev.environments.ts"), false);
});

test("isSecretPath does not flag documentation about secrets", () => {
  assert.equal(isSecretPath("docs/secrets-management.md"), false);
});

test("isSecretPath flags real secret/credential file-name patterns", () => {
  assert.equal(isSecretPath(".env"), true);
  assert.equal(isSecretPath(".env.production"), true);
  assert.equal(isSecretPath("config/.env.local"), true);
  assert.equal(isSecretPath("certs/server.pem"), true);
  assert.equal(isSecretPath("certs/server.key"), true);
  assert.equal(isSecretPath("secrets/aws.json"), true);
  assert.equal(isSecretPath("credentials/google.json"), true);
  assert.equal(isSecretPath(".ssh/id_rsa"), true);
});

test("matchSecretPaths returns only true secret files, excluding env-substring sources", () => {
  const paths = ["src/config/dev.environments.ts", "docs/secrets-management.md", ".env", "secrets/db.json"];
  assert.deepEqual(matchSecretPaths(paths), [".env", "secrets/db.json"]);
});

// The `configuration` flag fired on 65% of this repository's scoreable commits
// because its path rules matched loosely: "config", "lock" and "env" as bare
// word tokens anywhere in a path, and "package.json" as a raw substring. The
// tests below pin each false positive the anchored rules removed, and the real
// configuration paths that must keep flagging.

const CONFIGURATION_FALSE_POSITIVES = [
  "src/lib/config.js",
  "tests/config.test.js",
  "src/lib/lock.js",
  "src/lib/locks/advisory-lock.ts",
  "src/env/index.ts",
  "evals/fixtures/shop-api/package.json",
  "evals/fixtures/gate-node/base/package-lock.json",
  "codex/skills/solumbe/evals/files/sample-api/package.json",
];

for (const path of CONFIGURATION_FALSE_POSITIVES) {
  test(`classifyPath does not flag configuration for ${path}`, () => {
    const flags = classifyPath(path);
    assert.ok(!flags.includes(RISK_FLAGS.configuration), `${path} should not imply configuration, got ${flags.join(", ")}`);
  });
}

// Dependency manifests moved out of `configuration` into their own flag after
// the line-overlap backtest separated them: manifest-only commits repaired at
// 0.39x the base rate, real-config commits at 2.25x.
const DEPENDENCY_PATHS = ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "cargo.lock"];

for (const path of DEPENDENCY_PATHS) {
  test(`classifyPath flags dependency, not configuration, for ${path}`, () => {
    const flags = classifyPath(path);
    assert.ok(flags.includes(RISK_FLAGS.dependency), `${path} should imply dependency, got ${flags.join(", ")}`);
    assert.ok(!flags.includes(RISK_FLAGS.configuration), `${path} should not imply configuration, got ${flags.join(", ")}`);
  });
}

test("a manifest inside a fixture corpus carries no flag at all", () => {
  assert.deepEqual(classifyPath("evals/fixtures/shop-api/package.json"), []);
});

const CONFIGURATION_TRUE_POSITIVES = [
  "tsconfig.json",
  "eslint.config.js",
  "vite.config.ts",
  "next.config.mjs",
  "Dockerfile",
  "Dockerfile.release",
  "docker-compose.yml",
  "docker-compose.dev.yml",
  "scripts/sync-dev-with-prod-docker.sh",
  "generate-tsconfig.mjs",
  "tsconfig.base.json",
  ".env.production",
  ".github/workflows/ci.yml",
  "config/app.yml",
  "src/feature-flags/config/environments/production.json",
];

for (const path of CONFIGURATION_TRUE_POSITIVES) {
  test(`classifyPath flags configuration for ${path}`, () => {
    const flags = classifyPath(path);
    assert.ok(flags.includes(RISK_FLAGS.configuration), `${path} should imply configuration, got ${flags.join(", ")}`);
  });
}

test("isTestDataPath separates fixture corpora from the repository's own files", () => {
  assert.equal(isTestDataPath("evals/fixtures/shop-api/package.json"), true);
  assert.equal(isTestDataPath("tests/config.test.js"), true);
  assert.equal(isTestDataPath("package.json"), false);
  assert.equal(isTestDataPath("src/lib/risk-paths.js"), false);
});

test("excludeTestData is opt-in — other flags still classify fixture and test paths", () => {
  assert.ok(classifyPath("evals/fixtures/auth-signup-api/src/session.ts").includes(RISK_FLAGS.authSecurity));
  assert.ok(classifyPath("tests/checkout.spec.ts").includes(RISK_FLAGS.moneyFlow));
});

// A flag the scorer weighs at zero must not independently gate a merge, or
// every dependabot bump warns. Supply-chain risk, which the `repaired` proxy
// cannot see, is covered by the separate dependency audit check.
test("zero-weight dependency paths do not trip the merge gate", () => {
  for (const path of ["package.json", "package-lock.json", "yarn.lock", "go.sum"]) {
    assert.equal(isGateRiskPath(path), false, `${path} should not gate a merge`);
    // Still classified — the evidence is reported, it just does not gate.
    assert.ok(classifyPath(path).includes(RISK_FLAGS.dependency));
  }
});

test("scoring paths still gate, including real configuration", () => {
  for (const path of ["src/auth/roles.guard.ts", "src/payment/checkout.service.ts", "prisma/schema.prisma", "tsconfig.json", ".github/workflows/ci.yml"]) {
    assert.equal(isGateRiskPath(path), true, `${path} should gate a merge`);
  }
});

test("a manifest alongside a scoring path still gates via that path", () => {
  assert.equal(matchRiskPaths(["package-lock.json", "src/auth/session.ts"], { gate: true }).length, 1);
});

// Regression (dogfood, bashbop-go): `internal/pricing/pricing.go` carried no
// money-flow flag while a plan document about Stripe did.
test("classifyPath flags fee, pricing and payout code as money flow", () => {
  for (const file of ["internal/pricing/pricing.go", "internal/fees/fees.go", "src/paystack/paystack.service.ts", "src/payouts/payout.service.ts"]) {
    assert.ok(classifyPath(file).includes(RISK_FLAGS.moneyFlow), file);
  }
  assert.ok(!classifyPath("src/feedback/feedback.service.ts").includes(RISK_FLAGS.moneyFlow));
});
