import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_KEYS,
  companionRepos,
  contextRepoPaths,
  gatePolicy,
  getConfigPath,
  listConfigSources,
  loadConfig,
  userConfigStatus,
  writeConfig,
} from "../src/lib/config.js";
import { isTelemetryEnabled } from "../src/lib/telemetry.js";

// Every loadConfig call pins XDG_CONFIG_HOME to its temp dir. An empty env
// still falls back to ~/.config/solumbe/config.json, so a developer who has run
// `solumbe config set telemetry true` would otherwise fail the defaults tests.
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-config-test-"));
}

test("CONFIG_KEYS lists all expected keys", () => {
  assert.ok(CONFIG_KEYS.includes("emoji"));
  assert.ok(CONFIG_KEYS.includes("color"));
  assert.ok(CONFIG_KEYS.includes("theme"));
  assert.ok(CONFIG_KEYS.includes("width"));
  assert.ok(CONFIG_KEYS.includes("policy"));
  assert.ok(CONFIG_KEYS.includes("governance"));
  assert.ok(CONFIG_KEYS.includes("telemetry"));
  assert.ok(CONFIG_KEYS.includes("telemetryShare"));
});

test("anonymous telemetry sharing is a separate opt-in", () => {
  const tmp = makeTmpDir();
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } }).telemetryShare, false);
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ telemetry: true, telemetryShare: false }));
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } }).telemetry, true);
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } }).telemetryShare, false, "local consent does not imply sharing");
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_TELEMETRY_SHARE: "1" } }).telemetryShare, true);
  fs.rmSync(tmp, { recursive: true });
});

test("telemetry defaults to off and SOLUMBE_TELEMETRY overrides it", () => {
  const tmp = makeTmpDir();
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } }).telemetry, false, "opt-in: off by default");
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ telemetry: true }));
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } }).telemetry, true, "config can enable it");
  assert.equal(loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_TELEMETRY: "0" } }).telemetry, false, "env overrides config");
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig returns built-in defaults when no files or env present", () => {
  const tmp = makeTmpDir();
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } });
  assert.equal(cfg.theme, "default");
  assert.equal(cfg.policy, "standard");
  assert.equal(cfg.governance, "team");
  assert.equal(cfg.emoji, undefined);
  assert.equal(cfg.color, undefined);
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig reads .solumberc.json from cwd", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ color: true, theme: "color" }));
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } });
  assert.equal(cfg.color, true);
  assert.equal(cfg.theme, "color");
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig reads the gate defaults, policy and governance, from .solumberc.json", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ policy: "high-risk", governance: "solo" }));
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } });
  assert.equal(cfg.policy, "high-risk");
  assert.equal(cfg.governance, "solo");
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig env vars override local config", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ color: true }));
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_COLOR: "false" } });
  assert.equal(cfg.color, false);
  fs.rmSync(tmp, { recursive: true });
});

test("NO_COLOR env var disables color regardless of config", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ color: true }));
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, NO_COLOR: "" } });
  assert.equal(cfg.color, false);
  fs.rmSync(tmp, { recursive: true });
});

test("SOLUMBE_EMOJI=1 sets emoji to true", () => {
  const tmp = makeTmpDir();
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_EMOJI: "1" } });
  assert.equal(cfg.emoji, true);
  fs.rmSync(tmp, { recursive: true });
});

test("SOLUMBE_WIDTH sets numeric width", () => {
  const tmp = makeTmpDir();
  const cfg = loadConfig({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_WIDTH: "100" } });
  assert.equal(cfg.width, 100);
  fs.rmSync(tmp, { recursive: true });
});

test("writeConfig creates file and writeConfig merges into existing", () => {
  const tmp = makeTmpDir();
  writeConfig({ color: true }, "local", tmp);
  const p = path.join(tmp, ".solumberc.json");
  assert.ok(fs.existsSync(p));
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(raw.color, true);

  // Second write merges rather than overwrites.
  writeConfig({ theme: "minimal" }, "local", tmp);
  const merged = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(merged.color, true);
  assert.equal(merged.theme, "minimal");
  fs.rmSync(tmp, { recursive: true });
});

test("getConfigPath returns local path inside cwd", () => {
  const tmp = makeTmpDir();
  const p = getConfigPath("local", tmp);
  assert.equal(p, path.join(tmp, ".solumberc.json"));
  fs.rmSync(tmp, { recursive: true });
});

test("listConfigSources annotates env override", () => {
  const tmp = makeTmpDir();
  const sources = listConfigSources({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp, SOLUMBE_COLOR: "false" } });
  const colorEntry = sources.find((s) => s.key === "color");
  assert.ok(colorEntry);
  assert.equal(colorEntry.source, "env");
  assert.equal(colorEntry.value, false);
  fs.rmSync(tmp, { recursive: true });
});

test("listConfigSources annotates local vs default", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ theme: "minimal" }));
  const sources = listConfigSources({ cwd: tmp, env: { XDG_CONFIG_HOME: tmp } });
  const themeEntry = sources.find((s) => s.key === "theme");
  assert.ok(themeEntry);
  assert.equal(themeEntry.source, "local");
  assert.equal(themeEntry.value, "minimal");
  const policyEntry = sources.find((s) => s.key === "policy");
  assert.ok(policyEntry);
  assert.equal(policyEntry.source, "default");
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig walks up to find .solumberc.json in parent", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ emoji: false }));
  const nested = path.join(tmp, "packages", "web");
  fs.mkdirSync(nested, { recursive: true });
  const cfg = loadConfig({ cwd: nested, env: { XDG_CONFIG_HOME: tmp } });
  assert.equal(cfg.emoji, false);
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig walks up from a relative cwd, such as an MCP tool's path: '.'", () => {
  const tmp = makeTmpDir();
  fs.writeFileSync(path.join(tmp, ".solumberc.json"), JSON.stringify({ governance: "solo" }));
  const nested = path.join(tmp, "packages", "web");
  fs.mkdirSync(nested, { recursive: true });
  const saved = process.cwd();
  process.chdir(nested);
  try {
    // path.dirname(".") is ".", so an unresolved walk ended where it began and
    // a gate on path "." fell back to team governance.
    assert.equal(loadConfig({ cwd: ".", env: { XDG_CONFIG_HOME: tmp } }).governance, "solo");
    assert.equal(loadConfig({ cwd: "..", env: { XDG_CONFIG_HOME: tmp } }).governance, "solo");
  } finally {
    process.chdir(saved);
  }
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig from a relative sibling path reads that path's config, not the cwd's", () => {
  const tmp = makeTmpDir();
  const here = path.join(tmp, "here");
  const there = path.join(tmp, "there");
  fs.mkdirSync(here);
  fs.mkdirSync(there);
  fs.writeFileSync(path.join(here, ".solumberc.json"), JSON.stringify({ governance: "solo" }));
  const saved = process.cwd();
  process.chdir(here);
  try {
    // Unresolved, the walk from "../there" went to "..", then to ".", and read
    // this directory's config: `solumbe pass ../there` gated there as solo.
    assert.equal(loadConfig({ cwd: "../there", env: { XDG_CONFIG_HOME: tmp } }).governance, "team");
  } finally {
    process.chdir(saved);
  }
  fs.rmSync(tmp, { recursive: true });
});

test("gatePolicy fills an omitted or blank policy and governance from the gated repository's config", () => {
  const tmp = makeTmpDir();
  const repo = path.join(tmp, "repo");
  const bare = path.join(tmp, "bare");
  fs.mkdirSync(repo);
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(repo, ".solumberc.json"), JSON.stringify({ policy: "high-risk", governance: "solo" }));
  const env = { XDG_CONFIG_HOME: tmp };

  assert.deepEqual(gatePolicy(repo, {}, env), { policy: "high-risk", governance: "solo" });
  assert.deepEqual(gatePolicy(repo, { policy: "standard", governance: "team" }, env), { policy: "standard", governance: "team" }, "an explicit value wins");
  assert.deepEqual(gatePolicy(repo, { policy: " ", governance: "" }, env), { policy: "high-risk", governance: "solo" }, "a blank value counts as omitted");
  assert.deepEqual(gatePolicy(bare, {}, env), { policy: "standard", governance: "team" }, "no config anywhere leaves the defaults");

  // The user config fills what the gated repository leaves out.
  fs.mkdirSync(path.join(tmp, "solumbe"));
  fs.writeFileSync(path.join(tmp, "solumbe", "config.json"), JSON.stringify({ governance: "solo" }));
  assert.deepEqual(gatePolicy(bare, {}, env), { policy: "standard", governance: "solo" });
  fs.rmSync(tmp, { recursive: true });
});

test("loadConfig honors XDG_CONFIG_HOME from the injected env (user tier)", () => {
  const tmp = makeTmpDir();
  const xdg = path.join(tmp, "xdg");
  fs.mkdirSync(path.join(xdg, "solumbe"), { recursive: true });
  fs.writeFileSync(path.join(xdg, "solumbe", "config.json"), JSON.stringify({ theme: "from-user-xdg" }));
  const cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd, { recursive: true });

  const cfg = loadConfig({ cwd, env: { XDG_CONFIG_HOME: xdg } });
  assert.equal(cfg.theme, "from-user-xdg");

  const sources = listConfigSources({ cwd, env: { XDG_CONFIG_HOME: xdg } });
  const themeSource = sources.find((entry) => entry.key === "theme");
  assert.equal(themeSource?.value, "from-user-xdg");
  assert.equal(themeSource?.source, "user");
  fs.rmSync(tmp, { recursive: true });
});

// The rename moved the user config to <config home>/solumbe. A telemetry
// opt-in left in the pre-rename file stopped applying, and usage capture
// went quiet with nothing reported.
test("a missing Solumbe user config falls back to the pre-rename file, under XDG_CONFIG_HOME", () => {
  const tmp = makeTmpDir();
  const legacyDir = path.join(tmp, "otito"); // rebrand-keep
  const legacy = path.join(legacyDir, "config.json");
  const current = path.join(tmp, "solumbe", "config.json");
  const env = { XDG_CONFIG_HOME: tmp };
  assert.deepEqual(userConfigStatus(env), { path: current, legacyPath: legacy, readPath: null, source: "none" });

  fs.mkdirSync(legacyDir);
  fs.writeFileSync(legacy, JSON.stringify({ telemetry: true, theme: "minimal" }));
  assert.deepEqual(userConfigStatus(env), { path: current, legacyPath: legacy, readPath: legacy, source: "legacy" });
  assert.equal(loadConfig({ cwd: tmp, env }).telemetry, true, "the old opt-in still applies");
  assert.equal(listConfigSources({ cwd: tmp, env }).find((entry) => entry.key === "theme")?.source, "user");
  assert.equal(isTelemetryEnabled({ env, cwd: tmp, fresh: true }), true, "usage capture stays on");

  // Once a Solumbe config exists it alone is read, even when it sets nothing.
  fs.mkdirSync(path.dirname(current));
  fs.writeFileSync(current, "{}");
  assert.equal(userConfigStatus(env).source, "solumbe");
  assert.equal(loadConfig({ cwd: tmp, env }).telemetry, false);
  assert.equal(isTelemetryEnabled({ env, cwd: tmp, fresh: true }), false);
  fs.rmSync(tmp, { recursive: true });
});

test("without XDG_CONFIG_HOME both user config paths sit under ~/.config", () => {
  const status = userConfigStatus({});
  assert.equal(status.path, path.join(os.homedir(), ".config", "solumbe", "config.json"));
  assert.equal(status.legacyPath, path.join(os.homedir(), ".config", "otito", "config.json")); // rebrand-keep
});

test("the first user config write carries the pre-rename settings over", () => {
  const tmp = makeTmpDir();
  const legacy = path.join(tmp, "otito", "config.json"); // rebrand-keep
  fs.mkdirSync(path.dirname(legacy));
  fs.writeFileSync(legacy, JSON.stringify({ telemetry: true, policy: "company" }));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  try {
    // writeConfig and getConfigPath read process.env, as the CLI does.
    writeConfig({ theme: "minimal" }, "user");
    assert.deepEqual(JSON.parse(fs.readFileSync(getConfigPath("user"), "utf8")), { telemetry: true, policy: "company", theme: "minimal" });
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
  assert.ok(fs.existsSync(legacy), "the old file is left in place");
  assert.equal(userConfigStatus({ XDG_CONFIG_HOME: tmp }).source, "solumbe");
  fs.rmSync(tmp, { recursive: true });
});

test("companions in .solumberc.json join a context pack's repositories", () => {
  const tmp = fs.realpathSync(makeTmpDir());
  const web = path.join(tmp, "web");
  const api = path.join(tmp, "api");
  fs.mkdirSync(web);
  fs.mkdirSync(api);
  assert.deepEqual(contextRepoPaths({ path: web }), [web], "no config, just the repository");
  fs.writeFileSync(path.join(web, ".solumberc.json"), JSON.stringify({ companions: ["../api", "../missing", 3, ".", ""] }));
  assert.deepEqual(companionRepos(web), [api, web], "resolved against the config file; missing dirs and non-strings drop out");
  assert.deepEqual(contextRepoPaths({ path: web }), [web, api], "the repository itself is not repeated");
  assert.deepEqual(contextRepoPaths({ path: web, paths: [api] }), [api], "explicit paths win");
  fs.rmSync(tmp, { recursive: true });
});
