import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installHosts } from "../src/lib/hosts.js";
import { runCommand } from "../src/lib/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const postinstall = path.join(here, "..", "scripts", "postinstall.mjs");
const cli = path.join(here, "..", "src", "cli.js");

/**
 * @param {Record<string, string>} extraEnv
 * @returns {{ status: number | null, stderr: string }}
 */
function runPostinstall(extraEnv) {
  // Start from a clean slate for the guard vars so the host CI env can't leak in.
  const env = { ...process.env, CI: "", SOLUMBE_SKIP_POSTINSTALL: "", npm_config_global: "", ...extraEnv };
  const result = spawnSync(process.execPath, [postinstall], { env, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

test("postinstall runs doctor only on a global, non-CI install", () => {
  const result = runPostinstall({ npm_config_global: "true" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /Environment check/);
});

test("postinstall is silent for non-global installs", () => {
  const result = runPostinstall({});
  assert.equal(result.status, 0);
  assert.equal(result.stderr.trim(), "");
});

test("postinstall is skipped in CI and when opted out", () => {
  const inCi = runPostinstall({ npm_config_global: "true", CI: "1" });
  assert.equal(inCi.status, 0);
  assert.equal(inCi.stderr.trim(), "");

  const optedOut = runPostinstall({ npm_config_global: "true", SOLUMBE_SKIP_POSTINSTALL: "1" });
  assert.equal(optedOut.status, 0);
  assert.equal(optedOut.stderr.trim(), "");
});

test("postinstall always exits 0 (never fails an install)", () => {
  // Even with a bogus global flag value, the hook must not break the install.
  const result = runPostinstall({ npm_config_global: "true", PATH: "" });
  assert.equal(result.status, 0);
});

const launch = { command: "/opt/node/bin/node", args: ["/opt/solumbe/src/cli.js", "mcp"] };
const solumbeTable = ["[mcp_servers.solumbe]", 'command = "/opt/node/bin/node"', 'args = ["/opt/solumbe/src/cli.js", "mcp"]', ""].join("\n");

/**
 * A stand-in `codex` in a directory of its own, logging each call's arguments.
 * Shell, not node (#296): a node start alone can outlast a host CLI timeout on
 * a loaded machine.
 * @param {"mcp-add" | "0.31.0"} kind `0.31.0` rejects every `codex mcp <subcommand>` the way that release does
 */
function standInCodex(kind) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-codex-"));
  const log = path.join(bin, "calls.log");
  const answers =
    kind === "mcp-add"
      ? [
          'case "$1 $2" in',
          '  "mcp add")',
          '    [ "$3" = "--help" ] && echo "Usage: codex mcp add [OPTIONS] <NAME> -- <COMMAND>..."',
          "    exit 0 ;;",
          '  "mcp list")',
          "    echo '[]'",
          "    exit 0 ;;",
          '  "mcp remove")',
          "    exit 0 ;;",
          "esac",
        ]
      : [
          'if [ "$1" = "mcp" ] && [ $# -gt 1 ]; then',
          `  printf "error: unexpected argument '%s' found\\n\\nUsage: codex mcp [OPTIONS]\\n\\nFor more information, try '--help'.\\n" "$2" >&2`,
          "  exit 2",
          "fi",
        ];
  fs.writeFileSync(
    path.join(bin, "codex"),
    ["#!/bin/sh", `echo "$*" >> '${log}'`, ...answers, 'echo "unexpected codex args: $*" >&2', "exit 1", ""].join("\n"),
  );
  fs.chmodSync(path.join(bin, "codex"), 0o755);
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

/**
 * A home directory, optionally holding a `.codex/config.toml`.
 * @param {string} [toml]
 */
function codexHome(toml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-codex-home-"));
  const file = path.join(home, ".codex", "config.toml");
  if (toml !== undefined) {
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, toml);
  }
  return { home, file, backup: `${file}.solumbe.bak` };
}

/**
 * `installHosts` for Codex, with every `codex` call going to the stand-in.
 * @param {string} home
 * @param {ReturnType<typeof standInCodex>} codex
 * @param {{ dryRun?: boolean }} [options]
 */
function installCodex(home, codex, options = {}) {
  const result = installHosts(
    { hosts: ["codex"], ...options },
    {
      home,
      launch,
      verify: () => ({ ok: true, detail: "ok" }),
      has: (command) => command === "codex",
      run: (command, args) => runCommand(path.join(codex.bin, command), args),
    },
  );
  return result.results[0];
}

/**
 * A strict reader for the TOML these tests write: tables, and one-line string,
 * array and inline-table values. It fails on anything else, and on a table or
 * key that is defined twice.
 * @param {string} text
 * @returns {Record<string, any>}
 */
function readToml(text) {
  /** @type {Record<string, any>} */
  const root = {};
  let table = root;
  const tables = new Set();
  for (const line of text.split("\n").map((item) => item.trim())) {
    if (!line || line.startsWith("#")) continue;
    const header = /^\[([\w.-]+)\]$/.exec(line);
    if (header) {
      assert.ok(!tables.has(header[1]), `table ${header[1]} is defined twice`);
      tables.add(header[1]);
      table = header[1].split(".").reduce((node, key) => (node[key] ??= {}), root);
      continue;
    }
    const pair = /^([\w-]+) = (.+)$/.exec(line);
    assert.ok(pair, `not a key = value line: ${line}`);
    assert.ok(!(pair[1] in table), `key ${pair[1]} is defined twice`);
    table[pair[1]] = JSON.parse(pair[2].startsWith("{") ? pair[2].replace(/([\w-]+) = /g, '"$1": ') : pair[2]);
  }
  return root;
}

test("install --host codex --dry-run names the path it would take", () => {
  for (const [kind, expected] of /** @type {const} */ ([
    ["mcp-add", /^would run: codex mcp add solumbe -- /],
    ["0.31.0", /^would add the \[mcp_servers\.solumbe\] table directly: this Codex CLI has no `codex mcp add`$/],
  ])) {
    const codex = standInCodex(kind);
    const { home, file } = codexHome();
    const run = spawnSync(process.execPath, [cli, "install", "--host", "codex", "--dry-run", "--json"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${codex.bin}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });

    assert.equal(run.status, 0, run.stderr);
    const [result] = JSON.parse(run.stdout).results;
    assert.equal(result.status, "planned");
    assert.match(result.detail, expected);
    assert.equal(fs.existsSync(file), false);
    assert.equal(codex.calls().includes("mcp add --help"), true);
    assert.equal(
      codex.calls().some((call) => /^mcp (add solumbe|remove)/.test(call)),
      false,
    );
  }
});

test("a Codex CLI that has mcp add is still connected through it", () => {
  const codex = standInCodex("mcp-add");
  const original = '[mcp_servers.other]\ncommand = "other"\n';
  const { home, file, backup } = codexHome(original);

  const result = installCodex(home, codex);

  assert.equal(result.status, "configured");
  assert.deepEqual(codex.calls(), ["mcp add --help", "mcp list --json", "mcp remove solumbe", `mcp add solumbe -- ${launch.command} ${launch.args.join(" ")}`]);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.existsSync(backup), false);
});

test("a Codex CLI without mcp add gets the table written to config.toml", () => {
  const codex = standInCodex("0.31.0");
  const { home, file, backup } = codexHome();

  const result = installCodex(home, codex);

  assert.equal(result.status, "configured");
  assert.equal(result.configPath, file);
  assert.match(result.detail, /^added the \[mcp_servers\.solumbe\] table directly/);
  assert.equal(fs.readFileSync(file, "utf8"), solumbeTable);
  assert.deepEqual(readToml(fs.readFileSync(file, "utf8")), { mcp_servers: { solumbe: launch } });
  // Nothing was there to keep, and no `codex mcp` subcommand was tried after the probe.
  assert.equal(fs.existsSync(backup), false);
  assert.deepEqual(codex.calls(), ["mcp add --help"]);

  assert.equal(installCodex(home, codex).status, "unchanged");
  assert.equal(fs.readFileSync(file, "utf8"), solumbeTable);
  assert.equal(fs.existsSync(backup), false);
});

test("the config.toml fallback adds the table and leaves the rest of the file as it was", () => {
  const original = [
    "# Codex settings",
    'model = "gpt-5"',
    'notes = """',
    "[mcp_servers.solumbe] in a string is not a table",
    '"""',
    "",
    "[mcp_servers.bashbop-solumbe] # set up by hand",
    'command = "npx"',
    'args = ["-y", "@bashbop/solumbe", "mcp"]',
    "",
    "[tools]",
    "web_search = true",
  ].join("\n");
  const { home, file, backup } = codexHome(original);

  const result = installCodex(home, standInCodex("0.31.0"));

  assert.equal(result.status, "configured");
  assert.equal(result.backupPath, backup);
  assert.equal(fs.readFileSync(file, "utf8"), `${original}\n\n${solumbeTable}`);
  assert.equal(fs.readFileSync(backup, "utf8"), original);
  assert.match(result.warnings?.[0] ?? "", /"bashbop-solumbe", which launches Solumbe too/);
});

test("the config.toml fallback updates an existing solumbe table in place", () => {
  const before = [
    "# Codex settings",
    'model = "gpt-5"',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    'args = ["--flag"]',
    "",
    "# Solumbe, set up by hand",
    "",
  ].join("\n");
  const stale = [
    "[mcp_servers.solumbe]",
    'command = "node"',
    "args = [",
    '  "/gone/solumbe/src/cli.js", # moved since',
    '  "mcp",',
    "]",
    "",
    "[mcp_servers.solumbe.env]",
    'SOLUMBE_HOST = "codex"',
    "",
  ].join("\n");
  const after = ["", "# Keep this one last", "[tools]", "web_search = true", ""].join("\n");
  const { home, file, backup } = codexHome(before + stale + after);

  const result = installCodex(home, standInCodex("0.31.0"));

  assert.equal(result.status, "configured");
  assert.match(result.detail, /^replaced the \[mcp_servers\.solumbe\] table directly/);
  const written = fs.readFileSync(file, "utf8");
  assert.equal(written, before + solumbeTable + after);
  assert.deepEqual(readToml(written), {
    model: "gpt-5",
    mcp_servers: { other: { command: "other", args: ["--flag"] }, solumbe: launch },
    tools: { web_search: true },
  });
  assert.equal(fs.readFileSync(backup, "utf8"), before + stale + after);
});

test("the config.toml fallback writes the canvas environment as an inline table", () => {
  const { home, file } = codexHome('[mcp_servers.solumbe]\r\ncommand = "node"\r\n\r\n[tools]\r\nweb_search = true\r\n');
  const result = installHosts(
    { hosts: ["codex"], canvasUrl: "http://127.0.0.1:7801" },
    {
      home,
      launch,
      verify: () => ({ ok: true, detail: "ok" }),
      has: () => true,
      run: (command, args) => runCommand(path.join(standInCodex("0.31.0").bin, command), args),
    },
  );

  assert.equal(result.ok, true);
  const written = fs.readFileSync(file, "utf8");
  assert.equal(written.split("\r\n").length, written.split("\n").length);
  assert.deepEqual(readToml(written), {
    mcp_servers: { solumbe: { ...launch, env: { SOLUMBE_CANVAS_URL: "http://127.0.0.1:7801", SOLUMBE_HOST: "codex" } } },
    tools: { web_search: true },
  });
});

test("the config.toml fallback refuses a config that sets solumbe another way", () => {
  for (const original of ['[mcp_servers]\nsolumbe = { command = "node", args = ["mcp"] }\n', 'mcp_servers.solumbe.command = "node"\n', "mcp_servers = {}\n"]) {
    const { home, file, backup } = codexHome(original);

    const result = installCodex(home, standInCodex("0.31.0"));

    assert.equal(result.status, "error");
    assert.match(result.detail, /left unchanged/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(backup), false);
  }
});
