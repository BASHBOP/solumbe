import test from "node:test";
import assert from "node:assert/strict";
import { ALLOW_MARKER, scanSecretContent, shannonEntropy, summarizeSecretFindings } from "../src/lib/secret-scan.js";

// Credential literals are assembled at runtime on purpose. A live-format key
// committed anywhere in this repository would be detected by the very gate
// these tests cover, so no test fixture may contain one as a literal.
const AWS_KEY = "AKIA" + "3F7QZL2MXN8RTVWB";
const STRIPE_LIVE = "sk_live_" + "51H8xQwR2mNpLkJ4TvBc9Yd7";
const GITHUB_TOKEN = "ghp_" + "aB3dE6gH9jK2mN5pQ8rS1tU4vW7xY0zAbCdE";
const GOOGLE_KEY = "AIza" + "SyD4nQ7vR2mK9pL3xW6tB8cF1hJ5gN0aZqT";
const SLACK_TOKEN = "xoxb-" + "2461829371-4827193746-Kd93mXnQp72LsVb4";
const NPM_TOKEN = "npm_" + "R7kQ2mZ9xL4vN8pT3bW6yH1jC5dF0gA4sE2u";
const ANTHROPIC_KEY = "sk-ant-" + "api03-R7kQ2mZ9xL4vN8pT3bW6yH1jC5dF0gA4";
const PEM_LINE = ["-----BEGIN", " PRIVATE KEY", "-----"].join("");

test("detects vendor credential formats in ordinary source", () => {
  const cases = [
    [`const key = "${AWS_KEY}";`, "aws-access-key-id"],
    [`const key = "${STRIPE_LIVE}";`, "stripe-live-secret-key"],
    [`const key = "${GITHUB_TOKEN}";`, "github-token"],
    [`const key = "${GOOGLE_KEY}";`, "google-api-key"],
    [`const key = "${SLACK_TOKEN}";`, "slack-token"],
    [`const key = "${NPM_TOKEN}";`, "npm-token"],
    [`const key = "${ANTHROPIC_KEY}";`, "anthropic-api-key"],
    [PEM_LINE, "private-key-block"],
  ];
  for (const [text, expectedRule] of cases) {
    const findings = scanSecretContent(text, { file: "src/config.js" });
    assert.equal(findings.length, 1, `expected one finding for ${expectedRule}`);
    assert.equal(findings[0].rule, expectedRule);
    assert.equal(findings[0].severity, "fail");
    assert.equal(findings[0].line, 1);
  }
});

test("reports the line number and never the matched value", () => {
  const text = ["// header", "", `const AWS_ACCESS_KEY_ID = "${AWS_KEY}";`].join("\n");
  const findings = scanSecretContent(text, { file: "src/config.js" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 3);
  assert.equal(findings[0].file, "src/config.js");
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(AWS_KEY), "a finding must not echo the credential");
});

test("contextual AWS secret access key is detected", () => {
  const secret = "wJal" + "rXUtnFEMIbK7MDENGbPxRfiCYzQ9tLmN4vHs";
  const findings = scanSecretContent(`aws_secret_access_key=${secret}`, { file: "deploy.sh" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "aws-secret-access-key");
});

test("placeholders and documentation stand-ins are not credentials", () => {
  const samples = [
    'const key = "AKIAIOSFODNN7EXAMPLE";',
    'const key = "sk_live_YOUR_KEY_HERE_GOES_RIGHT_HERE";',
    'const key = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";',
    'const key = "<your-api-key>";',
    "const key = `${process.env.STRIPE_SECRET_KEY}`;",
  ];
  for (const sample of samples) {
    assert.deepEqual(scanSecretContent(sample, { file: "docs/example.js" }), [], sample);
  }
});

test("environment indirection is never a finding", () => {
  const text = `const apiKey = process.env.API_KEY ?? "${AWS_KEY}";`;
  assert.deepEqual(scanSecretContent(text, { file: "src/config.js" }), []);
});

test("the allow marker suppresses a reviewed false positive", () => {
  const onSameLine = `const rotated = "${AWS_KEY}"; // ${ALLOW_MARKER}`;
  assert.deepEqual(scanSecretContent(onSameLine, { file: "src/config.js" }), []);

  const onPreviousLine = [`// ${ALLOW_MARKER}`, `const rotated = "${AWS_KEY}";`].join("\n");
  assert.deepEqual(scanSecretContent(onPreviousLine, { file: "src/config.js" }), []);
});

test("the generic rule warns only on high-entropy literals without whitespace", () => {
  // solumbe:allow-secret — this sample is the rule's own input, not a credential.
  const highEntropy = scanSecretContent('const password = "Xq7$mR2vLp9!zKw4Tb8";', { file: "src/auth.js" });
  assert.equal(highEntropy.length, 1);
  assert.equal(highEntropy[0].rule, "generic-credential-assignment");
  assert.equal(highEntropy[0].severity, "warn", "the heuristic rule must warn, never block");

  // Prose in a doc comment clears an entropy bar on character variety alone,
  // so the rule additionally requires a value with no whitespace.
  assert.deepEqual(scanSecretContent("* const password = 'Password used to generate key';", { file: "types.d.ts" }), []);
  assert.deepEqual(scanSecretContent("const password = 'Password used to generate key';", { file: "src/auth.js" }), []);
  assert.deepEqual(scanSecretContent('const password = "shortpassword1";', { file: "src/auth.js" }), []);
});

test("binary and oversized input is skipped rather than scanned", () => {
  assert.deepEqual(scanSecretContent(`\0${AWS_KEY}`, { file: "logo.png" }), []);
  const longLine = `const key = "${AWS_KEY}";`.padEnd(5000, " ");
  assert.deepEqual(scanSecretContent(longLine, { file: "bundle.min.js" }), []);
});

test("findings are capped and deduplicated per line and rule", () => {
  const text = Array.from({ length: 50 }, () => `const key = "${AWS_KEY}";`).join("\n");
  const findings = scanSecretContent(text, { file: "src/config.js", maxFindings: 5 });
  assert.equal(findings.length, 5);

  const twiceOnOneLine = `const a = "${AWS_KEY}"; const b = "${AWS_KEY}";`;
  assert.equal(scanSecretContent(twiceOnOneLine, { file: "src/config.js" }).length, 1);
});

test("empty and non-string input is safe", () => {
  assert.deepEqual(scanSecretContent("", { file: "a.js" }), []);
  assert.deepEqual(scanSecretContent(/** @type {any} */ (null), { file: "a.js" }), []);
  assert.deepEqual(scanSecretContent(/** @type {any} */ (undefined), {}), []);
});

test("shannonEntropy separates random keys from prose", () => {
  assert.ok(shannonEntropy("Xq7$mR2vLp9!zKw4Tb8") > 3.6);
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaaaa") < 1);
  assert.equal(shannonEntropy(""), 0);
});

test("summarizeSecretFindings reports the worst severity present", () => {
  assert.deepEqual(summarizeSecretFindings([]), { severity: null, details: [] });

  const warnOnly = summarizeSecretFindings([{ file: "a.js", rule: "generic-credential-assignment", label: "hardcoded credential", severity: "warn", line: 3 }]);
  assert.equal(warnOnly.severity, "warn");
  assert.deepEqual(warnOnly.details, ["a.js:3 — hardcoded credential"]);

  const mixed = summarizeSecretFindings([
    { file: "a.js", rule: "generic-credential-assignment", label: "hardcoded credential", severity: "warn", line: 3 },
    { file: "b.js", rule: "aws-access-key-id", label: "AWS access key id", severity: "fail", line: 1 },
  ]);
  assert.equal(mixed.severity, "fail");
});

// --- Where a credential-shaped literal is a placeholder by convention ---

// Assembled at runtime so no fixture here is itself a literal the gate flags.
const HEURISTIC_LINE = "const accessToken = " + "'valid-access-token-9xQ2mLp7';";
const HEURISTIC_PASSWORD = "const password = " + '"Xq7$mR2vLp9!zKw4Tb8";';

test("the heuristic rule stands down in test, doc, fixture and template files", () => {
  for (const file of [
    "src/authentication/auth.controller.spec.ts",
    "src/payment/stripe.test.js",
    "src/__tests__/auth.ts",
    "tests/helpers/session.js",
    "docs/guest-account-system.md",
    "evals/fixtures/api/src/auth.js",
    ".env.production.local.example",
  ]) {
    assert.deepEqual(scanSecretContent(HEURISTIC_PASSWORD, { file }), [], file);
    assert.deepEqual(scanSecretContent(HEURISTIC_LINE, { file }), [], file);
  }
});

test("the same line still warns in ordinary source", () => {
  const findings = scanSecretContent(HEURISTIC_PASSWORD, { file: "src/authentication/auth.service.ts" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "generic-credential-assignment");
  assert.equal(findings[0].severity, "warn");
});

test("a known secret format still fails in test, doc and template files", () => {
  for (const file of ["src/payment/stripe.processor.spec.ts", "docs/payments.md", ".env.production.local.example"]) {
    const findings = scanSecretContent(`STRIPE_KEY="${STRIPE_LIVE}"`, { file });
    assert.equal(findings.length, 1, file);
    assert.equal(findings[0].rule, "stripe-live-secret-key", file);
    assert.equal(findings[0].severity, "fail", file);
  }
});

test("scanning without a file name keeps every rule", () => {
  // Callers that redact log lines pass text only; they must keep the heuristic.
  assert.equal(scanSecretContent(HEURISTIC_PASSWORD).length, 1);
});

// --- Comment lines in ordinary source ---

const PLACEHOLDER_ASSIGNMENT = "accessToken: " + "'valid-access-token'";

test("the heuristic rule stands down on a comment line in a source file", () => {
  for (const line of [
    `// values by convention (\`${PLACEHOLDER_ASSIGNMENT}\`), so the heuristic`,
    `    // ${PLACEHOLDER_ASSIGNMENT}`,
    `/* ${PLACEHOLDER_ASSIGNMENT} */`,
    ` * ${PLACEHOLDER_ASSIGNMENT}`,
    `# ${PLACEHOLDER_ASSIGNMENT}`,
    `// ${HEURISTIC_PASSWORD}`,
  ]) {
    assert.deepEqual(scanSecretContent(line, { file: "src/lib/secret-scan.js" }), [], line);
  }
});

test("the same assignment on a code line in a source file still warns", () => {
  for (const line of [
    `const session = { ${PLACEHOLDER_ASSIGNMENT} };`,
    `  ${PLACEHOLDER_ASSIGNMENT},`,
    `const session = { ${PLACEHOLDER_ASSIGNMENT} }; // signed in`,
    `/* signed in */ const session = { ${PLACEHOLDER_ASSIGNMENT} };`,
    ` */ const session = { ${PLACEHOLDER_ASSIGNMENT} };`,
    // A private field and a generator method start with a comment character.
    "  #password = " + '"Xq7$mR2vLp9!zKw4Tb8";',
    "  *tokens(password = " + '"Xq7$mR2vLp9!zKw4Tb8") {',
  ]) {
    const findings = scanSecretContent(line, { file: "src/auth/session.js" });
    assert.equal(findings.length, 1, line);
    assert.equal(findings[0].rule, "generic-credential-assignment", line);
    assert.equal(findings[0].severity, "warn", line);
  }
});

test("a known secret format inside a comment still fails", () => {
  const cases = [
    [`// rotated on Friday: ${STRIPE_LIVE}`, "stripe-live-secret-key"],
    [`# AWS_ACCESS_KEY_ID=${AWS_KEY}`, "aws-access-key-id"],
    [` * token: ${GITHUB_TOKEN}`, "github-token"],
    [`/* ${SLACK_TOKEN} */`, "slack-token"],
  ];
  for (const [line, expectedRule] of cases) {
    const findings = scanSecretContent(line, { file: "src/payment/stripe.service.ts" });
    assert.equal(findings.length, 1, line);
    assert.equal(findings[0].rule, expectedRule, line);
    assert.equal(findings[0].severity, "fail", line);
  }
});

test("text scanned without a file name has no comment lines", () => {
  // Redacted output is not source: a TAP diagnostic starts with `#`.
  assert.equal(scanSecretContent(`# ${HEURISTIC_PASSWORD}`).length, 1);
  assert.equal(scanSecretContent(`// ${HEURISTIC_PASSWORD}`).length, 1);
});
