import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { formatRegretMarkdown, generateRegret, isolateGit, RELEASE_SUBJECT, rescoreRegret, wilson } from "../src/lib/regret.js";
import { TIERS } from "../src/lib/model-route.js";
import { getCodeMapCachePath } from "../src/lib/index-cache.js";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `regret-${prefix}-`));
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

/** A small history with one repaired change and one that stayed. */
function historyRepo(prefix) {
  const root = initRepo(prefix);
  commit(
    root,
    {
      "package.json": JSON.stringify({ name: "fixture", scripts: { test: "true" } }),
      "src/checkout.js": lines("export function checkout() {", "  return 1;", "}"),
    },
    "chore: seed",
    90,
  );
  const repaired = commit(root, { "src/checkout.js": lines("export function checkout() {", "  return 2;", "}") }, "feat: add refund handling to checkout", 80);
  const kept = commit(root, { "src/util.js": lines("export const util = 1;") }, "feat: add util", 70);
  const docs = commit(root, { "docs/guide.md": lines("# Guide") }, "docs: add a guide", 60);
  commit(root, { "src/checkout.js": lines("export function checkout() {", "  return 3;", "}") }, "fix: checkout returned the wrong total", 50);
  // Too young for a 30-day outcome: censored, never graded.
  const young = commit(root, { "src/young.js": lines("export const young = 1;") }, "feat: too recent to grade", 10);
  return { root, repaired, kept, docs, young };
}

test("regret replays each commit against its parent and joins to the same repaired outcome calibrate uses", async () => {
  const { root, repaired, kept, docs, young } = historyRepo("replay");
  const seen = [];
  const data = await generateRegret(root, { offline: true, minSample: 1, onProgress: (p) => seen.push(p.sha) });

  // The seed has no parent, the fix is the outcome, and the youngest commit
  // has not had its window yet; the docs-only commit is a request like any other.
  assert.equal(data.range.replayed, 3);
  assert.equal(data.range.censored, 1);
  assert.equal(data.range.docsOnly, 1);
  assert.deepEqual(data.commits.map((row) => row.sha).sort(), [repaired, kept, docs].sort());
  assert.ok(!data.commits.some((row) => row.sha === young), "a commit younger than the window is censored, not graded as unrepaired");
  assert.deepEqual(seen.sort(), [repaired, kept, docs].sort(), "progress reports every replayed commit");
  assert.equal(data.base.repaired, 1);
  assert.equal(data.base.publishable, true);
  assert.deepEqual(data.base.ci95, [0.061, 0.792], "a rate carries its Wilson interval");
  assert.equal(data.commits.find((row) => row.sha === repaired)?.repairedAfter !== null, true);
  assert.equal(data.commits.find((row) => row.sha === kept)?.repairedAfter, null);

  // Every commit carries a tier from both no-key variants, and none from the model.
  for (const row of data.commits) {
    assert.ok(TIERS.includes(row.tiers.deterministic), row.tiers.deterministic);
    assert.ok(TIERS.includes(row.tiers.offline), row.tiers.offline);
    assert.equal(row.tiers.jev, undefined);
    assert.equal(typeof row.answers.offline.specificity, "number");
  }
  assert.deepEqual(Object.keys(data.variants), ["deterministic", "offline"]);
  assert.deepEqual(Object.keys(data.questions), ["offline"]);
  assert.equal(data.model.source, "offline estimate");
  assert.equal(data.model.calls, 0);

  // Regret is counted per variant from the cheap lane only.
  for (const variant of Object.values(data.variants)) {
    const cheap = variant.tiers.find((row) => row.name === "cheap");
    assert.equal(variant.contradicted.ofCheap, cheap.n);
    assert.ok(variant.contradicted.n <= cheap.n);
    assert.equal(
      variant.tiers.reduce((sum, row) => sum + row.n, 0),
      3,
    );
    assert.equal(variant.base.n, 3, "each variant grades against its own rows");
  }

  // The temporary worktree is gone, and the repository has only its own.
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1, "the replay worktree must be removed");
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "the repository's own checkout is untouched");

  // Offline, the whole run is a pure function of repository state.
  const again = await generateRegret(root, { offline: true, minSample: 1 });
  assert.equal(again.receipt.id, data.receipt.id);
  assert.equal(data.receipt.replayable, true);

  const markdown = formatRegretMarkdown(data);
  assert.match(markdown, /# Route regret/);
  assert.match(markdown, /Contradicted:/);
  assert.match(markdown, /never a saving/);
  assert.doesNotMatch(markdown, /spend avoided/i);
});

test("with a key the model variant is graded beside the deterministic one, and a failed call costs a row, never the run", async () => {
  const { root } = historyRepo("jev");
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 2) throw new Error("socket hang up");
    return /** @type {any} */ ({
      ok: true,
      json: async () => ({
        model: "jev-test",
        usage: { input_tokens: 2000 },
        answers: {
          specificity: { type: "score", score: 2, confidence: 0.9, probabilities: [0.05, 0.05, 0.9] },
          blast_radius: { type: "score", score: 1, confidence: 0.8, probabilities: [0.2, 0.6, 0.2] },
          novelty: { type: "noul", noul: 0.7 },
        },
      }),
    });
  };
  const data = await generateRegret(root, { apiKey: "test-key", fetchImpl, minSample: 1 });

  assert.equal(calls, 3, "one call per replayed commit");
  assert.equal(data.model.source, "jev");
  assert.equal(data.model.name, "jev-test");
  assert.equal(data.model.calls, 2);
  assert.equal(data.model.failures, 1);
  assert.equal(data.model.billableTokens, 4000);
  assert.equal(data.model.costUsd, 0.000168, "priced with priceJevCall, once, from the total");
  assert.equal(data.receipt.replayable, false);

  const withModel = data.commits.filter((row) => row.tiers.jev !== undefined);
  const failed = data.commits.filter((row) => row.jevError);
  assert.equal(withModel.length, 2);
  assert.equal(failed.length, 1);
  assert.match(failed[0].jevError, /socket hang up/);
  // A maximally vague, cross-cutting, novel read pulls the tier below the deterministic one.
  assert.ok(TIERS.indexOf(withModel[0].tiers.jev) >= TIERS.indexOf(withModel[0].tiers.deterministic));
  assert.deepEqual(withModel[0].answers.jev, { specificity: 1, blast_radius: 0.5, novelty: 0.7 });

  assert.deepEqual(Object.keys(data.variants), ["deterministic", "offline", "jev"]);
  assert.equal(data.variants.jev.n, 2, "the model variant grades only the commits it answered");
  assert.equal(data.variants.jev.base.n, 2, "and its base rate is over those rows, not the corpus");
  assert.deepEqual(Object.keys(data.questions), ["offline", "jev"]);
  assert.equal(data.questions.jev[0].n, 2);
  assert.ok(data.caveats.some((caveat) => /not replayable/.test(caveat)));
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1);
});

test("--offline keeps a run keyless even when the environment has a key, and --max caps the replay newest first", async () => {
  const { root } = historyRepo("cap");
  const saved = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "should-not-be-used";
  try {
    const data = await generateRegret(root, { offline: true, max: 1, minSample: 1, fetchImpl: async () => assert.fail("offline must not call") });
    assert.equal(data.range.replayed, 1);
    assert.equal(data.range.max, 1);
    assert.equal(data.model.calls, 0);
    assert.match(data.commits[0].subject, /add a guide/, "newest gradable commit first");
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  }
});

test("help lists the regret command beside calibrate", () => {
  const result = spawnSync(process.execPath, [path.resolve("src/cli.js"), "help", "--all"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /solumbe regret <repo>/);
  assert.match(result.stdout, /grade route tiers against this repo's own history/);
});

test("the minimum-sample rule withholds every published rate, the base rate and the regret rate included", async () => {
  const { root } = historyRepo("minsample");
  const data = await generateRegret(root, { offline: true, minSample: 50 });
  assert.equal(data.base.rate, null);
  assert.equal(data.base.ci95, null);
  assert.equal(data.base.publishable, false);
  for (const variant of Object.values(data.variants)) {
    assert.equal(variant.base.rate, null);
    assert.equal(variant.monotonic, null);
    assert.equal(variant.contradicted.rate, null);
    assert.equal(variant.contradicted.ci95, null);
    for (const row of variant.tiers) {
      assert.equal(row.rate, null, `${row.name} withholds its rate`);
      assert.equal(row.lift, null, `${row.name} withholds its lift`);
      assert.equal(row.ci95, null);
      assert.equal(typeof row.repaired, "number", "counts are still reported");
    }
  }
  const markdown = formatRegretMarkdown(data);
  assert.match(markdown, /withheld/);
  assert.doesNotMatch(markdown, /\d+\.\d%/, "no percentage is printed below the minimum sample");
});

test("a run with nothing old enough to grade says so instead of grading the ungradable", async () => {
  const root = initRepo("young");
  commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed", 5);
  commit(root, { "src/a.js": lines("export const a = 2;") }, "feat: bump a", 1);
  await assert.rejects(() => generateRegret(root, { offline: true }), /younger than the 30-day window/);
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1);
});

test("wilson intervals are honest at the edges", () => {
  assert.deepEqual(wilson(0, 10), [0, 0.278]);
  assert.deepEqual(wilson(10, 10), [0.722, 1]);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  const [lo, hi] = wilson(50, 100);
  assert.ok(lo < 0.5 && hi > 0.5 && hi - lo < 0.2);
});

test("a run started from inside a git hook cannot redirect its checkouts onto the user's index, and leaves no cache orphan", async () => {
  const { root } = historyRepo("hook");
  const indexBefore = fs.readFileSync(path.join(root, ".git", "index"));
  let worktree = "";
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  // What a pre-commit or post-checkout hook inherits.
  process.env.GIT_DIR = path.join(root, ".git");
  process.env.GIT_INDEX_FILE = path.join(root, ".git", "index");
  process.env.GIT_WORK_TREE = root;
  try {
    const data = await generateRegret(root, { offline: true, minSample: 1, onProgress: (p) => (worktree = p.worktree) });
    assert.equal(data.range.replayed, 3);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main", "the user's checkout is untouched");
  assert.ok(indexBefore.equals(fs.readFileSync(path.join(root, ".git", "index"))), "the user's index is untouched");
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1);
  assert.ok(worktree, "progress names the replay worktree");
  assert.equal(fs.existsSync(worktree), false, "the replay worktree is gone");
  assert.equal(fs.existsSync(getCodeMapCachePath(worktree)), false, "no index-cache entry is created for the temporary worktree");
});

/** Many gradable commits, so a signal can land mid-replay. */
function longRepo(prefix, count) {
  const root = initRepo(prefix);
  commit(root, { "package.json": JSON.stringify({ name: "fixture" }), "src/a.js": lines("export const a = 0;") }, "chore: seed", 200);
  for (let index = 1; index <= count; index += 1) {
    commit(root, { [`src/m${index}.js`]: lines(`export const m${index} = ${index};`) }, `feat: add module ${index}`, 200 - index);
  }
  // The horizon is the newest commit; one well after the rest makes them all gradable.
  commit(root, { "src/late.js": lines("export const late = 1;") }, "chore: horizon", 0);
  return root;
}

test("no user hook, smudge filter or post-index-change notifier runs during a replay", async () => {
  const { root } = historyRepo("hooks");
  const marker = path.join(root, "..", `${path.basename(root)}-hook-ran`);
  for (const hook of ["post-checkout", "post-index-change"]) {
    const file = path.join(root, ".git", "hooks", hook);
    fs.writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
    fs.chmodSync(file, 0o755);
  }
  // A custom filter configured for every file: it would run on each checkout.
  fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "* filter=marker\n");
  git(root, "config", "filter.marker.smudge", `sh -c 'echo smudge >> "${marker}"; cat'`);

  const data = await generateRegret(root, { offline: true, minSample: 1 });
  assert.equal(data.range.replayed, 3);
  assert.equal(fs.existsSync(marker), false, fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "");
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1);
});

test("a caller's GIT_DIR cannot make the run replay a different repository", async () => {
  const { root: asked } = historyRepo("asked");
  const other = longRepo("other", 2);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(other, ".git");
  process.env.GIT_WORK_TREE = other;
  try {
    const data = await generateRegret(asked, { offline: true, minSample: 1 });
    assert.equal(fs.realpathSync(data.repo.root), fs.realpathSync(asked));
    assert.equal(data.range.replayed, 3);
    assert.equal(process.env.GIT_DIR, path.join(other, ".git"), "the caller's environment is restored afterwards");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(git(other, "worktree", "list").trim().split("\n").length, 1, "nothing was added to the other repository");
});

test("isolateGit restores the environment exactly, including keys it added", () => {
  const before = { ...process.env };
  const restore = isolateGit(".");
  assert.equal(process.env.GIT_LFS_SKIP_SMUDGE, "1");
  assert.ok(Number(process.env.GIT_CONFIG_COUNT) >= 5);
  restore();
  assert.deepEqual({ ...process.env }, before);
});

test("SIGINT mid-replay stops the run, removes the worktree and exits 130", async () => {
  const root = longRepo("signal", 12);
  const child = spawn(process.execPath, [path.resolve("src/cli.js"), "regret", root, "--offline", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let sent = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (!sent && /regret: 1\//.test(stderr)) {
      sent = true;
      child.kill("SIGINT");
    }
  });
  const code = await new Promise((resolve) => child.on("exit", (exitCode) => resolve(exitCode)));
  assert.ok(sent, stderr);
  assert.equal(code, 130, stderr);
  assert.match(stderr, /interrupted by SIGINT/);
  assert.doesNotMatch(stderr, /regret: 12\/12/, "the run stopped before the end");
  assert.equal(git(root, "worktree", "list").trim().split("\n").length, 1, "the replay worktree is gone");
});

test("errors name what is actually missing, and a binary-only commit is not docs-only", async () => {
  const lone = initRepo("lone");
  commit(lone, { "a.txt": "a\n" }, "chore: seed", 100);
  await assert.rejects(() => generateRegret(lone, { offline: true }), /no non-fix commit with a parent/);

  const root = initRepo("binary");
  commit(root, { "src/a.js": lines("export const a = 1;") }, "chore: seed", 100);
  const full = path.join(root, "logo.png");
  fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0]));
  const binary = commit(root, {}, "feat: update brand assets", 90);
  commit(root, { "src/late.js": lines("export const late = 1;") }, "chore: horizon", 0);
  const data = await generateRegret(root, { offline: true, minSample: 1 });
  const row = data.commits.find((entry) => entry.sha === binary);
  assert.ok(row, "the binary-only commit is replayed");
  assert.equal(row.docsOnly, false);
  assert.equal(data.range.docsOnly, 0);
});

/** A model that answers every call the same way, so a run can carry a jev variant offline. */
const jevFetch = async () =>
  /** @type {any} */ ({
    ok: true,
    json: async () => ({
      model: "jev-test",
      usage: { input_tokens: 2000 },
      answers: {
        specificity: { type: "score", score: 2, confidence: 0.9, probabilities: [0.05, 0.05, 0.9] },
        blast_radius: { type: "score", score: 1, confidence: 0.8, probabilities: [0.2, 0.6, 0.2] },
        novelty: { type: "noul", noul: 0.7 },
      },
    }),
  });

test("a saved run rescored with the shipped arithmetic reproduces every tier and route, and replays and calls nothing", async () => {
  const { root } = historyRepo("rescore");
  const data = await generateRegret(root, { apiKey: "test-key", fetchImpl: jevFetch, minSample: 1 });
  const saved = JSON.parse(JSON.stringify(data));
  // The repository is gone: a rescore can only be reading the saved rows.
  fs.rmSync(root, { recursive: true, force: true });

  const rescored = rescoreRegret(saved);

  for (const row of saved.commits) {
    assert.equal(typeof row.containment, "number", "every row keeps the signals scoreDecision reads");
    assert.ok(Array.isArray(row.riskPaths));
    assert.equal(row.inputs.jev.specificity.score, 2, "and the answers exactly as scored");
    assert.equal(row.inputs.jev.specificity.probabilities["names a symptom"], 0.9);
  }
  assert.deepEqual(
    rescored.commits.map((row) => [row.sha, row.tiers, row.routes]),
    data.commits.map((row) => [row.sha, row.tiers, row.routes]),
  );
  assert.deepEqual(rescored.variants, data.variants);
  assert.deepEqual(rescored.base, data.base);
  assert.deepEqual(rescored.questions, data.questions);
  assert.equal(rescored.method.rescoredFrom, data.receipt.id);
  assert.notEqual(rescored.receipt.id, data.receipt.id, "a rescore is its own run, traceable to the one it read");
  assert.equal(rescored.receipt.replayable, false, "the model's answers stay unreplayable; the rescore does not launder that");
  assert.ok(rescored.caveats.some((caveat) => /no commit was replayed and no model was called/.test(caveat)));
  assert.match(formatRegretMarkdown(rescored), /Rescored from `regret_[0-9a-f]{12}`/);
  assert.doesNotMatch(formatRegretMarkdown(data), /Rescored from/);

  const twice = rescoreRegret(JSON.parse(JSON.stringify(rescored)));
  assert.deepEqual(twice.variants, data.variants, "a rescore of a rescore is still the same grade");
  assert.equal(twice.method.rescoredFrom, rescored.receipt.id, "and names the run it read");
  assert.equal(twice.caveats.filter((caveat) => caveat.startsWith("Rescored from")).length, 1, "without stacking caveats");
});

test("a candidate arithmetic is graded on the same saved answers, and the grade follows it", async () => {
  const { root } = historyRepo("candidate");
  const saved = JSON.parse(JSON.stringify(await generateRegret(root, { apiKey: "test-key", fetchImpl: jevFetch, minSample: 1 })));
  const seen = [];
  const everythingPremium = (/** @type {any} */ input) => {
    seen.push(input);
    return /** @type {any} */ ({ tier: "premium", route: 0 });
  };

  const rescored = rescoreRegret(saved, { score: everythingPremium });

  assert.equal(seen.length, saved.commits.length * 3, "deterministic, offline and jev, once per row");
  assert.ok(
    seen.some((input) => input.answers.specificity.probabilities?.["names a symptom"] === 0.9),
    "the candidate reads the saved distribution",
  );
  assert.ok(seen.every((input) => typeof input.signals.containment === "number"));
  for (const variant of Object.values(rescored.variants)) {
    assert.equal(variant.contradicted.ofCheap, 0);
    assert.equal(variant.tiers.find((row) => row.name === "premium").n, saved.commits.length);
  }
  assert.deepEqual(rescored.base, saved.base, "the outcomes are the saved ones; only the tiers move");
});

test("rescore refuses a run that did not keep its inputs, and anything that is not a regret run", async () => {
  const { root } = historyRepo("old");
  const saved = JSON.parse(JSON.stringify(await generateRegret(root, { offline: true, minSample: 1 })));
  const before = {
    ...saved,
    regretEngineVersion: "0.2.0",
    commits: saved.commits.map(({ containment: _containment, riskPaths: _riskPaths, inputs: _inputs, ...row }) => row),
  };
  assert.throws(() => rescoreRegret(before), /saved by regret 0\.2\.0, which did not keep the signals and answers a rescore needs/);
  assert.throws(() => rescoreRegret({}), /needs the JSON of a `solumbe regret --json` run/);
});

test("the CLI rescores a saved run from a file, and says what --rescore needs when it has no path", async () => {
  const { root } = historyRepo("cli-rescore");
  const saved = await generateRegret(root, { offline: true, minSample: 1 });
  const file = path.join(root, "..", `${path.basename(root)}-run.json`);
  fs.writeFileSync(file, JSON.stringify(saved));

  const ok = spawnSync(process.execPath, [path.resolve("src/cli.js"), "regret", "--rescore", file, "--json"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const rescored = JSON.parse(ok.stdout);
  assert.equal(rescored.method.rescoredFrom, saved.receipt.id);
  assert.doesNotMatch(ok.stderr, /regret: \d+\//, "nothing is replayed, so there is no progress to report");

  const missing = spawnSync(process.execPath, [path.resolve("src/cli.js"), "regret", "--rescore"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--rescore needs the path of a saved `solumbe regret --json` run/);
});

test("release and version-bump commits are not graded, in a replay or in a rescore of a run that had graded them", async () => {
  for (const subject of [
    "chore(release): 2.26.5 [skip ci]",
    "chore: bump version to 1.4.0",
    "chore: release v1.2.0",
    "chore: prepare repoctx v0.3 release",
    "release: solumbe 1.2.0",
    "Release Repoctx 1.2",
    "1.2.3",
    "chore: Update schema snapshot after merge [skip ci]",
  ]) {
    assert.match(subject, RELEASE_SUBJECT, `tooling wrote "${subject}"`);
  }
  for (const subject of [
    "release: issue (#277)",
    "feat: Release advance update schema (#282)",
    "chore(deps-dev): bump @eslint/js from 9.39.4 to 10.0.0",
    "chore(ci): automate semantic versioning (#519)",
    "docs: mention 1.2.0 in the guide",
    "feat(bump): bump version",
  ]) {
    assert.doesNotMatch(subject, RELEASE_SUBJECT, `someone asked for "${subject}"`);
  }

  const { root, repaired, kept } = historyRepo("release");
  // Old enough to grade, and touching the files a release touches.
  const release = commit(
    root,
    { "package.json": JSON.stringify({ name: "fixture", version: "1.1.0", scripts: { test: "true" } }), "CHANGELOG.md": lines("# 1.1.0") },
    "chore(release): 1.1.0 [skip ci]",
    65,
  );
  const bump = commit(
    root,
    { "package.json": JSON.stringify({ name: "fixture", version: "1.2.0", scripts: { test: "true" } }) },
    "chore: bump version to 1.2.0",
    55,
  );

  const data = await generateRegret(root, { offline: true, minSample: 1 });
  const shas = data.commits.map((row) => row.sha);
  assert.ok(shas.includes(repaired) && shas.includes(kept), "requests are graded");
  assert.ok(!shas.includes(release) && !shas.includes(bump), "release commits are not");
  assert.equal(data.range.releaseCommits, 2);
  assert.equal(data.range.replayed, data.commits.length);
  assert.match(data.method.releaseCommitRule, /\[skip ci\]/);
  assert.ok(data.caveats.some((caveat) => /Release and version-bump commits are not graded/.test(caveat)));
  assert.match(formatRegretMarkdown(data), /2 release commits, not graded/);

  // A run saved before the rule graded them. Rescoring it grades the corpus a
  // fresh replay would, and says what left.
  const before = JSON.parse(JSON.stringify(data));
  const template = before.commits[0];
  before.commits.push({ ...template, sha: "f".repeat(40), subject: "chore(release): 9.9.9 [skip ci]", repairedAfter: null });
  before.range.releaseCommits = undefined;
  before.caveats = before.caveats.filter((caveat) => !/Release and version-bump/.test(caveat));
  delete before.method.releaseCommitRule;

  const rescored = rescoreRegret(before);
  assert.deepEqual(
    rescored.commits.map((row) => row.sha),
    data.commits.map((row) => row.sha),
    "the release row is gone and nothing else moved",
  );
  assert.deepEqual(rescored.variants, data.variants);
  assert.deepEqual(rescored.base, data.base);
  assert.equal(rescored.range.releaseCommits, 1);
  assert.equal(rescored.range.replayed, data.commits.length);
  assert.equal(rescored.caveats.filter((caveat) => /Release and version-bump/.test(caveat)).length, 1);
  assert.ok(rescored.caveats.some((caveat) => /^Dropped 1 release commit the saved run had graded/.test(caveat)));
  assert.match(formatRegretMarkdown(rescored), /1 release commits, not graded/);

  const twice = rescoreRegret(JSON.parse(JSON.stringify(rescored)));
  assert.equal(twice.range.releaseCommits, 1, "a rescore of a rescore does not count the drop again");
  assert.equal(twice.caveats.filter((caveat) => /^Dropped /.test(caveat)).length, 0);
  assert.equal(twice.caveats.filter((caveat) => /Release and version-bump/.test(caveat)).length, 1);

  const onlyReleases = { ...before, commits: before.commits.filter((row) => RELEASE_SUBJECT.test(row.subject)) };
  assert.throws(() => rescoreRegret(onlyReleases), /every commit in this run is a release or fix commit/);

  // A run saved under a narrower fix rule graded `hot-fix(...)` and `bug(...)`
  // subjects as requests. They are outcomes now, so they leave the corpus,
  // counted as fix commits, and the caveat says their own repairs are not
  // joined without a replay.
  const narrower = JSON.parse(JSON.stringify(data));
  narrower.commits.push({ ...template, sha: "e".repeat(40), subject: "hot-fix(payment): guest login", repairedAfter: null });
  narrower.commits.push({ ...template, sha: "d".repeat(40), subject: "bug(email): confirmation temps", repairedAfter: 60 });
  const widened = rescoreRegret(narrower);
  assert.deepEqual(
    widened.commits.map((row) => row.sha),
    data.commits.map((row) => row.sha),
    "the fix rows are gone and nothing else moved",
  );
  assert.equal(widened.range.fixCommits, data.range.fixCommits + 2);
  assert.equal(widened.range.releaseCommits, data.range.releaseCommits, "a fix row is not counted as a release");
  assert.match(widened.method.fixCommitRule, /hot-fix/);
  assert.ok(widened.caveats.some((caveat) => /^Dropped 2 fix commits the saved run had graded as requests/.test(caveat)));
  const widenedTwice = rescoreRegret(JSON.parse(JSON.stringify(widened)));
  assert.equal(widenedTwice.range.fixCommits, widened.range.fixCommits, "a rescore of a rescore does not count the drop again");
  assert.equal(widenedTwice.caveats.filter((caveat) => /^Dropped /.test(caveat)).length, 0);
});
