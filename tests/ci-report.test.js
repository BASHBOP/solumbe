import test from "node:test";
import assert from "node:assert/strict";
import { evaluateCiResult, formatCiReport } from "../src/lib/ci-report.js";

const gate = (verdict, extra = {}) => JSON.stringify({ ok: true, verdict, checks: [], ...extra });

test("ci-report preserves PASS as a successful result", () => {
  const report = evaluateCiResult(gate("PASS"), { exitCode: 0 });
  assert.deepEqual({ ok: report.ok, status: report.status, exitCode: report.exitCode }, { ok: true, status: "PASS", exitCode: 0 });
});

test("ci-report preserves WARN as advisory and non-blocking", () => {
  const report = evaluateCiResult(gate("WARN"), { exitCode: 0 });
  assert.deepEqual({ ok: report.ok, status: report.status, exitCode: report.exitCode }, { ok: true, status: "WARN", exitCode: 0 });
  assert.match(formatCiReport(report), /passed with advisory warnings/);
});

test("ci-report blocks a valid FAIL verdict", () => {
  const report = evaluateCiResult(gate("FAIL"), { exitCode: 1 });
  assert.deepEqual({ ok: report.ok, status: report.status, exitCode: report.exitCode }, { ok: true, status: "FAIL", exitCode: 1 });
});

test("ci-report treats malformed output as an execution error", () => {
  const report = evaluateCiResult("not json", { exitCode: 0, stderr: "parser warning" });
  assert.deepEqual({ ok: report.ok, status: report.status, exitCode: report.exitCode }, { ok: false, status: "EXECUTION_ERROR", exitCode: 1 });
  assert.match(report.summary, /not valid JSON/);
  assert.match(report.details.join("\n"), /parser warning/);
});

test("ci-report treats a denied GitHub query as an execution error", () => {
  const report = evaluateCiResult(JSON.stringify({ ok: false, error: "GraphQL: Resource not accessible by integration" }), {
    exitCode: 1,
    stderr: "statusCheckRollup: Resource not accessible by integration",
  });
  assert.equal(report.status, "EXECUTION_ERROR");
  assert.equal(report.ok, false);
  assert.match(report.summary, /execution error/);
  assert.match(report.details.join("\n"), /statusCheckRollup/);
});

test("ci-report rejects a verdict and process exit mismatch", () => {
  const report = evaluateCiResult(gate("WARN"), { exitCode: 1 });
  assert.equal(report.status, "EXECUTION_ERROR");
  assert.match(report.error, /disagreed/);
});
