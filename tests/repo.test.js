import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatGitSummary, gateInspectScripts, getGitInfo, inspectRepo } from "../src/lib/repo.js";

test("inspectRepo detects TypeScript repo basics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-repo-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture-cli",
      version: "1.2.3",
      type: "module",
      bin: {
        fixture: "./src/cli.js",
      },
      scripts: {
        test: "node --test",
      },
      main: "src/index.js",
    }),
  );
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;\n");
  fs.writeFileSync(path.join(root, "src", "cli.js"), "console.log('ok');\n");

  const result = inspectRepo(root);
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 3);
  assert.equal(result.languages[0].language, "TypeScript");
  assert.deepEqual(result.packageManagers, ["npm"]);
  assert.equal(result.package.name, "fixture-cli");
  assert.equal(result.package.version, "1.2.3");
  assert.equal(result.package.type, "module");
  assert.equal(result.scripts.test, "node --test");
  assert.deepEqual(result.scriptNames, ["test"], "inspect always reports script names");
  assert.ok(result.entrypoints.includes("src/index.js"));
  assert.ok(result.entrypoints.includes("src/index.ts"));
  assert.ok(result.entrypoints.includes("src/cli.js"));
});

test("inspectRepo caps the returned file list and flags truncation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-repo-cap-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cap-fixture" }));
  for (let i = 0; i < 260; i += 1) {
    fs.writeFileSync(path.join(root, "src", `mod-${String(i).padStart(3, "0")}.ts`), "export const x = 1;\n");
  }

  const result = inspectRepo(root);
  assert.ok(result.fileCount >= 260, "fileCount reports the true total");
  assert.equal(result.files.length, 200, "file list is capped at 200 paths");
  assert.equal(result.filesTruncated, true);
});

test("gateInspectScripts drops script bodies but keeps names unless opted in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-repo-scripts-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "scripts-fixture", scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }),
  );

  const full = inspectRepo(root);
  const gated = gateInspectScripts(full, false);
  assert.equal(gated.scripts, undefined, "default gating drops script command bodies");
  assert.deepEqual(gated.scriptNames, ["build", "test"], "script names survive gating");

  const opted = gateInspectScripts(inspectRepo(root), true);
  assert.equal(opted.scripts.build, "tsc -p tsconfig.json", "includeScripts:true keeps command bodies");
});

// Regression (dogfood, bashbop-go): a checkout ten commits behind origin/main
// reported "main @ ccbba9f (clean)", so every analysis ran on stale code.
test("getGitInfo and formatGitSummary report a checkout behind its upstream", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repo-behind-"));
  const git = (/** @type {string[]} */ ...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "T");
  fs.writeFileSync(path.join(root, "a.txt"), "1\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  git("branch", "remote-main");
  git("switch", "-q", "remote-main");
  fs.writeFileSync(path.join(root, "a.txt"), "2\n");
  git("commit", "-q", "-am", "two");
  git("switch", "-q", "main");
  git("branch", "--set-upstream-to=remote-main");

  const info = getGitInfo(root);
  assert.equal(info.behind, 1);
  assert.equal(info.upstream, "remote-main");
  assert.match(formatGitSummary(info), /\(clean, 1 behind remote-main\)$/);
});
