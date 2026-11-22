/**
 * Normalize the boundary between a Solumbe gate process and CI.
 *
 * A gate's JSON verdict is authoritative only when it is readable and agrees
 * with the process exit code. WARN is advisory and therefore exits zero;
 * FAIL and execution errors exit non-zero. Anything else is an execution
 * error rather than an accidental PASS.
 */

const VERDICTS = new Set(["PASS", "WARN", "FAIL"]);

/**
 * @typedef {object} CiReport
 * @property {boolean} ok Whether the gate result was readable and consistent.
 * @property {"PASS" | "WARN" | "FAIL" | null} verdict
 * @property {"PASS" | "WARN" | "FAIL" | "EXECUTION_ERROR"} status
 * @property {number} exitCode The exit code CI should use.
 * @property {string} summary
 * @property {string[]} details
 * @property {string} [error]
 */

/**
 * @param {string} stdout
 * @param {{ exitCode?: number, stderr?: string }} [options]
 * @returns {CiReport}
 */
export function evaluateCiResult(stdout, options = {}) {
  const exitCode = Number.isInteger(options.exitCode) ? Number(options.exitCode) : 0;
  const stderr = String(options.stderr ?? "").trim();
  let data;
  try {
    data = JSON.parse(String(stdout ?? "").trim());
  } catch (error) {
    return executionError(`gate output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, stderr);
  }

  if (data?.ok !== true) {
    return executionError(typeof data?.error === "string" ? data.error : "gate output did not confirm successful execution", stderr);
  }
  const verdict = data.verdict;
  if (!VERDICTS.has(verdict)) {
    return executionError("gate output did not contain a valid PASS, WARN, or FAIL verdict", stderr);
  }

  const expectedExit = verdict === "FAIL" ? 1 : 0;
  if (exitCode !== expectedExit) {
    return executionError(`gate verdict ${verdict} disagreed with its process exit code ${exitCode}`, stderr, [
      `Expected exit code ${expectedExit} for ${verdict}.`,
    ]);
  }

  const checks = Array.isArray(data.checks) ? /** @type {any[]} */ (data.checks) : [];
  const blocking = checks.find((/** @type {any} */ check) => check?.status === "FAIL") ?? checks.find((/** @type {any} */ check) => check?.status === "WARN");
  const detail = blocking?.name ? `${blocking.name}: ${blocking.summary ?? "requires attention"}` : "";
  return {
    ok: true,
    verdict: /** @type {"PASS" | "WARN" | "FAIL"} */ (verdict),
    status: /** @type {"PASS" | "WARN" | "FAIL"} */ (verdict),
    exitCode: expectedExit,
    summary:
      verdict === "PASS"
        ? "Solumbe gate passed."
        : verdict === "WARN"
          ? `Solumbe gate passed with advisory warnings${detail ? ` — ${detail}` : "."}`
          : `Solumbe gate failed${detail ? ` — ${detail}` : "."}`,
    details: checks
      .filter((/** @type {any} */ check) => check?.status === "WARN" || check?.status === "FAIL")
      .map((/** @type {any} */ check) => `${check.name ?? "check"}: ${check.summary ?? check.status}`),
  };
}

/**
 * @param {string} message
 * @param {string} stderr
 * @param {string[]} [details]
 * @returns {CiReport}
 */
function executionError(message, stderr, details = []) {
  return {
    ok: false,
    verdict: null,
    status: "EXECUTION_ERROR",
    exitCode: 1,
    summary: `Solumbe gate execution error — ${message}`,
    details: [...details, ...(stderr ? [`stderr: ${stderr}`] : [])],
    error: message,
  };
}

/**
 * @param {CiReport} report
 * @returns {string}
 */
export function formatCiReport(report) {
  const lines = [`# Solumbe CI: ${report.status}`, "", report.summary];
  if (report.details.length) {
    lines.push("", "## Details", "", ...report.details.map((detail) => `- ${detail}`));
  }
  return lines.join("\n");
}
