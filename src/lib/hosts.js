import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatTerminalSummary } from "./output.js";
import { commandExists, runCommand } from "./tools.js";

const SERVER_NAME = "solumbe";
const PACKAGE_NAME = "@bashbop/solumbe";
const CODEX_TABLE = `mcp_servers.${SERVER_NAME}`;
const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

/**
 * Agent hosts `solumbe install --host` can connect. JSON hosts are written
 * directly; CLI hosts go through the host's own `mcp add` so its config format
 * (TOML for Codex, the live ~/.claude.json for Claude Code) is not hand-edited.
 * The one exception is a Codex CLI with no `mcp add`: see installCodexConfig.
 * @typedef {"claude-code" | "claude-desktop" | "codex" | "cursor" | "vscode" | "gemini" | "kimi"} HostId
 */

/** @type {HostId[]} */
export const HOST_IDS = ["claude-code", "claude-desktop", "codex", "cursor", "vscode", "gemini", "kimi"];

/** @type {Record<HostId, string>} */
const HOST_LABELS = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex CLI",
  cursor: "Cursor",
  vscode: "VS Code",
  gemini: "Gemini CLI",
  kimi: "Kimi Code CLI",
};

/**
 * @typedef {object} HostDeps
 * @property {string} [home]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [appData]
 * @property {string} [claudeConfigDir] the directory that holds Claude Code's .claude.json
 * @property {(command: string) => boolean} [has] whether a host CLI is on the PATH
 * @property {(command: string, args: string[]) => { ok: boolean, stdout: string, stderr: string }} [run]
 * @property {ServerLaunch} [launch]
 * @property {(launch: ServerLaunch) => { ok: boolean, detail: string }} [verify]
 *
 * @typedef {object} ServerLaunch
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string>} [env]
 * @property {string} [note]
 *
 * @typedef {object} HostResult
 * @property {HostId} host
 * @property {string} label
 * @property {"planned" | "configured" | "unchanged" | "skipped" | "error"} status
 * @property {string} detail
 * @property {string} [configPath]
 * @property {string} [backupPath]
 * @property {string[]} [keptEnv] names of the variables carried over from the entry that was replaced, never their values
 * @property {string[]} [warnings]
 */

// An env block can hold a key, so only variable names are ever printed.
const HIDDEN = "<hidden>";

/**
 * How a host should start the server. GUI hosts (Claude Desktop, Cursor,
 * VS Code) do not inherit a shell PATH, so a bare `solumbe` or `#!/usr/bin/env
 * node` fails there under nvm, Volta or Homebrew. Pinning the absolute node
 * binary and CLI path works for every host.
 * @param {{ execPath?: string, cli?: string, platform?: NodeJS.Platform }} [options]
 * @returns {ServerLaunch}
 */
export function resolveServerLaunch(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const cli = options.cli ?? cliPath;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  // npx runs from a cache npm may clean at any time; pinning that path would
  // break the host later, so start through npx and give it a PATH that finds node.
  if (cli.split(/[\\/]/).includes("_npx")) {
    const binDir = pathApi.dirname(execPath);
    const separator = platform === "win32" ? ";" : ":";
    const systemPath = platform === "win32" ? "C:\\Windows\\System32" : "/usr/local/bin:/usr/bin:/bin";
    return {
      command: pathApi.join(binDir, platform === "win32" ? "npx.cmd" : "npx"),
      args: ["-y", PACKAGE_NAME, "mcp"],
      env: { PATH: `${binDir}${separator}${systemPath}` },
      note: `Running from npx, so hosts will start Solumbe through npx. Install it with \`npm install -g ${PACKAGE_NAME}\` for faster, offline starts.`,
    };
  }

  return { command: execPath, args: [cli, "mcp"] };
}

/**
 * @param {HostId} host
 * @param {Required<Pick<HostDeps, "home" | "platform">> & { appData?: string }} deps
 * @returns {{ file: string, key: "mcpServers" | "servers", stdioType: boolean } | undefined}
 */
function jsonHostConfig(host, { home, platform, appData }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const roaming = appData ?? pathApi.join(home, "AppData", "Roaming");
  /** @param {string} dir */
  const appSupport = (dir) =>
    platform === "darwin"
      ? pathApi.join(home, "Library", "Application Support", dir)
      : platform === "win32"
        ? pathApi.join(roaming, dir)
        : pathApi.join(home, ".config", dir);

  switch (host) {
    case "claude-desktop":
      return { file: pathApi.join(appSupport("Claude"), "claude_desktop_config.json"), key: "mcpServers", stdioType: true };
    case "cursor":
      return { file: pathApi.join(home, ".cursor", "mcp.json"), key: "mcpServers", stdioType: false };
    case "vscode":
      return { file: pathApi.join(appSupport("Code"), "User", "mcp.json"), key: "servers", stdioType: true };
    case "gemini":
      return { file: pathApi.join(home, ".gemini", "settings.json"), key: "mcpServers", stdioType: false };
    case "kimi":
      return { file: pathApi.join(home, ".kimi-code", "mcp.json"), key: "mcpServers", stdioType: false };
    default:
      return undefined;
  }
}

/**
 * @param {string} value
 * @returns {HostId[] | { error: string }}
 */
export function parseHostList(value) {
  const requested = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!requested.length) {
    return { error: `--host needs a value: all, or one or more of ${HOST_IDS.join(", ")}` };
  }
  if (requested.includes("all")) {
    return [...HOST_IDS];
  }
  const unknown = requested.filter((item) => !HOST_IDS.includes(/** @type {HostId} */ (item)));
  if (unknown.length) {
    return { error: `Unknown host: ${unknown.join(", ")}. Use all, or one or more of ${HOST_IDS.join(", ")}` };
  }
  return /** @type {HostId[]} */ ([...new Set(requested)]);
}

/**
 * Connect Solumbe's MCP server to agent hosts.
 * @param {{ hosts: HostId[], all?: boolean, dryRun?: boolean, canvasUrl?: string }} options
 *   `all` limits the run to hosts found on this machine; naming a host always configures it.
 * @param {HostDeps} [deps]
 * @returns {{ ok: boolean, dryRun: boolean, launch: ServerLaunch, serverCheck?: { ok: boolean, detail: string }, results: HostResult[] }}
 */
export function installHosts(options, deps = {}) {
  const home = deps.home ?? os.homedir();
  const platform = deps.platform ?? process.platform;
  const appData = deps.appData ?? process.env.APPDATA;
  const has = deps.has ?? ((command) => commandExists(command).available);
  const run = deps.run ?? ((command, args) => runCommand(command, args, { timeout: 30000 }));
  const launch = deps.launch ?? resolveServerLaunch({ platform });
  const dryRun = Boolean(options.dryRun);
  // Claude Code keeps its user-scope servers here, under CLAUDE_CONFIG_DIR when that is set.
  const claudeConfig = path.join(deps.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || home), ".claude.json");

  const verify = deps.verify ?? verifyServerLaunch;
  // Prove the exact command every host will run answers an MCP handshake
  // before writing it anywhere; a config that cannot start helps nobody.
  const serverCheck = dryRun ? undefined : verify(launch);
  if (serverCheck && !serverCheck.ok) {
    return { ok: false, dryRun, launch, serverCheck, results: [] };
  }

  const results = options.hosts.map((host) => {
    /** @type {Record<string, string>} */
    const env = { ...launch.env };
    if (options.canvasUrl) {
      env.SOLUMBE_CANVAS_URL = options.canvasUrl;
      env.SOLUMBE_HOST = host;
    }
    /** @type {{ command: string, args: string[], env?: Record<string, string> }} */
    const entry = { command: launch.command, args: [...launch.args], ...(Object.keys(env).length ? { env } : {}) };

    if (host === "claude-code") {
      return installClaudeCode(entry, { dryRun, all: options.all, has, run, configFile: claudeConfig });
    }
    if (host === "codex") {
      return installCodex(entry, { dryRun, all: options.all, has, run, home });
    }
    const config = /** @type {NonNullable<ReturnType<typeof jsonHostConfig>>} */ (jsonHostConfig(host, { home, platform, appData }));
    return installJsonHost(host, config, entry, { dryRun, all: options.all });
  });

  return {
    ok: results.every((result) => result.status !== "error"),
    dryRun,
    launch,
    serverCheck,
    results,
  };
}

/**
 * Start the server the way a host would and send one `initialize` request.
 * @param {ServerLaunch} launch
 * @returns {{ ok: boolean, detail: string }}
 */
export function verifyServerLaunch(launch) {
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "solumbe-install", version: "1" } },
  };
  const result = spawnSync(launch.command, launch.args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...launch.env },
  });
  const answered = (result.stdout ?? "").split("\n").some((line) => {
    try {
      return JSON.parse(line)?.result?.serverInfo?.name === PACKAGE_NAME;
    } catch {
      return false;
    }
  });
  if (answered) {
    return { ok: true, detail: "the server answered an MCP initialize request" };
  }
  const reason = result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n")[0];
  return { ok: false, detail: `the server did not answer an MCP initialize request: ${reason}` };
}

/**
 * @param {HostId} host
 * @param {{ file: string, key: "mcpServers" | "servers", stdioType: boolean }} config
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, all?: boolean }} options
 * @returns {HostResult}
 */
function installJsonHost(host, config, entry, options) {
  const label = HOST_LABELS[host];
  const base = { host, label, configPath: config.file };

  if (options.all && !fs.existsSync(path.dirname(config.file))) {
    return { ...base, status: "skipped", detail: "not found on this machine" };
  }

  /** @type {Record<string, unknown>} */
  let document = {};
  const exists = fs.existsSync(config.file);
  if (exists) {
    const raw = fs.readFileSync(config.file, "utf8");
    try {
      document = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {
        ...base,
        status: "error",
        detail: `could not parse ${config.file} (comments or trailing commas?). It was left unchanged; add the "${SERVER_NAME}" entry by hand.`,
      };
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      return { ...base, status: "error", detail: `${config.file} is not a JSON object. It was left unchanged.` };
    }
  }

  const servers = /** @type {Record<string, unknown>} */ (document[config.key] && typeof document[config.key] === "object" ? document[config.key] : {});
  const existing = existingEnv(servers[SERVER_NAME]);
  const { entry: next, keptEnv } = carryEnv(entry, existing.env);
  const desired = config.stdioType ? { type: "stdio", ...next } : next;
  const warnings = [
    ...staleEntryWarnings(
      Object.entries(servers).map(([name, value]) => ({ name, value })),
      label,
    ),
    ...(existing.unreadable ? [envNotCarried(label, "its env is not a JSON object")] : []),
  ];

  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(desired)) {
    return { ...base, status: "unchanged", detail: "already connected", warnings };
  }

  const action = servers[SERVER_NAME] ? "replace the existing solumbe entry" : "add a solumbe entry";
  if (options.dryRun) {
    return { ...base, status: "planned", detail: `would ${action}`, keptEnv, warnings };
  }

  /** @type {string | undefined} */
  let backupPath;
  try {
    fs.mkdirSync(path.dirname(config.file), { recursive: true });
    if (exists) {
      backupPath = `${config.file}.solumbe.bak`;
      fs.copyFileSync(config.file, backupPath);
    }
    const next = { ...document, [config.key]: { ...servers, [SERVER_NAME]: desired } };
    fs.writeFileSync(config.file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return { ...base, status: "error", detail: `could not write ${config.file}: ${/** @type {Error} */ (error).message}` };
  }
  return {
    ...base,
    status: "configured",
    detail: `${action === "add a solumbe entry" ? "added" : "replaced"}; restart ${label} to load it`,
    backupPath,
    keptEnv,
    warnings,
  };
}

/**
 * The env an existing entry carries. `unreadable` marks one that is there but
 * is not an object, so it cannot be carried over.
 * @param {unknown} value an existing server entry
 * @returns {{ env: Record<string, string>, unreadable?: boolean }}
 */
function existingEnv(value) {
  const env = value && typeof value === "object" ? /** @type {{ env?: unknown }} */ (value).env : undefined;
  if (env === undefined || env === null) {
    return { env: {} };
  }
  if (typeof env !== "object" || Array.isArray(env)) {
    return { env: {}, unreadable: true };
  }
  return { env: /** @type {Record<string, string>} */ (env) };
}

/**
 * Re-registering a host replaces its entry, so the variables the old entry
 * carried (a canvas URL, a check mode, a key) go onto the new one unchanged.
 * A variable this run sets itself wins.
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {Record<string, string>} existing
 * @returns {{ entry: { command: string, args: string[], env?: Record<string, string> }, keptEnv: string[] }}
 */
function carryEnv(entry, existing) {
  const env = { ...existing, ...entry.env };
  return {
    entry: Object.keys(env).length ? { ...entry, env } : entry,
    keptEnv: Object.keys(existing).filter((name) => !(name in (entry.env ?? {}))),
  };
}

/**
 * @param {Record<string, string>} [env]
 * @returns {Record<string, string>}
 */
function hideValues(env) {
  return Object.fromEntries(Object.keys(env ?? {}).map((name) => [name, HIDDEN]));
}

/**
 * @param {string} label
 * @param {string} why
 * @returns {string}
 */
function envNotCarried(label, why) {
  return `${label}: could not read an existing ${SERVER_NAME} entry (${why}), so any env it had is not carried over. Add those variables back by hand.`;
}

/**
 * @param {string} label
 * @param {string[]} keptEnv
 * @returns {string}
 */
function envLost(label, keptEnv) {
  return `${label}: the old ${SERVER_NAME} entry was removed before the add failed. It carried ${keptEnv.join(", ")}; set them again when you add it.`;
}

/**
 * The env on Claude Code's user-scope entry. The user config is read first
 * because its JSON is exact; `claude mcp get` is asked when that file is missing
 * or cannot be parsed, and its text is trusted only when it shows the user scope.
 * @param {string} configFile
 * @param {NonNullable<HostDeps["run"]>} run
 * @returns {{ env: Record<string, string>, unreadable?: boolean }}
 */
function claudeCodeEnv(configFile, run) {
  try {
    const document = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (document && typeof document === "object" && !Array.isArray(document)) {
      return existingEnv(document.mcpServers?.[SERVER_NAME]);
    }
  } catch {
    // No readable user config; ask the CLI.
  }
  const shown = run("claude", ["mcp", "get", SERVER_NAME]);
  if (!shown.ok) {
    // "No MCP server named ..." means there is nothing to carry.
    return /no mcp server/i.test(`${shown.stdout}${shown.stderr}`) ? { env: {} } : { env: {}, unreadable: true };
  }
  const lines = shown.stdout.split(/\r?\n/);
  if (!lines.some((line) => /^\s*Scope:\s*User\b/.test(line))) {
    return { env: {}, unreadable: true };
  }
  /** @type {Record<string, string>} */
  const env = {};
  const start = lines.findIndex((line) => line.trim() === "Environment:");
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const match = /^\s+([^\s=]+)=(.*)$/.exec(line);
    if (!match) {
      break;
    }
    env[match[1]] = match[2];
  }
  return { env };
}

/**
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, all?: boolean, has: (command: string) => boolean, run: NonNullable<HostDeps["run"]>, configFile: string }} options
 * @returns {HostResult}
 */
function installClaudeCode(entry, { dryRun, all, has, run, configFile }) {
  const base = { host: /** @type {HostId} */ ("claude-code"), label: HOST_LABELS["claude-code"] };
  if (!has("claude")) {
    return all
      ? { ...base, status: "skipped", detail: "not found on this machine" }
      : { ...base, status: "error", detail: "the claude CLI is not on the PATH. Run this install again once it is." };
  }

  const existing = claudeCodeEnv(configFile, run);
  const { entry: next, keptEnv } = carryEnv(entry, existing.env);
  const warnings = existing.unreadable ? [envNotCarried(base.label, `${configFile} and \`claude mcp get ${SERVER_NAME}\``)] : [];
  if (dryRun) {
    const shown = JSON.stringify({ type: "stdio", ...next, ...(next.env ? { env: hideValues(next.env) } : {}) });
    return { ...base, status: "planned", detail: `would run: claude mcp add-json ${SERVER_NAME} '${shown}' --scope user`, keptEnv, warnings };
  }
  // add-json refuses to overwrite, so clear any old user-scope entry first.
  const removed = run("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  const added = run("claude", ["mcp", "add-json", SERVER_NAME, JSON.stringify({ type: "stdio", ...next }), "--scope", "user"]);
  if (!added.ok) {
    return {
      ...base,
      status: "error",
      detail: `claude mcp add-json failed: ${(added.stderr || added.stdout).trim()}`,
      warnings: [...warnings, ...(removed.ok && keptEnv.length ? [envLost(base.label, keptEnv)] : [])],
    };
  }
  return { ...base, status: "configured", detail: "added at user scope; start a new Claude Code session to load it", keptEnv, warnings };
}

/**
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, all?: boolean, has: (command: string) => boolean, run: NonNullable<HostDeps["run"]>, home: string }} options
 * @returns {HostResult}
 */
function installCodex(entry, { dryRun, all, has, run, home }) {
  const base = { host: /** @type {HostId} */ ("codex"), label: HOST_LABELS.codex };
  if (!has("codex")) {
    return all
      ? { ...base, status: "skipped", detail: "not found on this machine" }
      : { ...base, status: "error", detail: "the codex CLI is not on the PATH. Run this install again once it is." };
  }

  // Asked before anything is run or planned, so a dry run can name the path too.
  if (!run("codex", ["mcp", "add", "--help"]).ok) {
    return installCodexConfig(entry, { dryRun, home });
  }

  const listed = run("codex", ["mcp", "list", "--json"]);
  /** @type {{ name: string, value: unknown }[]} */
  let existing = [];
  /** @type {ReturnType<typeof existingEnv>} */
  let own = { env: {}, unreadable: true };
  try {
    const servers = /** @type {{ name: string, transport?: unknown }[]} */ (JSON.parse(listed.stdout));
    existing = servers.map((server) => ({ name: server.name, value: server.transport }));
    const mine = servers.find((server) => server.name === SERVER_NAME);
    // The env sits on the transport, or on the server itself in earlier listings.
    own = existingEnv(mine?.transport ?? mine);
  } catch {
    // Older Codex builds have no --json listing; stale-entry warnings are best effort.
  }
  const { entry: next, keptEnv } = carryEnv(entry, own.env);
  const warnings = [
    ...staleEntryWarnings(existing, HOST_LABELS.codex, "codex mcp remove"),
    ...(own.unreadable ? [envNotCarried(base.label, "`codex mcp list --json` did not show it")] : []),
  ];
  /** @param {Record<string, string>} env */
  const addArgs = (env) => [
    "mcp",
    "add",
    SERVER_NAME,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--",
    next.command,
    ...next.args,
  ];

  if (dryRun) {
    return { ...base, status: "planned", detail: `would run: codex ${addArgs(hideValues(next.env)).join(" ")}`, keptEnv, warnings };
  }
  const removed = run("codex", ["mcp", "remove", SERVER_NAME]);
  const added = run("codex", addArgs(next.env ?? {}));
  if (!added.ok) {
    return {
      ...base,
      status: "error",
      detail: `codex mcp add failed: ${(added.stderr || added.stdout).trim()}`,
      warnings: [...warnings, ...(removed.ok && keptEnv.length ? [envLost(base.label, keptEnv)] : [])],
    };
  }
  return { ...base, status: "configured", detail: "added to ~/.codex/config.toml; start a new Codex session to load it", keptEnv, warnings };
}

/**
 * A Codex CLI with no `codex mcp add` (0.31.0: `codex mcp` runs Codex as an MCP
 * server and rejects any subcommand) still reads servers from config.toml, so
 * the entry is written there. Only the solumbe table changes; every other line
 * is carried over as it was.
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, home: string }} options
 * @returns {HostResult}
 */
function installCodexConfig(entry, { dryRun, home }) {
  const file = path.join(home, ".codex", "config.toml");
  const base = { host: /** @type {HostId} */ ("codex"), label: HOST_LABELS.codex, configPath: file };
  const exists = fs.existsSync(file);
  const raw = exists ? fs.readFileSync(file, "utf8") : "";
  const plan = planCodexTable(raw, entry);
  const { keptEnv } = plan;
  const warnings = [
    ...staleEntryWarnings(plan.servers, HOST_LABELS.codex),
    ...(plan.unreadable ? [envNotCarried(base.label, `its env in ${file} is not a table of strings`)] : []),
  ];

  if (plan.blocked) {
    return {
      ...base,
      status: "error",
      detail: `${file} sets the ${SERVER_NAME} server inline or with dotted keys, which is not rewritten. It was left unchanged; replace that with a [${CODEX_TABLE}] table by hand.`,
      warnings,
    };
  }
  if (plan.next === raw) {
    return { ...base, status: "unchanged", detail: "already connected", warnings };
  }

  const reason = "this Codex CLI has no `codex mcp add`";
  if (dryRun) {
    return { ...base, status: "planned", detail: `would ${plan.action} the [${CODEX_TABLE}] table directly: ${reason}`, keptEnv, warnings };
  }

  /** @type {string | undefined} */
  let backupPath;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (exists) {
      backupPath = `${file}.solumbe.bak`;
      fs.copyFileSync(file, backupPath);
    }
    fs.writeFileSync(file, plan.next);
  } catch (error) {
    return { ...base, status: "error", detail: `could not write ${file}: ${/** @type {Error} */ (error).message}`, warnings };
  }
  return {
    ...base,
    status: "configured",
    detail: `${plan.action === "add" ? "added" : "replaced"} the [${CODEX_TABLE}] table directly (${reason}); start a new Codex session to load it`,
    backupPath,
    keptEnv,
    warnings,
  };
}

/**
 * The config.toml text with the solumbe table set to `entry`. An existing
 * table, and any `[mcp_servers.solumbe.*]` sub-table, is replaced where it
 * stands, keeping the env it carried; otherwise the table is added at the end.
 * @param {string} raw the current file, "" when there is none
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @returns {{ next: string, action: "add" | "replace", blocked: boolean, servers: { name: string, value: string }[], keptEnv: string[], unreadable?: boolean }}
 *   `blocked` when the server is set in a form a second table would collide with;
 *   `unreadable` when the existing table has an env that could not be carried over.
 */
function planCodexTable(raw, entry) {
  const lines = raw.split("\n");
  const kinds = classifyTomlLines(lines);
  /** @type {Map<string, { name: string, value: string }>} */
  const servers = new Map();
  /** @type {{ start: number, end: number }[]} */
  const regions = [];
  /** @type {string[] | undefined} */
  let table = [];
  /** @type {{ name: string, value: string } | undefined} */
  let server;
  let blocked = false;

  lines.forEach((line, index) => {
    const kind = kinds[index];
    if (kind === "header") {
      table = line.trimStart().startsWith("[[") ? undefined : tomlKeyPath(line, line.indexOf("[") + 1, "]");
      const name = table?.[0] === "mcp_servers" ? table[1] : undefined;
      server = name === undefined ? undefined : (servers.get(name) ?? { name, value: "" });
      if (server) {
        servers.set(server.name, server);
      }
      if (name === SERVER_NAME) {
        regions.push({ start: index, end: index });
      }
    } else if (kind !== "blank" && server) {
      server.value += line;
      if (server.name === SERVER_NAME) {
        regions[regions.length - 1].end = index;
      }
    } else if (kind === "statement" && table) {
      // `mcp_servers = { … }` at the root, or solumbe set by an inline table or dotted keys.
      const keys = tomlKeyPath(line, 0, "=");
      const full = keys ? [...table, ...keys] : [];
      blocked ||= full[0] === "mcp_servers" && (full.length === 1 || full[1] === SERVER_NAME);
    }
  });
  const existing = codexTableEnv(lines, kinds, regions);
  const { entry: next, keptEnv } = carryEnv(entry, existing.env);
  const found = { blocked, servers: [...servers.values()], keptEnv, unreadable: existing.unreadable };
  // A JSON string is a valid TOML basic string, and a JSON array of them a TOML array.
  const env = Object.entries(next.env ?? {}).map(([key, value]) => `${/^[\w-]+$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(value)}`);
  const block = [
    `[${CODEX_TABLE}]`,
    `command = ${JSON.stringify(next.command)}`,
    `args = [${next.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ...(env.length ? [`env = { ${env.join(", ")} }`] : []),
  ];

  if (!regions.length) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const gap = !raw.trim() || /\n\r?\n$/.test(raw) ? "" : raw.endsWith("\n") ? eol : eol + eol;
    return { next: `${raw}${gap}${block.join(eol)}${eol}`, action: "add", ...found };
  }

  // A sub-table that follows its parent with only blank lines between is one stretch.
  /** @type {{ start: number, end: number }[]} */
  const stretches = [];
  for (const region of regions) {
    const last = stretches.at(-1);
    if (last && lines.slice(last.end + 1, region.start).every((line) => !line.trim())) {
      last.end = region.end;
    } else {
      stretches.push(region);
    }
  }
  const [first, ...rest] = stretches;
  for (const stretch of rest.reverse()) {
    lines.splice(stretch.start, stretch.end - stretch.start + 1);
  }
  const cr = raw.includes("\r\n") ? "\r" : "";
  const lastCr = lines[first.end].endsWith("\r") ? "\r" : "";
  lines.splice(first.start, first.end - first.start + 1, ...block.map((text, index) => text + (index === block.length - 1 ? lastCr : cr)));
  return { next: lines.join("\n"), action: "replace", ...found };
}

/**
 * The env the existing solumbe table carries: `env = { … }` or `env.KEY = …`
 * in the table itself, or the statements of a `[mcp_servers.solumbe.env]`
 * sub-table. Only one-line string values are read; any other marks it unreadable.
 * @param {string[]} lines
 * @param {ReturnType<typeof classifyTomlLines>} kinds
 * @param {{ start: number, end: number }[]} regions the solumbe table and its sub-tables, each opening on its header
 * @returns {{ env: Record<string, string>, unreadable?: boolean }}
 */
function codexTableEnv(lines, kinds, regions) {
  const string = /\s*(?:("(?:[^"\\]|\\.)*")|'([^']*)')\s*/y;
  const separator = /,|$/y;
  /**
   * @param {string} text
   * @param {number} from
   * @returns {{ value: string, end: number } | undefined}
   */
  const readString = (text, from) => {
    string.lastIndex = from;
    const match = string.exec(text);
    try {
      // A basic string that uses only JSON's escapes is read as JSON; a literal string is taken as written.
      return match ? { value: match[1] ? JSON.parse(match[1]) : match[2], end: string.lastIndex } : undefined;
    } catch {
      return undefined;
    }
  };
  /** @type {Record<string, string>} */
  const env = {};
  let readable = true;

  for (const { start, end } of regions) {
    const table = (tomlKeyPath(lines[start], lines[start].indexOf("[") + 1, "]") ?? []).slice(2);
    for (let index = start + 1; index <= end; index += 1) {
      const keys = kinds[index] === "statement" ? [...table, ...(tomlKeyPath(lines[index], 0, "=") ?? [])] : [];
      if (keys[0] !== "env") {
        continue;
      }
      // An env variable's name has no "=", so the first one is the assignment.
      const text = lines[index].slice(lines[index].indexOf("=") + 1);
      const oneLine = kinds[index + 1] !== "value";
      if (keys.length === 2) {
        // `env.KEY = "value"`, or `KEY = "value"` in the env sub-table.
        const read = oneLine ? readString(text, 0) : undefined;
        if (read && /^(#.*)?$/.test(text.slice(read.end))) {
          env[keys[1]] = read.value;
        } else {
          readable = false;
        }
        continue;
      }
      // `env = { KEY = "value", … }`.
      const pairs = keys.length === 1 && oneLine ? /^\s*\{(.*)\}\s*(#.*)?$/.exec(text)?.[1] : undefined;
      let at = 0;
      while (pairs?.slice(at).trim()) {
        const name = tomlKeyPath(pairs, at, "=");
        const read = name?.length === 1 ? readString(pairs, pairs.indexOf("=", at) + 1) : undefined;
        separator.lastIndex = read?.end ?? 0;
        if (!name || !read || !separator.test(pairs)) {
          break;
        }
        env[name[0]] = read.value;
        at = separator.lastIndex;
      }
      readable &&= pairs !== undefined && !pairs.slice(at).trim();
    }
  }
  return readable ? { env } : { env: {}, unreadable: true };
}

/**
 * What each line of a TOML document is. Multi-line strings and arrays are
 * tracked so a `[` inside a value is never read as a table header.
 * @param {string[]} lines
 * @returns {("header" | "statement" | "value" | "blank")[]} `value` continues the statement above; `blank` covers comment lines
 */
function classifyTomlLines(lines) {
  let quote = ""; // the multi-line string delimiter still open: `"""` or `'''`
  let depth = 0; // arrays and inline tables still open
  return lines.map((line) => {
    const text = line.trim();
    const kind = quote || depth > 0 ? "value" : !text || text.startsWith("#") ? "blank" : text.startsWith("[") ? "header" : "statement";
    if (kind === "blank" || kind === "header") {
      return kind;
    }
    for (let at = 0; at < line.length; at += 1) {
      const char = line[at];
      if (quote) {
        if (char === "\\" && quote === '"""') {
          at += 1;
        } else if (line.startsWith(quote, at)) {
          at += 2;
          quote = "";
        }
      } else if (char === "#") {
        break;
      } else if (char === '"' || char === "'") {
        if (line.startsWith(char.repeat(3), at)) {
          quote = char.repeat(3);
          at += 2;
        } else {
          for (at += 1; at < line.length && line[at] !== char; at += 1) {
            if (char === '"' && line[at] === "\\") {
              at += 1;
            }
          }
        }
      } else if (char === "[" || char === "{") {
        depth += 1;
      } else if (char === "]" || char === "}") {
        depth -= 1;
      }
    }
    return kind;
  });
}

/**
 * Read a dotted TOML key (`a."b c".d`) starting at `from` and closed by `end`.
 * @param {string} line
 * @param {number} from
 * @param {"]" | "="} end
 * @returns {string[] | undefined} undefined when it is not a key this reader understands
 */
function tomlKeyPath(line, from, end) {
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([\w-]+))\s*([.\]=])/y;
  part.lastIndex = from;
  /** @type {string[]} */
  const keys = [];
  for (let match = part.exec(line); match; match = part.exec(line)) {
    keys.push(match[1] ?? match[2] ?? match[3]);
    if (match[4] !== ".") {
      return match[4] === end ? keys : undefined;
    }
  }
  return undefined;
}

/**
 * Entries under another name that still launch Solumbe, or the package's
 * pre-4.0.0 name matched below, are usually leftovers from a manual setup and
 * often point at paths that no longer exist. They are reported, never removed.
 * @param {{ name: string, value: unknown }[]} entries
 * @param {string} label
 * @param {string} [removeHint]
 * @returns {string[]}
 */
function staleEntryWarnings(entries, label, removeHint) {
  return entries
    .filter(({ name, value }) => name !== SERVER_NAME && /solumbe|otito/i.test(JSON.stringify(value ?? ""))) // rebrand-keep
    .map(({ name }) =>
      removeHint
        ? `${label} also has "${name}", which launches Solumbe too. Remove it if it is a leftover: ${removeHint} ${name}`
        : `${label} also has "${name}", which launches Solumbe too. Remove it if it is a leftover.`,
    );
}

/**
 * @param {ReturnType<typeof installHosts>} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 * @param {import("./output.js").ClosingLine} [close]
 * @returns {string}
 */
export function formatHostInstallSummary(result, options = {}, close) {
  const warnings = result.results.flatMap((item) => item.warnings ?? []);
  return formatTerminalSummary({
    title: "Solumbe · connect agent hosts",
    glyph: "🔌",
    subtitle: result.dryRun ? "dry run: nothing was changed" : undefined,
    facts: /** @type {[string, string | number][]} */ ([
      ["Server command", [result.launch.command, ...result.launch.args].join(" ")],
      ...(result.serverCheck ? [["Server check", result.serverCheck.ok ? "answers MCP" : result.serverCheck.detail]] : []),
    ]),
    sections: [
      {
        title: "Hosts",
        glyph: "🧩",
        items: result.results.map(
          (item) =>
            `${item.label}: ${item.status}, ${item.detail}${item.keptEnv?.length ? `; keeps env ${item.keptEnv.join(", ")}` : ""}${item.configPath ? ` (${item.configPath})` : ""}`,
        ),
      },
      ...(warnings.length || result.launch.note
        ? [{ title: "Check", glyph: "⚠️", items: [...(result.launch.note ? [result.launch.note] : []), ...warnings] }]
        : []),
    ],
    close,
    options,
  });
}
