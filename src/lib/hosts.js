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
 * @property {string[]} [warnings]
 */

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
      return installClaudeCode(entry, { dryRun, all: options.all, has, run });
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
  const desired = config.stdioType ? { type: "stdio", ...entry } : entry;
  const warnings = staleEntryWarnings(
    Object.entries(servers).map(([name, value]) => ({ name, value })),
    label,
  );

  if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(desired)) {
    return { ...base, status: "unchanged", detail: "already connected", warnings };
  }

  const action = servers[SERVER_NAME] ? "replace the existing solumbe entry" : "add a solumbe entry";
  if (options.dryRun) {
    return { ...base, status: "planned", detail: `would ${action}`, warnings };
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
    warnings,
  };
}

/**
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, all?: boolean, has: (command: string) => boolean, run: NonNullable<HostDeps["run"]> }} options
 * @returns {HostResult}
 */
function installClaudeCode(entry, { dryRun, all, has, run }) {
  const base = { host: /** @type {HostId} */ ("claude-code"), label: HOST_LABELS["claude-code"] };
  const json = JSON.stringify({ type: "stdio", ...entry });
  const manual = `claude mcp add-json ${SERVER_NAME} '${json}' --scope user`;
  if (!has("claude")) {
    return all
      ? { ...base, status: "skipped", detail: "not found on this machine" }
      : { ...base, status: "error", detail: `the claude CLI is not on the PATH. Run this once it is: ${manual}` };
  }
  if (dryRun) {
    return { ...base, status: "planned", detail: `would run: ${manual}` };
  }
  // add-json refuses to overwrite, so clear any old user-scope entry first.
  run("claude", ["mcp", "remove", SERVER_NAME, "--scope", "user"]);
  const added = run("claude", ["mcp", "add-json", SERVER_NAME, json, "--scope", "user"]);
  if (!added.ok) {
    return { ...base, status: "error", detail: `claude mcp add-json failed: ${(added.stderr || added.stdout).trim()}` };
  }
  return { ...base, status: "configured", detail: "added at user scope; start a new Claude Code session to load it" };
}

/**
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @param {{ dryRun: boolean, all?: boolean, has: (command: string) => boolean, run: NonNullable<HostDeps["run"]>, home: string }} options
 * @returns {HostResult}
 */
function installCodex(entry, { dryRun, all, has, run, home }) {
  const base = { host: /** @type {HostId} */ ("codex"), label: HOST_LABELS.codex };
  const envArgs = Object.entries(entry.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const addArgs = ["mcp", "add", SERVER_NAME, ...envArgs, "--", entry.command, ...entry.args];
  if (!has("codex")) {
    return all
      ? { ...base, status: "skipped", detail: "not found on this machine" }
      : { ...base, status: "error", detail: `the codex CLI is not on the PATH. Run this once it is: codex ${addArgs.join(" ")}` };
  }

  // Asked before anything is run or planned, so a dry run can name the path too.
  if (!run("codex", ["mcp", "add", "--help"]).ok) {
    return installCodexConfig(entry, { dryRun, home });
  }

  const listed = run("codex", ["mcp", "list", "--json"]);
  /** @type {{ name: string, value: unknown }[]} */
  let existing = [];
  try {
    existing = /** @type {{ name: string, transport?: unknown }[]} */ (JSON.parse(listed.stdout)).map((server) => ({
      name: server.name,
      value: server.transport,
    }));
  } catch {
    // Older Codex builds have no --json listing; stale-entry warnings are best effort.
  }
  const warnings = staleEntryWarnings(existing, HOST_LABELS.codex, "codex mcp remove");

  if (dryRun) {
    return { ...base, status: "planned", detail: `would run: codex ${addArgs.join(" ")}`, warnings };
  }
  run("codex", ["mcp", "remove", SERVER_NAME]);
  const added = run("codex", addArgs);
  if (!added.ok) {
    return { ...base, status: "error", detail: `codex mcp add failed: ${(added.stderr || added.stdout).trim()}`, warnings };
  }
  return { ...base, status: "configured", detail: "added to ~/.codex/config.toml; start a new Codex session to load it", warnings };
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
  const warnings = staleEntryWarnings(plan.servers, HOST_LABELS.codex);

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
    return { ...base, status: "planned", detail: `would ${plan.action} the [${CODEX_TABLE}] table directly: ${reason}`, warnings };
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
    warnings,
  };
}

/**
 * The config.toml text with the solumbe table set to `entry`. An existing
 * table, and any `[mcp_servers.solumbe.*]` sub-table, is replaced where it
 * stands; otherwise the table is added at the end.
 * @param {string} raw the current file, "" when there is none
 * @param {{ command: string, args: string[], env?: Record<string, string> }} entry
 * @returns {{ next: string, action: "add" | "replace", blocked: boolean, servers: { name: string, value: string }[] }}
 *   `blocked` when the server is set in a form a second table would collide with.
 */
function planCodexTable(raw, entry) {
  // A JSON string is a valid TOML basic string, and a JSON array of them a TOML array.
  const env = Object.entries(entry.env ?? {}).map(([key, value]) => `${/^[\w-]+$/.test(key) ? key : JSON.stringify(key)} = ${JSON.stringify(value)}`);
  const block = [
    `[${CODEX_TABLE}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    ...(env.length ? [`env = { ${env.join(", ")} }`] : []),
  ];

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
  const found = { blocked, servers: [...servers.values()] };

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
        items: result.results.map((item) => `${item.label}: ${item.status}, ${item.detail}${item.configPath ? ` (${item.configPath})` : ""}`),
      },
      ...(warnings.length || result.launch.note
        ? [{ title: "Check", glyph: "⚠️", items: [...(result.launch.note ? [result.launch.note] : []), ...warnings] }]
        : []),
    ],
    close,
    options,
  });
}
