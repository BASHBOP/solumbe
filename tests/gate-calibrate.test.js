import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatGateCalibrationMarkdown, generateGateCalibration } from "../src/lib/gate-calibrate.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function initRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `gate-calibrate-${prefix}-`)));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

/** Commits are dated so the window can elapse: `daysAgo` counts back from a fixed horizon. */
const HORIZON = Date.UTC(2026, 8, 26) / 1000;
function commit(root, files, message, daysAgo = 0) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, "add", ".");
  const at = `${HORIZON - daysAgo * 86400} +0000`;
  spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_DATE: at,
    },
  });
  return git(root, "rev-parse", "HEAD").trim();
}

const lines = (...values) => `${values.join("\n")}\n`;

/**
 * A history the gate reads two ways: a change to a payment path, which it
 * warns on and a later fix repairs, and a change to a utility, which it passes
 * and nothing repairs. The lockfile arrives after the first of them.
 */
function historyRepo(prefix) {
  const root = initRepo(prefix);
  commit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test" } }),
      "src/payment/refund.js": lines("export function refund() {", "  return 1;", "}"),
      "src/util.js": lines("export const util = 1;"),
    },
    "chore: seed",
    90,
  );
  const risky = commit(root, { "src/payment/refund.js": lines("export function refund() {", "  return 2;", "}") }, "feat: refund the full amount", 80);
  commit(root, { "package-lock.json": JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3 }) }, "chore: add the lockfile", 75);
  const safe = commit(root, { "src/util.js": lines("export const util = 2;") }, "feat: bump the util value", 70);
  const docs = commit(root, { "docs/guide.md": lines("# Guide") }, "docs: add a guide", 60);
  commit(root, { "src/payment/refund.js": lines("export function refund() {", "  return 3;", "}") }, "fix: refund returned the wrong amount", 50);
  const young = commit(root, { "src/young.js": lines("export const young = 1;") }, "feat: too recent to grade", 10);
  return { root, risky, safe, docs, young };
}

test("gate calibration replays the gate on each commit and joins the verdict to the repaired outcome", async () => {
  const { root, risky, safe, docs, young } = historyRepo("replay");
  const seen = [];
  const data = await generateGateCalibration(root, { minSample: 1, onProgress: (progress) => seen.push(progress.sha) });

  // The seed has no parent, the fix is the outcome, the youngest commit has
  // not had its window, and the docs-only commit is left out.
  const replayed = data.commits.map((row) => row.sha);
  assert.ok(replayed.includes(risky) && replayed.includes(safe));
  assert.ok(!replayed.includes(docs), "a docs-only commit is not graded");
  assert.ok(!replayed.includes(young), "a commit younger than the window is censored");
  assert.equal(data.range.docsOnly, 1);
  assert.equal(data.range.censored, 1);
  assert.deepEqual(seen.sort(), [...replayed].sort(), "progress reports every replayed commit");

  const riskyRow = data.commits.find((row) => row.sha === risky);
  const safeRow = data.commits.find((row) => row.sha === safe);
  assert.equal(riskyRow.verdict, "WARN");
  assert.ok(riskyRow.warned.includes("Risk review"));
  assert.ok(riskyRow.repairedAfter !== null, "the fix rewrote the lines this commit wrote");
  assert.equal(safeRow.verdict, "PASS");
  assert.deepEqual(safeRow.warned, []);
  assert.equal(safeRow.repairedAfter, null);
  assert.deepEqual(safeRow.skipped, ["Review state"], "the review state the local gate cannot see does not make a verdict");
  for (const row of data.commits) {
    assert.ok(["aligned", "partial", "drift"].includes(row.band), row.band);
    assert.equal(typeof row.convergence, "number");
  }

  // The gate read each commit's own tree: the lockfile did not exist yet when
  // the payment change landed, and does at the head the run started from.
  assert.ok(riskyRow.warned.includes("Dependency audit"));
  assert.ok(!safeRow.warned.includes("Dependency audit"));

  const warn = data.gate.verdicts.find((row) => row.name === "WARN");
  assert.equal(warn.repaired, 1);
  assert.equal(data.gate.verdicts.find((row) => row.name === "PASS").repaired, 0);
  assert.equal(data.gate.caught.hits, 1, "the repaired change was one the gate had warned on");
  assert.equal(data.gate.falseAlarms.hits, data.gate.alarmed.n - 1);
  assert.ok(data.gate.checks.some((row) => row.name === "Risk review" && row.repaired === 1));
  assert.equal(typeof data.gate.separates, "boolean");
  assert.match(data.receipt.id, /^gatecal_[0-9a-f]{12}$/);
});

test("gate calibration withholds every rate below the minimum sample", async () => {
  const { root } = historyRepo("withheld");
  const data = await generateGateCalibration(root);
  assert.equal(data.base.rate, null);
  assert.equal(data.base.publishable, false);
  for (const row of [...data.gate.verdicts, ...data.gate.checks, ...data.convergence.bands]) assert.equal(row.rate, null, row.name);
  assert.equal(data.gate.alarmRate.rate, null);
  assert.equal(data.gate.separates, null, "an ordering is not claimed below the minimum sample");
  assert.equal(data.convergence.monotonic, null);
  const markdown = formatGateCalibrationMarkdown(data);
  assert.match(markdown, /# Gate calibration/);
  assert.match(markdown, /n < 30, withheld/);
  assert.match(markdown, /unknown \(a group fell below the minimum sample\)/);
});

test("gate calibration leaves the repository as it found it and recomputes to the same receipt", async () => {
  const { root } = historyRepo("clean");
  const head = git(root, "rev-parse", "HEAD").trim();
  const first = await generateGateCalibration(root, { minSample: 1 });
  const second = await generateGateCalibration(root, { minSample: 1 });
  assert.equal(first.receipt.inputsHash, second.receipt.inputsHash);
  assert.equal(git(root, "rev-parse", "HEAD").trim(), head);
  assert.equal(git(root, "status", "--porcelain").trim(), "");
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1, "the replay worktree is removed");
});

test("gate calibration refuses a history with nothing old enough to grade", async () => {
  const root = initRepo("young");
  commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed", 5);
  commit(root, { "src/a.js": lines("export const a = 2;") }, "feat: change a", 3);
  await assert.rejects(() => generateGateCalibration(root), /no commit old enough to grade/);
});

const CLI = path.resolve("src/cli.js");
/** Run the CLI with telemetry off, so a test never writes to the user's log. */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SOLUMBE_TELEMETRY: "0", ...env } });
}

test("solumbe calibrate --gate prints the replay as JSON and as a report, and takes the repository after the flag", async () => {
  const { root } = historyRepo("cli");
  const json = cli(["calibrate", root, "--gate", "--min-sample", "1", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.method.minSample, 1);
  assert.match(json.stderr, /calibrate: \d+\/\d+ [0-9a-f]{7}/, "progress goes to stderr");

  const report = cli(["calibrate", "--gate", root, "--quiet", "--no-color"]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /GATE CALIBRATION/);
  assert.equal(report.stderr, "", "--quiet silences progress");

  const out = path.join(root, "gate.md");
  const written = cli(["calibrate", root, "--gate", "--quiet", "--out", out]);
  assert.equal(written.status, 0, written.stderr);
  assert.match(fs.readFileSync(out, "utf8"), /# Gate calibration/);

  const both = cli(["calibrate", root, "--gate", "--trial"]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /one of --gate, --follow-through or --trial/);
  assert.match(cli(["help"]).stdout, /calibrate <repo> --gate/);
});
