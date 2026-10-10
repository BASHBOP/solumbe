import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXTERNAL_SCANNER_IDS, externalScannerChecks } from "../src/lib/external-scanners.js";
import { evaluateLocal } from "../src/lib/pass-local.js";

// The gate delegates to gitleaks, Semgrep and osv-scanner when they are
// installed and the repository has taken them up. None is installed where the
// suite runs, so each is stood in for by a small script that speaks the real
// tool's command line and report format and decides its findings from the
// files it is handed. That makes the assertions about what the gate hands a
// scanner (the exact changed content) and how it reads the report back.

const bins = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-fake-scanners-"));

function fakeBin(name, body) {
  const file = path.join(bins, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

const WALK = `
const fs = require("node:fs");
const path = require("node:path");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
`;

// gitleaks 8.19+: `gitleaks dir <path> --report-path <file>`, a JSON array.
const GITLEAKS = fakeBin(
  "gitleaks",
  `${WALK}
if (args[0] === "--version") { console.log("8.21.0"); process.exit(0); }
if (process.env.FAKE_GITLEAKS === "broken") { console.error("FATA could not parse config"); process.exit(2); }
const old = process.env.FAKE_GITLEAKS === "old";
if (old && args[0] === "dir") { console.error('unknown command "dir" for "gitleaks"'); process.exit(1); }
const source = args[0] === "dir" ? args[1] : after("--source");
if (!args.includes("--redact")) { console.error("expected --redact"); process.exit(3); }
const findings = walk(source).flatMap((file) =>
  fs.readFileSync(file, "utf8").split("\\n").flatMap((line, index) =>
    line.includes("FAKE_LIVE_KEY") ? [{ RuleID: "generic-api-key", File: file, StartLine: index + 1, Secret: "REDACTED", Match: "REDACTED" }] : []));
fs.writeFileSync(after("--report-path"), JSON.stringify(findings));
process.exit(0);`,
);

// semgrep: `semgrep scan --json --config <rules> <path>`, results on stdout.
const SEMGREP = fakeBin(
  "semgrep",
  `${WALK}
if (args[0] === "--version") { console.log("1.90.0"); process.exit(0); }
if (!args.includes("--metrics=off") || args.includes("auto")) { console.error("expected offline flags"); process.exit(3); }
const results = walk(args[args.length - 1]).flatMap((file) =>
  fs.readFileSync(file, "utf8").split("\\n").flatMap((line, index) => {
    if (line.includes("eval(")) return [{ check_id: "rules.no-eval", path: file, start: { line: index + 1 }, extra: { severity: "ERROR", message: "eval" } }];
    if (line.includes("console.log(")) return [{ check_id: "rules.no-console", path: file, start: { line: index + 1 }, extra: { severity: "WARNING", message: "log" } }];
    return [];
  }));
console.log(JSON.stringify({ results, errors: [] }));`,
);

// osv-scanner: `osv-scanner --format json --lockfile <file>`, exit 1 on a finding.
const OSV = fakeBin(
  "osv-scanner",
  `${WALK}
if (args[0] === "--version") { console.log("osv-scanner version: 1.9.0"); process.exit(0); }
const lockfiles = args.flatMap((arg, index) => (arg === "--lockfile" ? [args[index + 1]] : []));
const results = lockfiles.map((file) => ({
  source: { path: file, type: "lockfile" },
  packages: fs.readFileSync(file, "utf8").includes("left-pad")
    ? [{ package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-fake-0001" }, { id: "GHSA-fake-0002" }] }]
    : [],
}));
console.log(JSON.stringify({ results }));
process.exit(results.some((entry) => entry.packages.length) ? 1 : 0);`,
);

const MISSING = path.join(bins, "not-installed");

/** An environment where each scanner is the fake, or is not installed. */
function envWith(overrides = {}) {
  return {
    ...process.env,
    SOLUMBE_SCANNERS: "",
    SOLUMBE_GITLEAKS_BIN: GITLEAKS,
    SOLUMBE_SEMGREP_BIN: SEMGREP,
    SOLUMBE_OSV_SCANNER_BIN: OSV,
    FAKE_GITLEAKS: "",
    ...overrides,
  };
}

function repo(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-scan-repo-")));
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
}

const reader = (content) => (file) => content[file] ?? null;
const byName = (checks, name) => checks.find((check) => check.name === name);

test("the scanners the gate can delegate to are gitleaks, semgrep and osv-scanner", () => {
  assert.deepEqual(EXTERNAL_SCANNER_IDS, ["gitleaks", "semgrep", "osv-scanner"]);
});

test("no scanner runs in a repository that has taken none of them up", () => {
  const root = repo({ "src/a.js": "x" });
  const content = { "src/a.js": "const key = 'FAKE_LIVE_KEY'; eval(key);\n", "package-lock.json": '{"left-pad":"1.0.0"}' };
  // osv-scanner is installed and a lockfile changed, so it says why it did not run.
  const checks = externalScannerChecks(root, Object.keys(content), reader(content), { env: envWith() });
  assert.deepEqual(
    checks.map((check) => [check.name, check.status]),
    [["Known vulnerabilities (osv-scanner)", "SKIPPED"]],
  );
  assert.match(checks[0].summary, /sends package names off this machine\. Name it in SOLUMBE_SCANNERS/);

  // Not installed at all, and switched off, both say nothing.
  const none = envWith({ SOLUMBE_GITLEAKS_BIN: MISSING, SOLUMBE_SEMGREP_BIN: MISSING, SOLUMBE_OSV_SCANNER_BIN: MISSING });
  assert.deepEqual(externalScannerChecks(root, Object.keys(content), reader(content), { env: none }), []);
  assert.deepEqual(externalScannerChecks(root, Object.keys(content), reader(content), { env: envWith({ SOLUMBE_SCANNERS: "off" }) }), []);
});

test("gitleaks runs where the repository has a .gitleaks.toml, and a finding fails with file, line and rule only", () => {
  const root = repo({ ".gitleaks.toml": "title = 'rules'\n" });
  const content = { "src/config.js": "export const region = 'eu';\nexport const key = 'FAKE_LIVE_KEY_abcdef';\n", "README.md": "# readme\n" };
  const check = byName(externalScannerChecks(root, Object.keys(content), reader(content), { env: envWith() }), "Secret scan (gitleaks)");
  assert.equal(check.status, "FAIL");
  assert.equal(check.summary, "gitleaks found 1 secret in the changed content.");
  assert.deepEqual(check.details, ["src/config.js:2 generic-api-key"]);
  assert.ok(!JSON.stringify(check).includes("FAKE_LIVE_KEY"), "the secret itself is never repeated");

  const clean = { "README.md": "# readme\n" };
  const passed = byName(externalScannerChecks(root, Object.keys(clean), reader(clean), { env: envWith() }), "Secret scan (gitleaks)");
  assert.equal(passed.status, "PASS");
  assert.equal(passed.summary, "gitleaks found no secret in 1 changed file.");
});

test("gitleaks is run by name without a config, falls back to `detect` on an older release, and warns on an unreadable report", () => {
  const root = repo({ "src/a.js": "x" });
  const content = { "src/a.js": "const key = 'FAKE_LIVE_KEY';\n" };
  const named = externalScannerChecks(root, ["src/a.js"], reader(content), { env: envWith({ SOLUMBE_SCANNERS: "gitleaks" }) });
  assert.deepEqual(
    named.map((check) => [check.name, check.status]),
    [["Secret scan (gitleaks)", "FAIL"]],
  );

  const old = externalScannerChecks(root, ["src/a.js"], reader(content), { env: envWith({ SOLUMBE_SCANNERS: "gitleaks", FAKE_GITLEAKS: "old" }) });
  assert.equal(old[0].status, "FAIL", "a release without `dir` is read through `detect --no-git`");

  const broken = externalScannerChecks(root, ["src/a.js"], reader(content), { env: envWith({ SOLUMBE_SCANNERS: "gitleaks", FAKE_GITLEAKS: "broken" }) });
  assert.equal(broken[0].status, "WARN");
  assert.match(broken[0].summary, /did not return a readable report/);
  assert.deepEqual(broken[0].details, ["FATA could not parse config"]);

  const absent = externalScannerChecks(root, ["src/a.js"], reader(content), { env: envWith({ SOLUMBE_SCANNERS: "gitleaks", SOLUMBE_GITLEAKS_BIN: MISSING }) });
  assert.deepEqual(absent, [{ name: "Secret scan (gitleaks)", status: "WARN", summary: "gitleaks is named in SOLUMBE_SCANNERS but is not installed." }]);
});

test("semgrep runs only with the repository's own rules: an ERROR finding fails, a WARNING warns", () => {
  const content = { "src/run.js": "export function run(code) {\n  return eval(code);\n}\n", "src/log.js": "console.log('hi');\n" };
  const noRules = repo({ "src/run.js": "x" });
  assert.equal(byName(externalScannerChecks(noRules, Object.keys(content), reader(content), { env: envWith() }), "Code patterns (semgrep)"), undefined);

  const root = repo({ ".semgrep.yml": "rules: []\n" });
  const failed = byName(externalScannerChecks(root, Object.keys(content), reader(content), { env: envWith() }), "Code patterns (semgrep)");
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.summary, "semgrep found 2 findings in the changed content, 1 at ERROR severity (rules: .semgrep.yml).");
  assert.deepEqual(failed.details, ["src/log.js:1 rules.no-console (WARNING)", "src/run.js:2 rules.no-eval (ERROR)"]);

  const warned = byName(externalScannerChecks(root, ["src/log.js"], reader(content), { env: envWith() }), "Code patterns (semgrep)");
  assert.equal(warned.status, "WARN");

  const clean = { "src/ok.js": "export const ok = true;\n" };
  assert.equal(byName(externalScannerChecks(root, ["src/ok.js"], reader(clean), { env: envWith() }), "Code patterns (semgrep)").status, "PASS");
});

test("osv-scanner runs only when named, only on changed lockfiles, and a known vulnerability warns", () => {
  const root = repo({ "package.json": "{}" });
  const content = { "package-lock.json": '{"packages":{"node_modules/left-pad":{"version":"1.0.0"}}}', "src/a.js": "export const a = 1;\n" };
  const env = envWith({ SOLUMBE_SCANNERS: "osv-scanner" });

  const check = byName(externalScannerChecks(root, Object.keys(content), reader(content), { env }), "Known vulnerabilities (osv-scanner)");
  assert.equal(check.status, "WARN");
  assert.equal(check.summary, "osv-scanner found 2 known vulnerabilities in 1 changed lockfile.");
  assert.deepEqual(check.details, ["left-pad@1.0.0: GHSA-fake-0001, GHSA-fake-0002"]);

  const safe = { "package-lock.json": '{"packages":{}}' };
  assert.equal(byName(externalScannerChecks(root, ["package-lock.json"], reader(safe), { env }), "Known vulnerabilities (osv-scanner)").status, "PASS");

  // No lockfile in the change: nothing for it to look at, so no check.
  assert.deepEqual(externalScannerChecks(root, ["src/a.js"], reader(content), { env }), []);
});

test("a scanner is handed the content the gate read, not the working tree, and never a path outside its copy", () => {
  const root = repo({ ".gitleaks.toml": "title = 'rules'\n", "src/config.js": "export const key = 'FAKE_LIVE_KEY';\n" });
  // The working tree holds the secret; the content under review does not.
  const reviewed = { "src/config.js": "export const key = process.env.KEY;\n", "../escape.js": "const key = 'FAKE_LIVE_KEY';\n" };
  const check = byName(externalScannerChecks(root, Object.keys(reviewed), reader(reviewed), { env: envWith() }), "Secret scan (gitleaks)");
  assert.equal(check.status, "PASS");
  assert.equal(check.summary, "gitleaks found no secret in 1 changed file.", "the path that points outside the copy was not written");

  // A file the reader cannot return (deleted, binary, too large) is left out.
  assert.deepEqual(
    externalScannerChecks(root, ["src/gone.js"], () => null, { env: envWith() }),
    [],
  );
});

test("the local gate folds a scanner's finding into its verdict, from the exact staged tree", () => {
  const root = repo({
    ".gitleaks.toml": "title = 'rules'\n",
    "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
    "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }),
    "src/config.js": "export const region = 'eu';\n",
  });
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(root, "src/config.js"), "export const region = 'eu';\nexport const token = 'FAKE_LIVE_KEY_abcdef';\n");
  git("add", ".");
  // Fixed after staging: the staged tree still carries it.
  fs.writeFileSync(path.join(root, "src/config.js"), "export const region = 'eu';\n");

  const saved = { ...process.env };
  Object.assign(process.env, envWith());
  try {
    const result = evaluateLocal(root, { base: "HEAD", staged: true });
    const check = byName(result.checks, "Secret scan (gitleaks)");
    assert.equal(check.status, "FAIL");
    assert.deepEqual(check.details, ["src/config.js:2 generic-api-key"]);
    assert.equal(result.verdict, "FAIL");

    // A replay over history runs no installed tool.
    const replay = evaluateLocal(root, { base: "HEAD", staged: true, analyzers: false });
    assert.equal(byName(replay.checks, "Secret scan (gitleaks)"), undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
