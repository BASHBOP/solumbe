import { spawnSync } from "node:child_process";
import fs from "node:fs";

// Desktop hosts (Claude Desktop, the Claude app's Code tab, Cursor launched
// from the Dock) start MCP servers outside any shell, so a key the user
// exported in a shell startup file never reaches `solumbe mcp`. The docs tell
// people to keep TYPESAFE_API_KEY in their shell rather than in a config file,
// so the server asks the user's login shell for the read-model keys it is
// missing, once, at startup.
//
// Only the names below are asked for, and only when they are absent. Values
// are never logged or returned; callers get the names that were loaded.

/** Keys the optional model reads use. Fixed names, so they are safe in a script. */
export const SHELL_ENV_KEYS = Object.freeze(["TYPESAFE_API_KEY", "ANTHROPIC_API_KEY"]);

const MARKER = "__SOLUMBE_SHELL_ENV__";
const KEY_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * @typedef {(command: string, args: string[], options: { timeout: number }) =>
 *   { status: number | null, stdout: string, error?: Error }} ShellRunner
 */

/**
 * @typedef {object} HydrateResult
 * @property {string[]} loaded names copied into `env` from the login shell
 * @property {string} [skipped] why the shell was not asked, when it was not
 */

/** @type {ShellRunner} */
function defaultRun(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

/**
 * Copy missing read-model keys from the user's login shell into `env`.
 *
 * The shell runs as a non-interactive login shell (`-l -c`), which reads the
 * same files a terminal login does (for zsh `.zshenv` and `.zprofile`, for
 * bash `.bash_profile` or `.profile`) but not interactive-only files such as
 * `.zshrc`, so prompts, plugins and terminal multiplexers never start.
 *
 * Set `SOLUMBE_SHELL_ENV=0` to turn this off.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   keys?: readonly string[],
 *   platform?: NodeJS.Platform,
 *   shell?: string,
 *   timeoutMs?: number,
 *   run?: ShellRunner,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {HydrateResult}
 */
export function hydrateShellEnv(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const keys = (options.keys ?? SHELL_ENV_KEYS).filter((key) => KEY_NAME.test(key));
  const run = options.run ?? defaultRun;
  const exists = options.exists ?? ((file) => fs.existsSync(file));

  if (env.SOLUMBE_SHELL_ENV === "0") return { loaded: [], skipped: "SOLUMBE_SHELL_ENV=0" };
  if (platform === "win32") return { loaded: [], skipped: "no login shell on Windows" };

  const missing = keys.filter((key) => !env[key]);
  if (missing.length === 0) return { loaded: [], skipped: "already set" };

  const shell = options.shell ?? (env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"));
  if (!shell.startsWith("/") || !exists(shell)) return { loaded: [], skipped: `shell not found: ${shell}` };

  // Startup files may print (a banner, a version manager notice), so the
  // answer follows a marker and each value ends in a NUL, which no
  // environment value can contain.
  const script = [`printf '%s' '${MARKER}'`, ...missing.map((key) => `printf '%s\\0' "\${${key}-}"`)].join("; ");
  const result = run(shell, ["-l", "-c", script], { timeout: options.timeoutMs ?? 5000 });
  if (result.error || result.status !== 0) return { loaded: [], skipped: "login shell did not answer" };

  const at = result.stdout.lastIndexOf(MARKER);
  if (at === -1) return { loaded: [], skipped: "login shell did not answer" };
  const values = result.stdout.slice(at + MARKER.length).split("\0");

  /** @type {string[]} */
  const loaded = [];
  missing.forEach((key, index) => {
    const value = values[index];
    if (value) {
      env[key] = value;
      loaded.push(key);
    }
  });
  return { loaded };
}
