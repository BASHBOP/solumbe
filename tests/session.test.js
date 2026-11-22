import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatSessionMarkdown, runSession } from "../src/lib/session.js";

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("session composes context, declared intent, convergence and gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-session-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), ".solumbe/\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "session-fixture", scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(root, "src", "report.js"), "export function report() { return 'before'; }\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "baseline");
  fs.writeFileSync(path.join(root, "src", "report.js"), "export function report() { return 'after'; }\n");

  const result = runSession("update the report function", { path: root, base: "HEAD" });

  assert.equal(result.ok, true);
  assert.equal(result.schema, "solumbe.session/v1");
  assert.equal(result.intent.request, "update the report function");
  assert.equal(fs.existsSync(result.intentPath), true);
  assert.ok(result.context);
  assert.ok(result.impact);
  assert.ok(result.convergence.receipt);
  assert.ok(["PASS", "WARN", "FAIL"].includes(result.verdict));
  assert.match(formatSessionMarkdown(result), /Declared intent/);
  assert.match(formatSessionMarkdown(result), /Convergence/);
});
