import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hydrateShellEnv, SHELL_ENV_KEYS } from "../src/lib/shell-env.js";

/**
 * A fake login shell that answers like `printf` would, after optional noise.
 * @param {Record<string, string>} values
 * @param {{ noise?: string, status?: number }} [options]
 */
function fakeShell(values, options = {}) {
  /** @type {{ command: string, args: string[] }[]} */
  const calls = [];
  /** @type {import("../src/lib/shell-env.js").ShellRunner} */
  const run = (command, args) => {
    calls.push({ command, args });
    const script = args[args.length - 1];
    const names = [...script.matchAll(/\$\{([A-Z_][A-Z0-9_]*)-\}/g)].map((match) => match[1]);
    const stdout = `${options.noise ?? ""}__SOLUMBE_SHELL_ENV__${names.map((name) => `${values[name] ?? ""}\0`).join("")}`;
    return { status: options.status ?? 0, stdout };
  };
  return { run, calls };
}

const base = { platform: /** @type {NodeJS.Platform} */ ("darwin"), shell: "/bin/zsh", exists: () => true };

test("loads a missing key from the login shell without returning its value", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  const shell = fakeShell({ TYPESAFE_API_KEY: "ts-secret" });
  const result = hydrateShellEnv({ ...base, env, run: shell.run });

  assert.deepEqual(result, { loaded: ["TYPESAFE_API_KEY"] });
  assert.equal(env.TYPESAFE_API_KEY, "ts-secret");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "an unset shell variable stays unset");
  assert.ok(!JSON.stringify(result).includes("ts-secret"));
  assert.equal(shell.calls[0].command, "/bin/zsh");
  assert.deepEqual(shell.calls[0].args.slice(0, 2), ["-l", "-c"], "non-interactive login shell, never -i");
});

test("asks only for the keys that are missing and never overwrites one that is set", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = { TYPESAFE_API_KEY: "from-host" };
  const shell = fakeShell({ TYPESAFE_API_KEY: "from-shell", ANTHROPIC_API_KEY: "sk-shell" });
  const result = hydrateShellEnv({ ...base, env, run: shell.run });

  assert.deepEqual(result.loaded, ["ANTHROPIC_API_KEY"]);
  assert.equal(env.TYPESAFE_API_KEY, "from-host");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-shell");
  assert.ok(!shell.calls[0].args[2].includes("TYPESAFE_API_KEY"));
});

test("does not start a shell when every key is already set", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.fromEntries(SHELL_ENV_KEYS.map((key) => [key, "set"]));
  const shell = fakeShell({});
  assert.deepEqual(hydrateShellEnv({ ...base, env, run: shell.run }), { loaded: [], skipped: "already set" });
  assert.equal(shell.calls.length, 0);
});

test("ignores anything startup files print before the answer", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  const shell = fakeShell({ TYPESAFE_API_KEY: "ts-secret" }, { noise: "Now using node v22\nwelcome\0\n" });
  hydrateShellEnv({ ...base, env, run: shell.run });
  assert.equal(env.TYPESAFE_API_KEY, "ts-secret");
});

test("can be turned off, and is skipped on Windows or without a usable shell", () => {
  const shell = fakeShell({ TYPESAFE_API_KEY: "ts-secret" });
  assert.equal(hydrateShellEnv({ ...base, env: { SOLUMBE_SHELL_ENV: "0" }, run: shell.run }).skipped, "SOLUMBE_SHELL_ENV=0");
  assert.equal(hydrateShellEnv({ ...base, env: {}, platform: "win32", run: shell.run }).skipped, "no login shell on Windows");
  assert.match(String(hydrateShellEnv({ ...base, env: {}, shell: "zsh", run: shell.run }).skipped), /shell not found/);
  assert.match(String(hydrateShellEnv({ ...base, env: {}, exists: () => false, run: shell.run }).skipped), /shell not found/);
  assert.equal(shell.calls.length, 0);
});

test("a shell that fails or times out loads nothing", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  const failing = fakeShell({ TYPESAFE_API_KEY: "ts-secret" }, { status: 1 });
  assert.deepEqual(hydrateShellEnv({ ...base, env, run: failing.run }), { loaded: [], skipped: "login shell did not answer" });
  const timedOut = () => ({ status: null, stdout: "", error: new Error("ETIMEDOUT") });
  assert.deepEqual(hydrateShellEnv({ ...base, env, run: timedOut }), { loaded: [], skipped: "login shell did not answer" });
  assert.equal(env.TYPESAFE_API_KEY, undefined);
});

test("rejects key names that are not plain environment names", () => {
  const shell = fakeShell({});
  const result = hydrateShellEnv({ ...base, env: {}, keys: ["X; rm -rf ~", "$(id)"], run: shell.run });
  assert.deepEqual(result, { loaded: [], skipped: "already set" });
  assert.equal(shell.calls.length, 0);
});

test("reads a real login shell end to end", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-shell-env-"));
  try {
    // A throwaway HOME whose profile exports the key, so the user's own
    // startup files are never read.
    fs.writeFileSync(path.join(dir, ".profile"), "export TYPESAFE_API_KEY=from-profile\necho noisy profile\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const result = hydrateShellEnv({
      env,
      keys: ["TYPESAFE_API_KEY"],
      shell: "/bin/sh",
      run: (command, args, options) => {
        const child = spawnSync(command, args, {
          encoding: "utf8",
          timeout: options.timeout,
          env: { HOME: dir, PATH: "/usr/bin:/bin", ENV: "" },
          cwd: dir,
        });
        return { status: child.status, stdout: child.stdout ?? "", error: child.error };
      },
    });
    assert.deepEqual(result.loaded, ["TYPESAFE_API_KEY"]);
    assert.equal(env.TYPESAFE_API_KEY, "from-profile");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
