import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatFollowThroughMarkdown, generateFollowThrough, gradeFollowThrough, repoKey } from "../src/lib/follow-through.js";
import { extractSignals } from "../src/lib/telemetry.js";

const MINUTE = 60000;
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

/** One gate run in the log, `minute` minutes after the first. */
function gate(minute, verdict, checks, extra = {}) {
  return {
    v: 1,
    ts: T0 + minute * MINUTE,
    surface: "mcp",
    cmd: "review_gate",
    outcome: "ok",
    repo: "aaaaaaaaaaaa",
    signals: { verdict, gateMode: "local", repoId: "aaaaaaaaaaaa", ...(checks ? { checks } : {}), ...extra },
  };
}

/** One convergence score in the log. */
function score(minute, convergence, band, requestId = "task-1") {
  return {
    v: 1,
    ts: T0 + minute * MINUTE,
    surface: "mcp",
    cmd: "convergence_score",
    outcome: "ok",
    repo: "aaaaaaaaaaaa",
    signals: { convergence, band, repoId: "aaaaaaaaaaaa", ...(requestId ? { requestId } : {}) },
  };
}

test("a warning is cleared when the check passes on the next run inside the window", () => {
  const data = gradeFollowThrough(
    [
      gate(0, "WARN", { "Risk review": "WARN", "Secret safety": "PASS" }, { changeId: "c1" }),
      gate(5, "PASS", { "Risk review": "PASS", "Secret safety": "PASS" }, { changeId: "c2" }),
      // Warned, run again on the same change, still warning.
      gate(100, "WARN", { "Risk review": "WARN", "Secret safety": "PASS" }, { changeId: "c3" }),
      gate(103, "WARN", { "Risk review": "WARN", "Secret safety": "PASS" }, { changeId: "c3" }),
      // The last warning has no follow-up at all.
    ],
    { minSample: 1 },
  );
  assert.equal(data.gate.runs, 4);
  assert.equal(data.gate.alarms, 3);
  assert.deepEqual([data.gate.followed.hits, data.gate.followed.n], [2, 3]);
  assert.deepEqual([data.gate.cleared.hits, data.gate.cleared.n], [1, 2]);
  assert.deepEqual([data.gate.sameChange.hits, data.gate.sameChange.n], [1, 2], "one follow-up ran on the change that had warned");
  const risk = data.gate.checks.find((row) => row.name === "Risk review");
  assert.equal(risk.alarms, 3);
  assert.deepEqual([risk.cleared.hits, risk.cleared.n], [1, 2]);
  assert.equal(risk.repeated, 1);
  assert.equal(risk.cleared.rate, 0.5);
  assert.ok(!data.gate.checks.some((row) => row.name === "Secret safety"), "a check that never alarmed has no row");
});

test("a follow-up outside the window, on another repository or from the other gate does not count", () => {
  const data = gradeFollowThrough(
    [
      gate(0, "WARN", { "Risk review": "WARN" }),
      // 61 minutes later: outside the default window.
      gate(61, "PASS", { "Risk review": "PASS" }),
      {
        ...gate(200, "WARN", { "Risk review": "WARN" }),
        signals: { verdict: "WARN", gateMode: "local", repoId: "bbbbbbbbbbbb", checks: { "Risk review": "WARN" } },
      },
      gate(201, "PASS", { "Risk review": "PASS" }),
      // The pull request gate does not run the local gate's checks.
      gate(300, "WARN", { "Validation commands": "WARN" }),
      { ...gate(301, "PASS", { "PR state": "PASS" }), signals: { verdict: "PASS", gateMode: "pr", repoId: "aaaaaaaaaaaa", checks: { "PR state": "PASS" } } },
    ],
    { minSample: 1 },
  );
  assert.equal(data.gate.alarms, 3);
  assert.equal(data.gate.followed.hits, 0);
  assert.equal(data.gate.cleared.n, 0);
});

test("a check the next run did not decide is neither cleared nor repeated", () => {
  const data = gradeFollowThrough(
    [
      gate(0, "FAIL", { Convergence: "FAIL", "Review state": "SKIPPED" }),
      // The follow-up did not ask for a convergence floor, so the check is absent.
      gate(2, "PASS", { "Review state": "SKIPPED" }),
      // A record from before per-check logging carries the verdict only.
      gate(100, "WARN", { "Risk review": "WARN" }),
      gate(101, "PASS", null),
    ],
    { minSample: 1 },
  );
  const convergence = data.gate.checks.find((row) => row.name === "Convergence");
  assert.deepEqual([convergence.cleared.hits, convergence.cleared.n, convergence.notRun], [0, 0, 1]);
  const risk = data.gate.checks.find((row) => row.name === "Risk review");
  assert.deepEqual([risk.cleared.n, risk.notRun], [0, 1]);
  assert.ok(!data.gate.checks.some((row) => row.name === "Review state"), "a skipped check is not an alarm");
  assert.deepEqual([data.gate.cleared.hits, data.gate.cleared.n], [2, 2], "the verdict is still graded");
  assert.equal(data.gate.perCheckRuns, 3);
});

test("a low convergence score is followed by the next score of the same task", () => {
  const data = gradeFollowThrough(
    [
      score(0, 40, "drift"),
      score(4, 85, "aligned"),
      score(10, 60, "partial"),
      score(12, 55, "partial"),
      // Another task scored between them is not this task's follow-up.
      score(20, 30, "drift", "task-2"),
      score(21, 90, "aligned", "task-3"),
    ],
    { minSample: 1 },
  );
  assert.equal(data.convergence.runs, 6);
  assert.equal(data.convergence.low, 4);
  assert.deepEqual([data.convergence.rescored.hits, data.convergence.rescored.n], [2, 4]);
  assert.deepEqual([data.convergence.improved.hits, data.convergence.improved.n], [1, 2]);
  assert.deepEqual([data.convergence.aligned.hits, data.convergence.aligned.n], [1, 2]);
});

test("rates below the minimum sample are withheld and the report says so", () => {
  const data = gradeFollowThrough([gate(0, "WARN", { "Risk review": "WARN" }), gate(1, "PASS", { "Risk review": "PASS" })]);
  assert.equal(data.gate.cleared.rate, null);
  assert.equal(data.gate.cleared.publishable, false);
  assert.equal(data.gate.checks[0].cleared.rate, null);
  const markdown = formatFollowThroughMarkdown({ repo: null, log: { path: "usage.jsonl", events: 2, inScope: 2 }, ...data });
  assert.match(markdown, /# Follow-through — every repository in the log/);
  assert.match(markdown, /n < 30, withheld/);
  assert.match(markdown, /\| Risk review \| 1 \|/);
});

test("the gate's result carries what the follow-up join reads, and no path or request text", () => {
  const signals = extractSignals({
    verdict: "WARN",
    scope: "working-tree",
    request: "add Stripe refunds",
    repo: { root: "/work/shop-api", name: "shop-api" },
    changedFiles: ["src/payment/refund.js"],
    checks: [
      { name: "Risk review", status: "WARN", summary: "Risk-sensitive files changed.", details: ["src/payment/refund.js"] },
      { name: "Review state", status: "SKIPPED", summary: "Local mode cannot verify approvals." },
      { name: "Secret safety", status: "PASS", summary: "Clean." },
    ],
  });
  assert.deepEqual(signals.checks, { "Risk review": "WARN", "Review state": "SKIPPED", "Secret safety": "PASS" });
  assert.equal(signals.gateMode, "local");
  assert.equal(signals.repoId, repoKey("/work/shop-api"));
  assert.match(signals.changeId, /^[0-9a-f]{12}$/);
  assert.match(signals.requestId, /^[0-9a-f]{12}$/);
  const text = JSON.stringify(signals);
  assert.doesNotMatch(text, /refund|Stripe|shop-api|\/work/, "the log holds hashes and check names only");

  const same = extractSignals({
    verdict: "WARN",
    scope: "working-tree",
    repo: { root: "/work/shop-api" },
    changedFiles: ["src/payment/refund.js"],
    checks: [],
  });
  const other = extractSignals({
    verdict: "WARN",
    scope: "working-tree",
    repo: { root: "/work/shop-api" },
    changedFiles: ["src/payment/charge.js"],
    checks: [],
  });
  assert.equal(same.changeId, signals.changeId, "the same changed files are the same change");
  assert.notEqual(other.changeId, signals.changeId);
  assert.equal(same.requestId, undefined, "no request, no request id");

  assert.equal(extractSignals({ verdict: "WARN", pr: { number: 4 }, repo: { root: "/work/shop-api" }, changedFiles: [], checks: [] }).gateMode, "pr");
  const review = extractSignals({ verdict: "PASS", repo: { root: "/work/shop-api" }, pass: { checks: [{ name: "Secret safety", status: "PASS" }] } });
  assert.deepEqual(review.checks, { "Secret safety": "PASS" }, "a review carries the gate's checks inside it");
  const converge = extractSignals({ convergence: 40, band: "drift", task: "add Stripe refunds", repo: { root: "/work/shop-api" } });
  assert.equal(converge.requestId, signals.requestId, "the gate's request and the score's task hash alike");
  assert.equal(converge.checks, undefined);
});

test("follow-through reads the usage log and keeps to the repository it was asked about", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "follow-through-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "follow-through-repo-")));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const logPath = path.join(home, "usage.jsonl");
  const mine = repoKey(root);
  const here = (event) => ({ ...event, repo: mine, signals: { ...event.signals, repoId: mine } });
  const events = [
    here(gate(0, "WARN", { "Risk review": "WARN" })),
    here(gate(3, "PASS", { "Risk review": "PASS" })),
    gate(10, "WARN", { "Risk review": "WARN" }),
  ];
  fs.writeFileSync(logPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const env = { ...process.env, SOLUMBE_TELEMETRY_PATH: logPath };

  const scoped = generateFollowThrough(root, { env, minSample: 1 });
  assert.equal(scoped.repo.root, root);
  assert.deepEqual([scoped.log.events, scoped.log.inScope], [3, 2]);
  assert.equal(scoped.gate.alarms, 1);
  assert.equal(scoped.gate.cleared.rate, 1);

  const all = generateFollowThrough(root, { env, minSample: 1, all: true });
  assert.equal(all.repo, null);
  assert.equal(all.gate.alarms, 2);
});

const CLI = path.resolve("src/cli.js");
/** Run the CLI with telemetry off, so a test never writes to the user's log. */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SOLUMBE_TELEMETRY: "0", ...env } });
}

test("solumbe calibrate --follow-through reports from the usage log", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "follow-through-cli-"));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "follow-through-cli-repo-")));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const logPath = path.join(home, "usage.jsonl");
  const mine = repoKey(root);
  const here = (event) => ({ ...event, repo: mine, signals: { ...event.signals, repoId: mine } });
  const events = [
    here(gate(0, "WARN", { "Risk review": "WARN" })),
    here(gate(3, "PASS", { "Risk review": "PASS" })),
    gate(10, "WARN", { "Risk review": "WARN" }),
  ];
  fs.writeFileSync(logPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const env = { SOLUMBE_TELEMETRY_PATH: logPath };

  const json = cli(["calibrate", root, "--follow-through", "--min-sample", "1", "--window-min", "30", "--json"], env);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.equal(data.gate.alarms, 1);
  assert.equal(data.method.windowMin, 30);

  const all = cli(["calibrate", root, "--follow-through", "--all", "--no-color"], env);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /FOLLOW-THROUGH/);
  assert.match(all.stdout, /alarms \(WARN or FAIL\): 2/);
  assert.match(cli(["help"]).stdout, /calibrate <repo> --follow-through/);
});
