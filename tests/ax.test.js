import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateAxScore, changeabilityFromTokens, bandFor } from "../src/lib/ax.js";
import { generateImpact } from "../src/lib/impact.js";

/**
 * Build a minimal repo fixture. With no guardrail signals by default; callers
 * opt into tests/validation/owners/ci.
 * @param {{ scripts?: Record<string, string>, owners?: boolean, ci?: boolean, testsDir?: boolean }} [opts]
 * @returns {string}
 */
function makeRepo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-ax-"));
  fs.mkdirSync(path.join(root, "src", "events"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "events-api", scripts: opts.scripts ?? {} }));
  fs.writeFileSync(
    path.join(root, "src", "events", "controller.js"),
    "export function createEvent(input) {\n  return { id: 1, ...input };\n}\nexport function listEvents() {\n  return [];\n}\n",
  );
  fs.writeFileSync(path.join(root, "src", "events", "service.js"), "import { createEvent } from './controller.js';\nexport const svc = { createEvent };\n");
  if (opts.testsDir) {
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "tests", "events.test.js"), "// test\n");
  }
  if (opts.owners) {
    fs.mkdirSync(path.join(root, ".github"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "CODEOWNERS"), "* @team/core\n");
  }
  if (opts.ci) {
    fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n");
  }
  return root;
}

test("generateAxScore returns a valid, bounded schema", () => {
  const root = makeRepo();
  const data = generateAxScore("add an events endpoint", { path: root });

  assert.equal(data.ok, true);
  assert.equal(data.mode, "task");
  assert.ok(Number.isInteger(data.ax) && data.ax >= 0 && data.ax <= 100);
  assert.ok(["poor", "fair", "good", "excellent"].includes(data.band));
  for (const key of ["changeability", "containment", "guardrails", "clarity"]) {
    const v = data.subScores[key];
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `${key}=${v} out of range`);
  }
  assert.equal(typeof data.drivers.guardrails.tests, "boolean");
  assert.ok(Array.isArray(data.recommendations));
});

test("AX is deterministic for the same repo + query", () => {
  const root = makeRepo({ scripts: { test: "node --test" }, owners: true, ci: true });
  const a = generateAxScore("add an events endpoint", { path: root });
  const b = generateAxScore("add an events endpoint", { path: root });
  assert.equal(a.ax, b.ax);
  assert.deepEqual(a.subScores, b.subScores);
  assert.deepEqual(a.drivers.guardrails, b.drivers.guardrails);
});

test("enabling guardrails never lowers the guardrail sub-score", () => {
  const bare = generateAxScore("add an events endpoint", { path: makeRepo() });
  const guarded = generateAxScore("add an events endpoint", {
    path: makeRepo({ scripts: { lint: "eslint .", test: "node --test" }, owners: true, ci: true, testsDir: true }),
  });

  assert.ok(guarded.subScores.guardrails >= bare.subScores.guardrails);
  assert.equal(bare.drivers.guardrails.owners, false);
  assert.equal(guarded.drivers.guardrails.owners, true);
  assert.equal(guarded.drivers.guardrails.ci, true);
  assert.equal(guarded.drivers.guardrails.tests, true);
  assert.equal(guarded.subScores.guardrails, 100);
});

test("a bare repo recommends the missing guardrails", () => {
  const data = generateAxScore("add an events endpoint", { path: makeRepo() });
  const joined = data.recommendations.join("\n");
  assert.match(joined, /CODEOWNERS/);
  assert.match(joined, /CI workflow/);
});

test("changeabilityFromTokens is monotonic non-increasing in tokens", () => {
  const points = [500, 1500, 3000, 8000, 20000, 40000, 80000];
  let prev = Infinity;
  for (const t of points) {
    const score = changeabilityFromTokens(t);
    assert.ok(score >= 0 && score <= 100);
    assert.ok(score <= prev + 1e-9, `changeability rose at ${t} tokens (${score} > ${prev})`);
    prev = score;
  }
  assert.equal(changeabilityFromTokens(1000), 100); // at/under floor
  assert.equal(changeabilityFromTokens(50000), 0); // at/over ceiling
});

test("bandFor maps scores to the expected bands", () => {
  assert.equal(bandFor(95), "excellent");
  assert.equal(bandFor(70), "good");
  assert.equal(bandFor(50), "fair");
  assert.equal(bandFor(10), "poor");
});

test("ax requires a non-empty change request", () => {
  assert.throws(() => generateAxScore("   ", { path: makeRepo() }), /requires a change request/);
});

// Regression (dogfood, bashbop-go): nine `_test.go` files scored "tests: no,
// validation: no" because only package.json scripts counted.
test("generateAxScore counts a Go module's _test.go files and toolchain as guardrails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ax-go-"));
  const files = {
    "go.mod": "module example.com/fees\n\ngo 1.22\n",
    "internal/fees/fees.go": "package fees\n\nfunc RefundFee() int { return 1 }\n",
    "internal/fees/fees_test.go": 'package fees\n\nimport "testing"\n\nfunc TestRefundFee(t *testing.T) {}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }

  const data = generateAxScore("add a refund fee endpoint", { path: root });
  assert.equal(data.drivers.guardrails.tests, true);
  assert.equal(data.drivers.guardrails.validation, true);
});

// `solumbe route` hands AX its impact pass, and the UserPromptSubmit hook gives
// route six seconds. AX used to inspect the whole repository for four fields,
// which started five git processes (ls-files, rev-parse, branch, rev-parse,
// status) on every routed prompt.
test("generateAxScore with an impact handed in starts no git process", () => {
  const root = makeRepo({ scripts: { test: "node --test" }, testsDir: true });
  const query = "add an events endpoint";
  const impact = generateImpact(query, { path: root }).data;
  const expected = generateAxScore(query, { path: root, impact });

  // A `git` first on PATH that records each call and fails.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-ax-git-"));
  const log = path.join(bin, "calls.log");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
  let data;
  try {
    data = generateAxScore(query, { path: root, impact });
  } finally {
    process.env.PATH = savedPath;
  }

  assert.equal(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", "", "AX ran git");
  assert.deepEqual({ ...data, generatedAt: null }, { ...expected, generatedAt: null }, "the score does not depend on git");
  fs.rmSync(bin, { recursive: true });
  fs.rmSync(root, { recursive: true });
});
