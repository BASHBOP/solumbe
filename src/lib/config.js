import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Keys accepted in a config file or via env. */
const VALID_KEYS = new Set(["emoji", "color", "theme", "width", "policy", "governance", "telemetry", "telemetryShare"]);

/**
 * Built-in defaults. Only keys with stable defaults are listed; undefined keys
 * mean "auto-detect at render time" (e.g. emoji and color).
 */
const DEFAULTS = {
  theme: "default",
  policy: "standard",
  governance: "team",
  // Usage telemetry is strictly opt-in: off until the user turns it on.
  telemetry: false,
  // Anonymous remote sharing is a separate opt-in. Existing local telemetry
  // consent must never be silently widened into network transmission.
  telemetryShare: false,
};

/**
 * @typedef {object} ResolvedConfig
 * @property {boolean | undefined} emoji
 * @property {boolean | undefined} color
 * @property {string | undefined} theme
 * @property {number | undefined} width
 * @property {string | undefined} policy
 * @property {string | undefined} governance
 * @property {boolean | undefined} telemetry
 * @property {boolean | undefined} telemetryShare
 */

/**
 * @typedef {object} SourcedEntry
 * @property {string} key
 * @property {unknown} value
 * @property {"default" | "user" | "local" | "env"} source
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getUserConfigPath(env = process.env) {
  return path.join(userConfigBase(env), "solumbe", "config.json");
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function userConfigBase(env) {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? xdg : path.join(os.homedir(), ".config");
}

/**
 * @typedef {object} UserConfigStatus
 * @property {string} path The Solumbe user config, where writes go.
 * @property {string} legacyPath The user config from before the rename.
 * @property {string | null} readPath The file settings are read from, if any.
 * @property {"solumbe" | "legacy" | "none"} source
 */

/**
 * Which user config file is read. The Solumbe file wins whenever it exists.
 * Without it the pre-rename file is read, so the rename does not silently drop
 * its settings, the telemetry opt-in among them. Both honour XDG_CONFIG_HOME.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {UserConfigStatus}
 */
export function userConfigStatus(env = process.env) {
  const current = getUserConfigPath(env);
  const legacyPath = path.join(userConfigBase(env), "otito", "config.json"); // rebrand-keep
  if (fs.existsSync(current)) return { path: current, legacyPath, readPath: current, source: "solumbe" };
  if (fs.existsSync(legacyPath)) return { path: current, legacyPath, readPath: legacyPath, source: "legacy" };
  return { path: current, legacyPath, readPath: null, source: "none" };
}

/**
 * Walk up from cwd looking for .solumberc.json, stopping at the home dir.
 * A relative cwd (an MCP tool's `path: "."`) is resolved first: path.dirname
 * cannot climb above ".", so the walk would otherwise stop where it began, and
 * from `solumbe pass ../api` it would climb to "." and read this directory's
 * config instead of reaching the one above ../api.
 * @param {string} cwd
 * @returns {string | null}
 */
function findLocalConfigPath(cwd) {
  const home = os.homedir();
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, ".solumberc.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return null;
    dir = parent;
  }
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readJsonFile(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, unknown> | null}
 */
function readUserConfig(env) {
  const { readPath } = userConfigStatus(env);
  return readPath ? readJsonFile(readPath) : null;
}

/**
 * @param {string} value
 * @returns {boolean | undefined}
 */
function coerceBool(value) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * Apply SOLUMBE_* and NO_COLOR env vars into the config object in-place.
 * @param {Partial<ResolvedConfig>} cfg
 * @param {NodeJS.ProcessEnv} env
 */
function applyEnv(cfg, env) {
  if (env.SOLUMBE_EMOJI !== undefined) {
    const v = coerceBool(env.SOLUMBE_EMOJI);
    if (v !== undefined) cfg.emoji = v;
  }
  if (env.SOLUMBE_COLOR !== undefined) {
    const v = coerceBool(env.SOLUMBE_COLOR);
    if (v !== undefined) cfg.color = v;
  }
  // NO_COLOR spec: any value (including empty string) disables color.
  if (env.NO_COLOR !== undefined) cfg.color = false;
  if (env.SOLUMBE_THEME !== undefined) cfg.theme = env.SOLUMBE_THEME;
  if (env.SOLUMBE_TELEMETRY !== undefined) {
    const v = coerceBool(env.SOLUMBE_TELEMETRY);
    if (v !== undefined) cfg.telemetry = v;
  }
  if (env.SOLUMBE_TELEMETRY_SHARE !== undefined) {
    const v = coerceBool(env.SOLUMBE_TELEMETRY_SHARE);
    if (v !== undefined) cfg.telemetryShare = v;
  }
  if (env.SOLUMBE_WIDTH !== undefined) {
    const n = Number(env.SOLUMBE_WIDTH);
    if (!isNaN(n) && n > 0) cfg.width = n;
  }
}

/**
 * Merge entries from a raw JSON object into cfg, skipping null/undefined values.
 * @param {Partial<ResolvedConfig>} cfg
 * @param {Record<string, unknown>} raw
 */
function mergeRaw(cfg, raw) {
  for (const key of VALID_KEYS) {
    if (Object.hasOwn(raw, key) && raw[key] != null) {
      // @ts-ignore — dynamic key assignment
      cfg[key] = raw[key];
    }
  }
}

/**
 * Load merged config. Precedence (low → high): defaults → user → local → env.
 * CLI flags are applied by callers on top of this result.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {ResolvedConfig}
 */
export function loadConfig({ cwd = process.cwd(), env = process.env } = {}) {
  /** @type {Partial<ResolvedConfig>} */
  const cfg = { ...DEFAULTS };
  const userRaw = readUserConfig(env);
  if (userRaw) mergeRaw(cfg, userRaw);
  const localPath = findLocalConfigPath(cwd);
  if (localPath) {
    const localRaw = readJsonFile(localPath);
    if (localRaw) mergeRaw(cfg, localRaw);
  }
  applyEnv(cfg, env);
  return /** @type {ResolvedConfig} */ (cfg);
}

/**
 * The policy and governance a gate on `repoPath` runs under. An explicit value
 * wins. An omitted or blank one comes from the config found from the gated
 * repository (its .solumberc.json, then the user config), not from the process's
 * cwd: `solumbe pass-pr 12 --path ../api` can run from inside another repository,
 * and an MCP server runs wherever its host launched it. Blank counts as omitted,
 * as it does in normalizeProfile and normalizeGovernance. The CLI gate commands
 * and the MCP gate tools both resolve through here, so one repository gets the
 * same verdict from either.
 * @param {string} repoPath
 * @param {Record<string, any>} [explicit] CLI flags or MCP tool arguments.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ policy: string | undefined, governance: string | undefined }}
 */
export function gatePolicy(repoPath, explicit = {}, env = process.env) {
  const config = loadConfig({ cwd: repoPath, env });
  return {
    policy: String(explicit.policy ?? "").trim() ? explicit.policy : config.policy,
    governance: String(explicit.governance ?? "").trim() ? explicit.governance : config.governance,
  };
}

/**
 * The companion repositories a context pack on `repoPath` also reads: the
 * `companions` list in the repository's .solumberc.json, each entry resolved
 * against that file's directory. A web client whose bugs often live in its API
 * (`"companions": ["../api"]`) gets one pack across both instead of a pack that
 * never sees the other side. Entries that are not existing directories drop out,
 * so a checkout without the sibling still packs its own repository.
 * @param {string} repoPath
 * @returns {string[]}
 */
export function companionRepos(repoPath) {
  const localPath = findLocalConfigPath(repoPath);
  const raw = localPath ? readJsonFile(localPath) : null;
  if (!localPath || !Array.isArray(raw?.companions)) return [];
  const base = path.dirname(localPath);
  return raw.companions
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => path.resolve(base, entry))
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory());
}

/**
 * The repositories a context pack reads. Explicit `paths` win as given;
 * otherwise `path` (default ".") plus its configured companions.
 * @param {{ path?: string, paths?: string[] }} options
 * @returns {string[]}
 */
export function contextRepoPaths(options) {
  if (Array.isArray(options.paths) && options.paths.length) return options.paths;
  const root = path.resolve(options.path ?? ".");
  return [root, ...companionRepos(root).filter((dir) => dir !== root)];
}

/**
 * @param {"user" | "local"} scope
 * @param {string} [cwd]
 * @returns {string}
 */
export function getConfigPath(scope, cwd = process.cwd()) {
  return scope === "local" ? path.join(cwd, ".solumberc.json") : getUserConfigPath();
}

/**
 * Merge partial config into the target file (user or local .solumberc.json).
 * The first user write after the rename starts from the legacy file, so it
 * carries those settings over instead of hiding them behind a new file that
 * holds only the key just set.
 * @param {Partial<ResolvedConfig>} config
 * @param {"user" | "local"} [scope]
 * @param {string} [cwd]
 */
export function writeConfig(config, scope = "user", cwd = process.cwd()) {
  const target = getConfigPath(scope, cwd);
  const existing = (scope === "user" ? readUserConfig(process.env) : readJsonFile(target)) ?? {};
  for (const [key, value] of Object.entries(config)) {
    if (VALID_KEYS.has(key)) existing[key] = value;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`);
}

/**
 * Returns each known config key annotated with its source.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {SourcedEntry[]}
 */
export function listConfigSources({ cwd = process.cwd(), env = process.env } = {}) {
  const userRaw = readUserConfig(env) ?? {};
  const localPath = findLocalConfigPath(cwd);
  const localRaw = localPath ? (readJsonFile(localPath) ?? {}) : {};
  /** @type {Partial<ResolvedConfig>} */
  const envCfg = {};
  applyEnv(envCfg, env);

  return Array.from(VALID_KEYS).map((key) => {
    if (Object.hasOwn(envCfg, key)) return { key, value: /** @type {Record<string,unknown>} */ (envCfg)[key], source: /** @type {"env"} */ ("env") };
    if (Object.hasOwn(localRaw, key) && localRaw[key] != null) return { key, value: localRaw[key], source: /** @type {"local"} */ ("local") };
    if (Object.hasOwn(userRaw, key) && userRaw[key] != null) return { key, value: userRaw[key], source: /** @type {"user"} */ ("user") };
    if (Object.hasOwn(DEFAULTS, key))
      return { key, value: /** @type {Record<string,unknown>} */ (DEFAULTS)[key], source: /** @type {"default"} */ ("default") };
    return { key, value: undefined, source: /** @type {"default"} */ ("default") };
  });
}

/** All valid config key names. @type {string[]} */
export const CONFIG_KEYS = Array.from(VALID_KEYS);
