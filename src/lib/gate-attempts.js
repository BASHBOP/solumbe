// A stop condition for the loop an agent builds around the local gate.
//
// `review_gate` answers one call and remembers nothing. A host agent that reads
// a FAIL, edits and calls again has turned it into an evaluate-and-retry loop,
// and nothing in that loop says when to stop. This counts consecutive local
// FAIL verdicts on one change and, at the cap, adds a plain instruction to the
// result: stop and take the reasons to the user.
//
// The change is the repository root and its head commit, the unit the check
// trial uses: every gate run before the next commit is the same change. A
// PASS or WARN ends the streak, and so does a new commit. The count lives in
// the server process, so it is per agent session and nothing is written.
//
// `SOLUMBE_GATE_FAIL_CAP` sets the cap (default 3); 0 or `off` turns it off.
// The verdict is never changed. The MCP surface only: the command line, the
// pre-commit hook, CI and the pull request gate are not counted.

import { STATUS } from "./policy.js";
import { runCommand } from "./tools.js";

export const DEFAULT_GATE_FAIL_CAP = 3;

/** Consecutive local FAILs per change, keyed by `root\0head`. */
/** @type {Map<string, number>} */
const streaks = new Map();

/** Forget every streak. For tests. */
export function resetGateAttempts() {
  streaks.clear();
}

/**
 * The cap in force, or 0 when it is off. Anything that is not a whole number
 * of at least 1, or one of the off words, falls back to the default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function gateFailCap(env = process.env) {
  const raw = String(env.SOLUMBE_GATE_FAIL_CAP ?? "").trim();
  if (!raw) return DEFAULT_GATE_FAIL_CAP;
  if (/^(off|0|false|none)$/i.test(raw)) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_GATE_FAIL_CAP;
}

/**
 * Count one local `review_gate` result and, on a FAIL, return it with
 * `attempts` added. At the cap `attempts.escalate` is true and
 * `attempts.message` says to stop. Any other result, a pull request gate and a
 * repository with no head commit come back untouched. Never throws: counting
 * must not be able to fail a tool call.
 * @param {string} tool canonical tool name
 * @param {any} result what dispatch returned: the data, or a `{ data, markdown }` pair
 * @param {{ env?: NodeJS.ProcessEnv, head?: (root: string) => string|null }} [options]
 * @returns {any}
 */
export function applyGateAttempts(tool, result, options = {}) {
  try {
    if (tool !== "review_gate") return result;
    const cap = gateFailCap(options.env);
    if (!cap) return result;
    const paired = Boolean(result && typeof result === "object" && "markdown" in result);
    const data = paired ? result.data : result;
    if (!data || typeof data !== "object" || data.pr || typeof data.verdict !== "string") return result;
    const root = typeof data.repo?.root === "string" ? data.repo.root : null;
    if (!root) return result;
    const head = (options.head ?? headAt)(root);
    if (!head) return result;

    const key = `${root}\0${head}`;
    if (data.verdict !== STATUS.fail) {
      streaks.delete(key);
      return result;
    }
    const consecutiveFails = (streaks.get(key) ?? 0) + 1;
    streaks.set(key, consecutiveFails);
    const escalate = consecutiveFails >= cap;
    /** @type {{ consecutiveFails: number, cap: number, escalate: boolean, message?: string }} */
    const attempts = { consecutiveFails, cap, escalate };
    if (escalate) {
      attempts.message =
        `review_gate has failed ${consecutiveFails} times in a row on this change (cap ${cap}). ` +
        "Stop retrying: report the failing checks and their reasons to the user and wait for their decision before running the gate again.";
    }
    const annotated = { ...data, attempts };
    if (!paired) return annotated;
    return { ...result, data: annotated, markdown: attempts.message ? `${result.markdown}\n\n${attempts.message}` : result.markdown };
  } catch {
    return result;
  }
}

/**
 * @param {string} root
 * @returns {string|null}
 */
function headAt(root) {
  const result = runCommand("git", ["rev-parse", "HEAD"], { cwd: root });
  return (result.ok ? result.stdout.trim() : "") || null;
}
