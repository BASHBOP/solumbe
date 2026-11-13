import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GATE_FAIL_CAP, applyGateAttempts, gateFailCap, resetGateAttempts } from "../src/lib/gate-attempts.js";

const gate = (verdict, extra = {}) => ({ ok: verdict !== "FAIL", verdict, repo: { root: "/repo", name: "repo" }, checks: [], ...extra });
const at = (head, env = {}) => ({ env, head: () => head });

test("the cap defaults to 3, takes a whole number and turns off on 0 or off", () => {
  assert.equal(DEFAULT_GATE_FAIL_CAP, 3);
  assert.equal(gateFailCap({}), 3);
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: " " }), 3);
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: "5" }), 5);
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: "0" }), 0);
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: "OFF" }), 0);
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: "2.5" }), 3, "not a whole number falls back");
  assert.equal(gateFailCap({ SOLUMBE_GATE_FAIL_CAP: "-1" }), 3);
});

test("consecutive local FAILs on one head are counted and escalate at the cap", () => {
  resetGateAttempts();
  const first = applyGateAttempts("review_gate", gate("FAIL"), at("aaa"));
  assert.deepEqual(first.attempts, { consecutiveFails: 1, cap: 3, escalate: false });
  assert.equal(first.verdict, "FAIL", "the verdict is untouched");
  assert.equal(applyGateAttempts("review_gate", gate("FAIL"), at("aaa")).attempts.consecutiveFails, 2);

  const third = applyGateAttempts("review_gate", gate("FAIL"), at("aaa"));
  assert.equal(third.attempts.escalate, true);
  assert.match(third.attempts.message, /failed 3 times in a row.*Stop retrying/s);

  const fourth = applyGateAttempts("review_gate", gate("FAIL"), at("aaa"));
  assert.equal(fourth.attempts.consecutiveFails, 4, "it keeps counting past the cap");
  assert.equal(fourth.attempts.escalate, true);
});

test("a PASS or WARN, a new head and another repository each start a fresh streak", () => {
  resetGateAttempts();
  applyGateAttempts("review_gate", gate("FAIL"), at("aaa"));
  applyGateAttempts("review_gate", gate("FAIL"), at("aaa"));
  const warn = gate("WARN");
  assert.equal(applyGateAttempts("review_gate", warn, at("aaa")), warn, "a result that is not a FAIL comes back as it was");
  assert.equal(applyGateAttempts("review_gate", gate("FAIL"), at("aaa")).attempts.consecutiveFails, 1);

  assert.equal(applyGateAttempts("review_gate", gate("FAIL"), at("bbb")).attempts.consecutiveFails, 1, "a new commit is a new change");
  const other = gate("FAIL", { repo: { root: "/other", name: "other" } });
  assert.equal(applyGateAttempts("review_gate", other, at("aaa")).attempts.consecutiveFails, 1);
});

test("the cap follows SOLUMBE_GATE_FAIL_CAP and off leaves a FAIL alone", () => {
  resetGateAttempts();
  const one = applyGateAttempts("review_gate", gate("FAIL"), at("aaa", { SOLUMBE_GATE_FAIL_CAP: "1" }));
  assert.equal(one.attempts.escalate, true);
  const fail = gate("FAIL");
  assert.equal(applyGateAttempts("review_gate", fail, at("aaa", { SOLUMBE_GATE_FAIL_CAP: "off" })), fail);
});

test("other tools, the pull request gate and results it cannot place are left alone", () => {
  resetGateAttempts();
  const fail = gate("FAIL");
  assert.equal(applyGateAttempts("convergence_score", fail, at("aaa")), fail);
  const pr = gate("FAIL", { pr: { number: 12 } });
  assert.equal(applyGateAttempts("review_gate", pr, at("aaa")), pr);
  const rootless = { verdict: "FAIL" };
  assert.equal(applyGateAttempts("review_gate", rootless, at("aaa")), rootless);
  assert.equal(applyGateAttempts("review_gate", fail, at(null)), fail, "no head commit, no change to count against");
  assert.equal(applyGateAttempts("review_gate", null, at("aaa")), null);
  const throwing = {
    env: {},
    head: () => {
      throw new Error("git is gone");
    },
  };
  assert.equal(applyGateAttempts("review_gate", fail, throwing), fail, "it never throws");
});

test("a markdown pair carries the count in its data and the stop message in its markdown", () => {
  resetGateAttempts();
  const pair = () => ({ data: gate("FAIL"), markdown: "# Gate\n\nFAIL" });
  const first = applyGateAttempts("review_gate", pair(), at("aaa", { SOLUMBE_GATE_FAIL_CAP: "2" }));
  assert.equal(first.data.attempts.consecutiveFails, 1);
  assert.equal(first.markdown, "# Gate\n\nFAIL");
  const second = applyGateAttempts("review_gate", pair(), at("aaa", { SOLUMBE_GATE_FAIL_CAP: "2" }));
  assert.match(second.markdown, /^# Gate\n\nFAIL\n\nreview_gate has failed 2 times in a row/);
});

test("without an injected head it reads the repository's own, and a path that is no repository is left alone", () => {
  resetGateAttempts();
  const here = gate("FAIL", { repo: { root: process.cwd(), name: "solumbe" } });
  assert.equal(applyGateAttempts("review_gate", here, { env: {} }).attempts.consecutiveFails, 1);
  const nowhere = gate("FAIL", { repo: { root: "/nonexistent-solumbe-gate-attempts", name: "x" } });
  assert.equal(applyGateAttempts("review_gate", nowhere, { env: {} }), nowhere);
});
