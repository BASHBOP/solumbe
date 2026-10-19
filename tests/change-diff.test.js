import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { addedLineNumbers, diffOrigin } from "../src/lib/change-diff.js";
import { generateConvergence } from "../src/lib/converge.js";
import { evaluateLocal, secretCheck } from "../src/lib/pass-local.js";

// Built from parts so this file never carries a literal credential.
const LEGACY_KEY = "AKIA" + "3F7QZL2MXN8RTVWB";
const ADDED_KEY = "AKIA" + "7K2PQRX9MZL4VTNB";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function write(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commit(root, files, message) {
  write(root, files);
  git(root, "add", "--all");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

/**
 * main: A (greeting) → C (farewell, lands after the branch point)
 * change: A → B (edits greeting)
 * Checked out on `change`.
 */
function divergedRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "change-diff-")));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  const branchPoint = commit(root, { "src/greeting.js": "export const greeting = (name) => `Hello, ${name}`;\n" }, "A");
  git(root, "checkout", "-q", "-b", "change");
  commit(root, { "src/greeting.js": "export const greeting = (name) => `Hello, ${name}!`;\n" }, "B");
  git(root, "checkout", "-q", "main");
  commit(root, { "src/farewell.js": "export const farewell = (name) => `Goodbye, ${name}`;\n" }, "C");
  git(root, "checkout", "-q", "change");
  return { root, branchPoint };
}

test("diffOrigin is the merge base once the base has moved on", (t) => {
  const { root, branchPoint } = divergedRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(diffOrigin(root, "main"), branchPoint);
  assert.notEqual(git(root, "rev-parse", "main"), branchPoint);
});

test("diffOrigin falls back to the base when there is no shared history", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "change-diff-orphan-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  const mainSha = commit(root, { "a.txt": "a\n" }, "main");
  git(root, "checkout", "-q", "--orphan", "other");
  git(root, "rm", "-q", "-rf", ".");
  commit(root, { "b.txt": "b\n" }, "other");
  assert.equal(diffOrigin(root, mainSha), mainSha);
});

// Regression (dogfood, bashbop-api 2026-10-06): main moved on while a branch
// was open, and every file main changed showed up as this change's drift.
test("the local gate and convergence ignore commits that landed on the base after the branch point", (t) => {
  const { root } = divergedRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, { "src/notes.js": "export const notes = [];\n" });
  git(root, "add", "src/notes.js");

  const gate = evaluateLocal(root, { base: "main" });
  assert.deepEqual(gate.changedFiles, ["src/greeting.js", "src/notes.js"]);

  // A staged subject stays the exact two trees named, so its receipt
  // re-verifies in a shallow clone. Pass the merge base as the base for it.
  const staged = evaluateLocal(root, { base: "main", staged: true });
  assert.ok(staged.changedFiles.includes("src/farewell.js"));
  const stagedFromMergeBase = evaluateLocal(root, { base: diffOrigin(root, "main"), staged: true });
  assert.deepEqual(stagedFromMergeBase.changedFiles, ["src/greeting.js", "src/notes.js"]);

  const converge = generateConvergence("update the greeting message", { path: root, base: "main" });
  assert.equal(converge.drivers.changedFiles, 2, `expected only the branch's files, got ${JSON.stringify(converge.drivers)}`);
  assert.ok(!JSON.stringify(converge.drivers).includes("farewell"), "main's own commit is not drift");
});

test("addedLineNumbers numbers added lines in the new file, across hunks", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "change-diff-lines-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const base = commit(root, { "a.txt": `${lines.join("\n")}\n`, "moved.txt": "same\n", "gone.txt": "bye\n" }, "base");

  const edited = [...lines];
  edited[1] = "line 2 changed";
  edited.splice(9, 0, "++ starts like a header");
  write(root, { "a.txt": `${edited.join("\n")}\n`, "new.txt": "one\ntwo\n" });
  git(root, "mv", "moved.txt", "renamed.txt");
  git(root, "rm", "-q", "gone.txt");
  git(root, "add", "--all");

  const added = addedLineNumbers(root, base, null);
  assert.ok(added);
  assert.deepEqual([...(added.get("a.txt") ?? [])], [2, 10]);
  assert.deepEqual([...(added.get("new.txt") ?? [])], [1, 2]);
  assert.deepEqual([...(added.get("renamed.txt") ?? [])], [], "a pure rename adds no text");
  assert.ok(!added.has("starts like a header"), "a body line starting with +++ is not a file header");
  assert.equal(addedLineNumbers(root, "no-such-ref", null), null);
});

// Regression (dogfood, bashbop-api 2026-10-06): review_gate flagged a
// credential-shaped placeholder on a line the change never touched.
test("the secret check answers for added lines only, and still catches an added credential", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "change-diff-secret-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "commit.gpgsign", "false");
  const legacy = `const LEGACY_KEY = "${LEGACY_KEY}";\nexport const settings = { region: "eu-west-2", key: LEGACY_KEY };\n`;
  commit(root, { "src/settings.js": legacy }, "base");

  write(root, { "src/settings.js": legacy.replace("eu-west-2", "eu-west-1") });
  const untouched = evaluateLocal(root, { base: "main" }).checks.find((check) => check.name === "Secret safety");
  assert.equal(untouched.status, "PASS", JSON.stringify(untouched));

  write(root, { "src/settings.js": `${legacy}export const backup = "${ADDED_KEY}";\n` });
  const added = evaluateLocal(root, { base: "main" }).checks.find((check) => check.name === "Secret safety");
  assert.equal(added.status, "FAIL");
  assert.ok(
    added.details.some((detail) => detail.startsWith("src/settings.js:3")),
    JSON.stringify(added.details),
  );

  write(root, { "src/settings.js": legacy.replace("eu-west-2", "eu-west-1"), "src/fresh.js": `export const key = "${ADDED_KEY}";\n` });
  const untracked = evaluateLocal(root, { base: "main" }).checks.find((check) => check.name === "Secret safety");
  assert.equal(untracked.status, "FAIL", "an untracked file is new in full");
});

test("secretCheck scans the whole file, and says so, when added lines are unknown", () => {
  const files = ["src/settings.js"];
  const content = () => `const LEGACY_KEY = "${LEGACY_KEY}";\n`;
  const narrowed = secretCheck(files, content, () => new Set([2]));
  assert.equal(narrowed.status, "PASS");

  const unknown = secretCheck(files, content, () => null);
  assert.equal(unknown.status, "FAIL");
  assert.ok(unknown.details.some((detail) => detail.startsWith("Scanned the whole file (added lines unknown)")));
});
