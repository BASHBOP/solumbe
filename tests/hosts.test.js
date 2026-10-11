import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatHostInstallSummary, installHosts, parseHostList, resolveServerLaunch, verifyServerLaunch } from "../src/lib/hosts.js";

const launch = { command: "/opt/node/bin/node", args: ["/opt/solumbe/src/cli.js", "mcp"] };
const verified = () => ({ ok: true, detail: "ok" });

/** @returns {string} */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-hosts-"));
}

/**
 * @param {string} home
 * @param {{ has?: string[], calls?: string[][], stdout?: Record<string, string> }} [options]
 */
function deps(home, options = {}) {
  const calls = options.calls ?? [];
  return {
    home,
    platform: /** @type {NodeJS.Platform} */ ("darwin"),
    launch,
    verify: verified,
    has: (/** @type {string} */ command) => (options.has ?? []).includes(command),
    run: (/** @type {string} */ command, /** @type {string[]} */ args) => {
      calls.push([command, ...args]);
      return { ok: true, stdout: options.stdout?.[[command, ...args].join(" ")] ?? "", stderr: "" };
    },
  };
}

test("parseHostList expands all and rejects unknown hosts", () => {
  assert.equal(/** @type {string[]} */ (parseHostList("all")).length, 7);
  assert.deepEqual(parseHostList("cursor, Codex,cursor"), ["cursor", "codex"]);
  assert.match(/** @type {{ error: string }} */ (parseHostList("cursr")).error, /Unknown host: cursr/);
  assert.match(/** @type {{ error: string }} */ (parseHostList("")).error, /needs a value/);
});

test("resolveServerLaunch pins absolute node and cli paths", () => {
  assert.deepEqual(resolveServerLaunch({ execPath: "/n/bin/node", cli: "/g/lib/node_modules/@bashbop/solumbe/src/cli.js", platform: "darwin" }), {
    command: "/n/bin/node",
    args: ["/g/lib/node_modules/@bashbop/solumbe/src/cli.js", "mcp"],
  });
});

test("resolveServerLaunch never pins a path inside the npx cache", () => {
  const result = resolveServerLaunch({ execPath: "/n/bin/node", cli: "/u/.npm/_npx/abc/node_modules/@bashbop/solumbe/src/cli.js", platform: "darwin" });
  assert.equal(result.command, "/n/bin/npx");
  assert.deepEqual(result.args, ["-y", "@bashbop/solumbe", "mcp"]);
  assert.match(result.env?.PATH ?? "", /^\/n\/bin:/);
  assert.match(result.note ?? "", /npm install -g @bashbop\/solumbe/);
});

test("installHosts merges into existing JSON configs, keeps other servers, and backs up", () => {
  const home = tempHome();
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  const original = { mcpServers: { other: { command: "other" }, solumbe: { command: "node", args: ["/gone/otito.mjs", "mcp"] } }, keep: true }; // rebrand-keep
  fs.writeFileSync(cursorFile, JSON.stringify(original));

  const result = installHosts({ hosts: ["cursor", "vscode"] }, deps(home));

  assert.equal(result.ok, true);
  const cursor = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
  assert.equal(cursor.keep, true);
  assert.deepEqual(cursor.mcpServers.other, { command: "other" });
  assert.deepEqual(cursor.mcpServers.solumbe, launch);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${cursorFile}.solumbe.bak`, "utf8")), original);

  const vscodeFile = path.join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(vscodeFile, "utf8")), { servers: { solumbe: { type: "stdio", ...launch } } });
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["configured", "configured"],
  );
});

test("installHosts is idempotent and reports leftover entries without removing them", () => {
  const home = tempHome();
  const geminiFile = path.join(home, ".gemini", "settings.json");
  fs.mkdirSync(path.dirname(geminiFile), { recursive: true });
  fs.writeFileSync(geminiFile, JSON.stringify({ mcpServers: { "old-otito": { command: "node", args: ["/x/otito/src/cli.js", "mcp"] } } })); // rebrand-keep

  installHosts({ hosts: ["gemini"] }, deps(home));
  const second = installHosts({ hosts: ["gemini"] }, deps(home));

  assert.equal(second.results[0].status, "unchanged");
  assert.match(second.results[0].warnings?.[0] ?? "", /"old-otito"/); // rebrand-keep
  assert.ok(JSON.parse(fs.readFileSync(geminiFile, "utf8")).mcpServers["old-otito"]); // rebrand-keep
});

test("installHosts refuses to rewrite a config it cannot parse", () => {
  const home = tempHome();
  const file = path.join(home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ // comment\n "mcpServers": {} }');

  const result = installHosts({ hosts: ["cursor"] }, deps(home));

  assert.equal(result.ok, false);
  assert.equal(result.results[0].status, "error");
  assert.equal(fs.readFileSync(file, "utf8"), '{ // comment\n "mcpServers": {} }');
});

test("installHosts dry run writes nothing and runs no host CLI", () => {
  const home = tempHome();
  /** @type {string[][]} */
  const calls = [];
  const result = installHosts(
    { hosts: ["cursor", "claude-code"], dryRun: true },
    { ...deps(home, { has: ["claude"], calls }), verify: () => assert.fail("dry run must not start the server") },
  );

  assert.deepEqual(
    result.results.map((item) => item.status),
    ["planned", "planned"],
  );
  assert.equal(fs.existsSync(path.join(home, ".cursor")), false);
  assert.deepEqual(calls, []);
});

test("installHosts with all skips hosts that are not on the machine", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".cursor"));

  const result = installHosts({ hosts: ["claude-code", "cursor", "kimi"], all: true }, deps(home));

  assert.deepEqual(
    result.results.map((item) => [item.host, item.status]),
    [
      ["claude-code", "skipped"],
      ["cursor", "configured"],
      ["kimi", "skipped"],
    ],
  );
  assert.equal(result.ok, true);
});

test("installHosts uses the claude and codex CLIs, replacing any old entry", () => {
  const home = tempHome();
  /** @type {string[][]} */
  const calls = [];
  const codexList = JSON.stringify([{ name: "bashbop-solumbe", transport: { command: "npx", args: ["-y", "@bashbop/solumbe"] } }]);
  const result = installHosts(
    { hosts: ["claude-code", "codex"], canvasUrl: "http://127.0.0.1:7801" },
    deps(home, { has: ["claude", "codex"], calls, stdout: { "codex mcp list --json": codexList } }),
  );

  assert.equal(result.ok, true);
  const env = { SOLUMBE_CANVAS_URL: "http://127.0.0.1:7801" };
  assert.deepEqual(calls, [
    ["claude", "mcp", "remove", "solumbe", "--scope", "user"],
    ["claude", "mcp", "add-json", "solumbe", JSON.stringify({ type: "stdio", ...launch, env: { ...env, SOLUMBE_HOST: "claude-code" } }), "--scope", "user"],
    ["codex", "mcp", "add", "--help"],
    ["codex", "mcp", "list", "--json"],
    ["codex", "mcp", "remove", "solumbe"],
    [
      "codex",
      "mcp",
      "add",
      "solumbe",
      "--env",
      "SOLUMBE_CANVAS_URL=http://127.0.0.1:7801",
      "--env",
      "SOLUMBE_HOST=codex",
      "--",
      ...[launch.command, ...launch.args],
    ],
  ]);
  assert.match(result.results[1].warnings?.[0] ?? "", /codex mcp remove bashbop-solumbe/);
});

test("installHosts errors for a named host whose CLI is missing", () => {
  const result = installHosts({ hosts: ["codex"] }, deps(tempHome()));
  assert.equal(result.ok, false);
  assert.match(result.results[0].detail, /codex CLI is not on the PATH/);
});

test("installHosts writes nothing when the server command does not start", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".cursor"));
  const result = installHosts({ hosts: ["cursor"] }, { ...deps(home), verify: () => ({ ok: false, detail: "boom" }) });

  assert.equal(result.ok, false);
  assert.deepEqual(result.results, []);
  assert.equal(fs.existsSync(path.join(home, ".cursor", "mcp.json")), false);
  assert.match(formatHostInstallSummary(result), /boom/);
});

test("verifyServerLaunch completes a real MCP handshake and rejects a non-server command", () => {
  assert.equal(verifyServerLaunch(resolveServerLaunch()).ok, true);
  const bad = verifyServerLaunch({ command: process.execPath, args: ["-e", "process.stdout.write('hello')"] });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /did not answer/);
});
