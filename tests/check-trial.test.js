import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyCheckTrial, checkArm, checkLogPath, formatCheckTrialMarkdown, generateCheckTrial, readDecisions, requestHash } from "../src/lib/check-trial.js";

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `check-trial-${prefix}-`)));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

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
const trialEnv = (extra = {}) => ({ SOLUMBE_CHECK_MODE: "trial", ...extra });

/** A head that lands in the wanted arm at the default share. */
function headInArm(root, arm) {
  for (let i = 0; i < 500; i++) {
    const head = String(i).padStart(40, "0");
    if (checkArm({ root, head }, trialEnv()).arm === arm) return head;
  }
  throw new Error(`no head found in the ${arm} arm`);
}

test("the trial is off unless asked for, and a change stays in one arm", () => {
  assert.deepEqual(checkArm({ root: "/repo", head: "abc" }, {}), { mode: "advisory", arm: "advisory", share: null });
  const first = checkArm({ root: "/repo", head: "abc" }, trialEnv());
  assert.equal(first.mode, "trial");
  assert.ok(["shown", "withheld"].includes(first.arm));
  assert.equal(first.share, 0.5);
  assert.deepEqual(checkArm({ root: "/repo", head: "abc" }, trialEnv()), first, "the same change always lands in the same arm");
  assert.equal(checkArm({ root: "/repo", head: "abc" }, trialEnv({ SOLUMBE_CHECK_SHOWN_SHARE: "1" })).arm, "shown");
  assert.equal(checkArm({ root: "/repo", head: "abc" }, trialEnv({ SOLUMBE_CHECK_SHOWN_SHARE: "0" })).arm, "withheld");
  assert.equal(checkArm({ root: "/repo", head: "abc" }, trialEnv({ SOLUMBE_CHECK_SHOWN_SHARE: "nonsense" })).share, 0.5);

  // Roughly half of changes land in each arm.
  const shown = Array.from({ length: 400 }, (_, i) => checkArm({ root: "/repo", head: `head-${i}` }, trialEnv()).arm).filter((arm) => arm === "shown").length;
  assert.ok(shown > 150 && shown < 250, `shown ${shown} of 400`);
});

test("the decision log path follows SOLUMBE_CHECK_LOG and can be switched off", () => {
  assert.equal(checkLogPath({ SOLUMBE_CHECK_LOG: "off" }), null);
  assert.equal(checkLogPath({ SOLUMBE_CHECK_LOG: "/tmp/decisions.jsonl" }), "/tmp/decisions.jsonl");
  assert.match(String(checkLogPath({})), /\.solumbe[\\/]check-decisions\.jsonl$/);
});

test("outside the trial a result is returned untouched and nothing is logged", () => {
  const root = initRepo("off");
  commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed");
  const log = path.join(root, "decisions.jsonl");
  const result = { ok: true, verdict: "WARN", repo: { root, name: "fixture" }, checks: [] };
  const applied = applyCheckTrial("review_gate", {}, result, { env: { SOLUMBE_CHECK_LOG: log } });
  assert.equal(applied.result, result);
  assert.equal(applied.decision, null);
  assert.equal(fs.existsSync(log), false);

  // Inside it, a tool the trial does not cover and the pull request gate are left alone too.
  const env = trialEnv({ SOLUMBE_CHECK_LOG: log, SOLUMBE_CHECK_SHOWN_SHARE: "0" });
  assert.equal(applyCheckTrial("context_pack", {}, result, { env }).decision, null);
  const prResult = { ...result, pr: { number: 7 } };
  assert.equal(applyCheckTrial("review_gate", { pr: "7" }, prResult, { env }).result, prResult);
  assert.equal(fs.existsSync(log), false);
});

test("the withheld arm records the result and tells the agent only that it was recorded", () => {
  const root = initRepo("withheld");
  const head = commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed");
  const log = path.join(os.tmpdir(), `check-trial-log-${process.pid}-withheld.jsonl`);
  fs.rmSync(log, { force: true });
  const env = trialEnv({ SOLUMBE_CHECK_LOG: log, SOLUMBE_CHECK_SHOWN_SHARE: "0" });

  const score = { ok: true, task: "add refunds", convergence: 41, band: "drift", receipt: { id: "rcpt_1" }, repo: { root, name: "fixture" } };
  const applied = applyCheckTrial("convergence_score", { query: "add refunds", base: "HEAD" }, score, { env });
  assert.equal(applied.result.withheld, true);
  assert.equal(applied.result.ok, true);
  assert.match(applied.result.message, /not an error/);
  assert.equal(applied.result.convergence, undefined, "the score itself is not in what the agent sees");
  assert.doesNotMatch(JSON.stringify(applied.result), /drift|41/);

  // The markdown form is withheld the same way.
  const pair = applyCheckTrial(
    "convergence_score",
    { query: "add refunds", includeMarkdown: true },
    { data: score, markdown: "# Convergence: 41/100 (drift)" },
    { env },
  );
  assert.equal(pair.result.data.withheld, true);
  assert.doesNotMatch(pair.result.markdown, /41|drift/);

  const [decision] = readDecisions(log);
  assert.equal(decision.tool, "convergence_score");
  assert.equal(decision.arm, "withheld");
  assert.equal(decision.withheld, true);
  assert.equal(decision.head, head);
  assert.equal(decision.root, root);
  assert.equal(decision.convergence, 41);
  assert.equal(decision.band, "drift");
  assert.equal(decision.requestHash, requestHash("add refunds"));
  assert.doesNotMatch(JSON.stringify(decision), /add refunds/, "the log holds a hash of the request, not its text");
  fs.rmSync(log, { force: true });
});

test("a blocking FAIL is shown in the withheld arm, and the shown arm is never altered", () => {
  const root = initRepo("blocking");
  commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed");
  const log = path.join(os.tmpdir(), `check-trial-log-${process.pid}-blocking.jsonl`);
  fs.rmSync(log, { force: true });
  const withheldEnv = trialEnv({ SOLUMBE_CHECK_LOG: log, SOLUMBE_CHECK_SHOWN_SHARE: "0" });
  const failing = {
    ok: true,
    verdict: "FAIL",
    repo: { root, name: "fixture" },
    checks: [{ name: "Secret safety", status: "FAIL", summary: "A credential was found." }],
  };
  const blocked = applyCheckTrial("review_gate", {}, failing, { env: withheldEnv });
  assert.equal(blocked.result, failing, "a blocking failure reaches the agent whatever the arm");
  assert.equal(blocked.decision.arm, "withheld");
  assert.equal(blocked.decision.withheld, false);
  assert.equal(blocked.decision.shownBecause, "blocking-fail");

  const warning = { ok: true, verdict: "WARN", repo: { root, name: "fixture" }, checks: [] };
  assert.equal(applyCheckTrial("review_gate", {}, warning, { env: withheldEnv }).result.withheld, true);
  const shown = applyCheckTrial("review_gate", {}, warning, { env: trialEnv({ SOLUMBE_CHECK_LOG: log, SOLUMBE_CHECK_SHOWN_SHARE: "1" }) });
  assert.equal(shown.result, warning);
  assert.equal(shown.decision.arm, "shown");
  assert.equal(readDecisions(log).length, 3);
  fs.rmSync(log, { force: true });
});

test("the trial is graded per change, by assigned arm, against the repaired outcome", () => {
  const root = initRepo("grade");
  const seed = commit(root, { "src/a.js": lines("export function a() {", "  return 1;", "}"), "src/b.js": lines("export const b = 1;") }, "chore: seed", 90);
  // Two changes: one later repaired, one not. Which arm each head is in is
  // read back, not chosen: assignment is a hash.
  const repaired = commit(root, { "src/a.js": lines("export function a() {", "  return 2;", "}") }, "feat: change a", 80);
  const kept = commit(root, { "src/b.js": lines("export const b = 2;") }, "feat: change b", 70);
  const fix = commit(root, { "src/a.js": lines("export function a() {", "  return 3;", "}") }, "fix: a returned the wrong value", 60);
  const young = commit(root, { "src/c.js": lines("export const c = 1;") }, "feat: add c", 5);

  const log = path.join(os.tmpdir(), `check-trial-log-${process.pid}-grade.jsonl`);
  const decision = (head, extra = {}) => ({
    v: 1,
    ts: "2026-09-01T00:00:00.000Z",
    tool: "review_gate",
    root,
    head,
    mode: "trial",
    arm: checkArm({ root, head }, trialEnv()).arm,
    withheld: false,
    shownBecause: null,
    ...extra,
  });
  const unbuilt = headInArm(root, "shown");
  fs.writeFileSync(
    log,
    [
      // Two checks on the head the repaired change was built on: one unit.
      decision(seed),
      decision(seed, { tool: "convergence_score" }),
      decision(repaired),
      // The commit made on this head is the fix: an outcome, not a change to grade.
      decision(kept),
      // The commit made on this one is younger than the window, so it is censored.
      decision(fix),
      // A head nothing was ever committed on.
      decision(unbuilt),
      // Another repository's decisions are not this one's.
      { ...decision(seed), root: "/somewhere/else" },
      "not json",
    ]
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n"),
  );

  const data = generateCheckTrial(root, { log, minSample: 1 });
  assert.equal(data.log.decisions, 6);
  assert.equal(data.range.changes, 5);
  assert.equal(data.range.committed, 4);
  assert.equal(data.range.graded, 2);
  const row = (head) => data.changes.find((entry) => entry.head === head);
  assert.equal(row(seed).checks, 2);
  assert.equal(row(seed).commit, repaired);
  assert.ok(row(seed).repairedAfter !== null);
  assert.equal(row(repaired).commit, kept);
  assert.equal(row(repaired).repairedAfter, null);
  assert.equal(row(kept).commit, fix);
  assert.deepEqual([row(kept).isFix, row(kept).gradable], [true, false], "a fix commit is the outcome, so it is not graded");
  assert.equal(row(fix).commit, young);
  assert.equal(row(fix).gradable, false, "a commit younger than the window is censored");
  assert.equal(row(unbuilt).commit, null);

  const armOf = (head) => data.arms.find((arm) => arm.name === row(head).arm);
  assert.equal(
    data.arms.reduce((sum, arm) => sum + arm.changes, 0),
    5,
  );
  assert.equal(
    data.arms.reduce((sum, arm) => sum + arm.fixCommits, 0),
    1,
  );
  assert.equal(
    data.arms.reduce((sum, arm) => sum + arm.censored, 0),
    1,
  );
  assert.equal(
    data.arms.reduce((sum, arm) => sum + arm.repaired.hits, 0),
    1,
  );
  assert.ok(armOf(seed).repaired.hits >= 1);
  assert.match(data.receipt.id, /^trial_[0-9a-f]{12}$/);

  const markdown = formatCheckTrialMarkdown(data);
  assert.match(markdown, /# Check trial/);
  assert.match(markdown, /\| shown \|/);
  assert.match(markdown, /\| withheld \|/);

  // Below the minimum sample nothing is claimed either way.
  const withheld = generateCheckTrial(root, { log });
  assert.equal(withheld.fewerRepairsWhenShown, null);
  assert.equal(withheld.arms[0].repaired.rate, null);
  fs.rmSync(log, { force: true });
});

const CLI = path.resolve("src/cli.js");
/** Run the CLI with telemetry off, so a test never writes to the user's log. */
function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, SOLUMBE_TELEMETRY: "0", ...env } });
}

test("solumbe calibrate --trial grades a decision log, and says when there is none to read", () => {
  const root = initRepo("cli");
  const seed = commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed", 90);
  commit(root, { "src/a.js": lines("export const a = 2;") }, "feat: change a", 80);
  commit(root, { "src/b.js": lines("export const b = 1;") }, "feat: add b", 5);
  const log = path.join(os.tmpdir(), `check-trial-log-${process.pid}-cli.jsonl`);
  fs.writeFileSync(
    log,
    `${JSON.stringify({ v: 1, ts: "2026-09-01T00:00:00.000Z", tool: "review_gate", root, head: seed, mode: "trial", arm: "shown", withheld: false })}\n`,
  );

  const json = cli(["calibrate", root, "--trial", "--log", log, "--min-sample", "1", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  const data = JSON.parse(json.stdout);
  assert.deepEqual([data.range.changes, data.range.graded], [1, 1]);

  const report = cli(["calibrate", root, "--trial", "--log", log, "--no-color"]);
  assert.match(report.stdout, /CHECK TRIAL/);
  assert.match(cli(["help"]).stdout, /calibrate <repo> --trial/);

  const off = cli(["calibrate", root, "--trial"], { SOLUMBE_CHECK_LOG: "off" });
  assert.equal(off.status, 1);
  assert.match(off.stderr, /SOLUMBE_CHECK_LOG is off/);
  fs.rmSync(log, { force: true });
});
