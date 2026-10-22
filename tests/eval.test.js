import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, runGateEffectivenessEval, runHarnessExecutionEval, runRetrievalEval } from "../src/lib/eval.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("runEval returns per-task and total token estimates for a tiny repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-eval-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "eval-fixture",
      scripts: { lint: "eslint .", test: "node --test" },
    }),
  );
  fs.writeFileSync(path.join(root, "README.md"), "# eval fixture\n\nA tiny repo for eval testing.\n");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "export function main() { return 42; }\n");

  const { data, markdown } = runEval(root, { query: "audit this codebase" });

  assert.equal(data.ok, true);
  assert.equal(data.evalVersion, 1);
  assert.equal(data.repo.name, path.basename(root));
  assert.equal(data.query, "audit this codebase");
  assert.equal(data.tasks.length, 4);

  const taskNames = data.tasks.map((t) => t.name).sort();
  assert.deepEqual(taskNames, ["code_map", "context_pack", "harness", "repo_overview"]);

  for (const task of data.tasks) {
    assert.equal(task.ok, true, `task ${task.name} should run cleanly: ${task.error}`);
    assert.ok(task.solumbeBytes >= 0);
    assert.ok(task.naiveBytes >= 0);
    assert.ok(task.solumbeTokens >= 0);
    assert.ok(task.naiveTokens >= 0);
  }

  assert.ok(data.totals.solumbeBytes > 0);
  assert.equal(data.totals.solumbeTokens + data.totals.savedTokens, data.totals.naiveTokens, "solumbe + saved should equal naive");

  assert.match(markdown, /# solumbe Eval:/);
  assert.match(markdown, /\| Task \| solumbe tokens \|/);
  assert.match(markdown, /## Totals/);
});

test("runEval handles a missing repo gracefully", () => {
  assert.throws(() => runEval("/this/path/should/not/exist"), /repo not found/);
});

test("runRetrievalEval scores the committed corpus and passes its thresholds", () => {
  const { data, markdown } = runRetrievalEval();

  assert.equal(data.ok, true);
  assert.equal(data.evalKind, "accuracy");
  assert.ok(data.counts.retrieval >= 16, "expected at least 16 retrieval cases");
  assert.ok(data.counts.risk >= 16, "expected at least 16 risk cases");
  assert.ok(data.counts.retrieval + data.counts.risk >= 25, "corpus must have at least 25 labeled cases");

  // Real scoreboard, not a stub.
  const { retrieval, risk } = data.scoreboard;
  assert.ok(retrieval.pAtK > 0 && retrieval.pAtK <= 1, `p@k in (0,1]: ${retrieval.pAtK}`);
  assert.ok(retrieval.rAtK > 0 && retrieval.rAtK <= 1, `r@k in (0,1]: ${retrieval.rAtK}`);
  assert.ok(retrieval.mrr > 0 && retrieval.mrr <= 1, `mrr in (0,1]: ${retrieval.mrr}`);
  assert.ok(risk.accuracy >= 0 && risk.accuracy <= 1, `risk accuracy in [0,1]: ${risk.accuracy}`);

  // Every threshold check must pass and the overall gate must be green today.
  assert.ok(data.checks.length >= 4, "expected retrieval + risk threshold checks");
  for (const check of data.checks) {
    assert.equal(check.pass, true, `threshold check ${check.metric} failed: ${check.value} < ${check.threshold}`);
  }
  assert.equal(data.passed, true, "committed corpus must pass all thresholds");
  assert.equal(data.exitCode, 0);

  assert.match(markdown, /# solumbe Accuracy Eval/);
  assert.match(markdown, /## Scoreboard/);
  assert.match(markdown, /Overall: PASS/);
});

test("runHarnessExecutionEval proves the committed install, test, typecheck, and build commands", () => {
  const { data, markdown } = runHarnessExecutionEval();

  assert.equal(data.evalKind, "harness-execution");
  assert.equal(data.passed, true, "committed harness execution corpus must pass");
  assert.equal(data.exitCode, 0);
  assert.equal(data.counts.fixtures, 1);
  assert.equal(data.counts.commands, 4);
  assert.equal(data.counts.passedCommands, 4);

  const commands = data.cases[0].commands;
  assert.deepEqual(
    commands.map((command) => command.kind),
    ["install", "test", "typecheck", "build"],
  );
  assert.ok(commands.every((command) => command.inferred && command.executed && command.pass));
  assert.match(markdown, /# solumbe Harness Execution Eval/);
  assert.match(markdown, /Commands: 4\/4 passed/);
});

test("runHarnessExecutionEval fails closed when the fixture harness cannot infer a declared command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-harness-corpus-"));
  const corpusPath = path.join(dir, "corpus.json");
  const fixture = path.join(repoRoot, "evals", "fixtures", "harness-node");
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { fixture },
      retrieval: [],
      risk: [],
      harnessExecution: [
        {
          name: "missing-command",
          repoFixture: "fixture",
          commands: [{ kind: "build", group: "validate", command: "npm run missing", script: "missing" }],
        },
      ],
    }),
  );

  const { data } = runHarnessExecutionEval({ corpusPath });
  assert.equal(data.passed, false);
  assert.equal(data.exitCode, 1);
  assert.equal(data.cases[0].commands[0].inferred, false);
  assert.equal(data.cases[0].commands[0].executed, false);
  assert.match(data.cases[0].commands[0].error, /not inferred/);
});

test("runHarnessExecutionEval rejects a corpus that redirects execution outside committed fixtures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-harness-unsafe-corpus-"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-harness-unsafe-fixture-"));
  const corpusPath = path.join(dir, "corpus.json");
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { outside: fixture },
      retrieval: [],
      risk: [],
      harnessExecution: [
        {
          name: "outside-fixture",
          repoFixture: "outside",
          commands: [{ kind: "test", group: "validate", command: "npm test", script: "test" }],
        },
      ],
    }),
  );

  assert.throws(() => runHarnessExecutionEval({ corpusPath }), /must be inside/);
});

test("runGateEffectivenessEval proves the committed gate cases and their deterministic reasons", () => {
  const { data, markdown } = runGateEffectivenessEval();

  assert.equal(data.evalKind, "gate-effectiveness");
  assert.equal(data.passed, true, "committed gate-effectiveness corpus must pass");
  assert.equal(data.exitCode, 0);
  assert.equal(data.counts.cases, 13);
  assert.equal(data.counts.passedCases, 13);
  assert.equal(data.counts.expectedBlocked, 8);
  assert.equal(data.counts.blockedAsExpected, 8);

  const byName = new Map(data.cases.map((testCase) => [testCase.name, testCase]));
  assert.equal(byName.get("valid-control-passes")?.actualVerdict, "PASS");
  assert.equal(byName.get("secret-file-is-blocked")?.checks[0]?.name, "Secret safety");
  assert.equal(byName.get("secret-value-in-source-is-blocked")?.checks[0]?.name, "Secret safety");
  assert.equal(byName.get("aligned-change-to-source-kind-owner-converges")?.actualVerdict, "PASS");
  assert.equal(byName.get("incomplete-release-is-blocked")?.checks[0]?.name, "Release discipline");
  assert.equal(byName.get("scope-drift-fails-convergence")?.checks[0]?.name, "Convergence");
  assert.equal(byName.get("base-moving-on-is-not-part-of-the-change")?.actualVerdict, "PASS");
  assert.equal(byName.get("credential-already-on-base-is-not-blocked")?.actualVerdict, "PASS");
  assert.equal(byName.get("dependency-bump-converges")?.actualVerdict, "PASS");
  assert.equal(byName.get("credential-added-beside-a-legacy-one-is-blocked")?.checks[0]?.name, "Secret safety");
  assert.ok(data.cases.every((testCase) => testCase.pass && testCase.unexpectedFailures.length === 0));

  assert.match(markdown, /# solumbe Gate Effectiveness Eval/);
  assert.match(markdown, /Expected blocks: 8\/8 blocked for the encoded reason/);
  assert.match(markdown, /Overall: PASS/);
});

test("runGateEffectivenessEval fails when the real gate reason differs from the corpus expectation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-corpus-"));
  const corpusPath = path.join(dir, "corpus.json");
  const fixture = path.join(repoRoot, "evals", "fixtures", "gate-node");
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { fixture },
      retrieval: [],
      risk: [],
      gateEffectiveness: [
        {
          name: "wrong-reason",
          repoFixture: "fixture",
          changeSet: "secret",
          expectedVerdict: "FAIL",
          expectedChecks: [{ name: "Secret safety", status: "FAIL", summaryIncludes: "a reason the gate did not return" }],
        },
      ],
    }),
  );

  const { data, markdown } = runGateEffectivenessEval({ corpusPath });
  assert.equal(data.passed, false);
  assert.equal(data.exitCode, 1);
  assert.equal(data.cases[0].actualVerdict, "FAIL");
  assert.equal(data.cases[0].checks[0].pass, false);
  assert.match(data.cases[0].checks[0].error, /summary does not include/);
  assert.match(markdown, /Overall: FAIL/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runGateEffectivenessEval reports a known gap without failing the run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-gap-"));
  const corpusPath = path.join(dir, "corpus.json");
  const fixture = path.join(repoRoot, "evals", "fixtures", "gate-node");
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { fixture },
      retrieval: [],
      risk: [],
      gateEffectiveness: [
        {
          name: "secret-is-blocked",
          repoFixture: "fixture",
          changeSet: "secret",
          expectedVerdict: "FAIL",
          expectedChecks: [{ name: "Secret safety", status: "FAIL" }],
        },
        {
          name: "open-gap",
          knownGap: true,
          repoFixture: "fixture",
          changeSet: "secret",
          expectedVerdict: "FAIL",
          expectedChecks: [{ name: "Secret safety", status: "FAIL", summaryIncludes: "a reason the gate did not return" }],
        },
      ],
    }),
  );

  const { data, markdown } = runGateEffectivenessEval({ corpusPath });
  assert.equal(data.passed, true, "a known gap must not fail the run");
  assert.equal(data.exitCode, 0);
  assert.equal(data.counts.cases, 1);
  assert.equal(data.counts.knownGaps, 1);
  assert.equal(data.knownGaps[0].pass, false);
  assert.match(markdown, /open-gap: still open/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runGateEffectivenessEval rejects external fixtures and path-like change-set names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-unsafe-corpus-"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-gate-unsafe-fixture-"));
  const corpusPath = path.join(dir, "corpus.json");
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { outside: fixture },
      retrieval: [],
      risk: [],
      gateEffectiveness: [
        {
          name: "outside-fixture",
          repoFixture: "outside",
          changeSet: "valid",
          expectedVerdict: "PASS",
          expectedChecks: [{ name: "Changed files", status: "PASS" }],
        },
      ],
    }),
  );
  assert.throws(() => runGateEffectivenessEval({ corpusPath }), /must be inside/);

  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      fixtureRoots: { fixture: path.join(repoRoot, "evals", "fixtures", "gate-node") },
      retrieval: [],
      risk: [],
      gateEffectiveness: [
        {
          name: "path-traversal",
          repoFixture: "fixture",
          changeSet: "../secret",
          expectedVerdict: "FAIL",
          expectedChecks: [{ name: "Secret safety", status: "FAIL" }],
        },
      ],
    }),
  );
  assert.throws(() => runGateEffectivenessEval({ corpusPath }), /simple fixture name/);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("runRetrievalEval enforces the encoded risk false positives/negatives", () => {
  const { data } = runRetrievalEval();
  const byName = new Map(data.cases.risk.map((c) => [c.name, c]));

  // 'fix payload parsing' must NOT classify as money flow ('pay' substring).
  const payload = byName.get("query-payload-not-money");
  assert.ok(payload, "expected query-payload-not-money case");
  assert.equal(payload.pass, true);
  assert.ok(!payload.actualConcepts.includes("money flow"));

  // roles.guard.ts is auth/security, never money flow.
  const guard = byName.get("path-roles-guard-is-auth");
  assert.ok(guard.actualConcepts.includes("auth/security"));
  assert.ok(!guard.actualConcepts.includes("money flow"));
  assert.equal(guard.pass, true);

  // A checkout test must not trip the merge gate.
  const spec = byName.get("gate-checkout-spec-no-gate");
  assert.deepEqual(spec.actualConcepts, []);
  assert.equal(spec.pass, true);

  // dev.environments.ts is not a secret file.
  const devEnv = byName.get("secret-dev-environments-not-secret");
  assert.deepEqual(devEnv.actualConcepts, []);
  assert.equal(devEnv.pass, true);
});

test("retrieval metrics reward a concise, correct pack (precision over returned set, not k)", () => {
  const { data } = runRetrievalEval();
  // A single-file query that returns exactly the right one file should score
  // precision 1.0 — not 1/k — because precision is over what was returned.
  const oneFile = data.cases.retrieval.find((c) => c.name === "shop-stripe-webhook");
  assert.ok(oneFile, "expected shop-stripe-webhook case");
  assert.deepEqual(oneFile.ranked, ["src/payment/stripe.webhook.ts"]);
  assert.equal(oneFile.metrics.precisionAtK, 1);
  assert.equal(oneFile.metrics.recallAtK, 1);
  assert.equal(oneFile.metrics.mrr, 1);
});

test("runRetrievalEval handles the multi-repo route<->client pairing case", () => {
  const { data } = runRetrievalEval();
  const pairing = data.cases.retrieval.find((c) => c.name === "multi-repo-order-pairing");
  assert.ok(pairing, "expected multi-repo-order-pairing case");
  assert.deepEqual(pairing.fixtures, ["shop-api", "web-client"]);
  // Labels are namespaced <fixture>/<repo-path>; both sides must be present.
  assert.ok(pairing.ranked.includes("shop-api/src/orders/orders.controller.ts"));
  assert.ok(pairing.ranked.includes("web-client/src/api/orders.ts"));
  assert.equal(pairing.pass, true);
});

test("runRetrievalEval fails (exit 1) when a corpus regresses below threshold", () => {
  // Synthetic corpus: a retrieval case whose expected primary can never be
  // returned, with thresholds the engine cannot meet. Proves the runner is a
  // real gate, not a rubber stamp — a randomly-wrong pack must NOT pass.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-eval-corpus-"));
  const corpusPath = path.join(dir, "corpus.json");
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      k: 5,
      thresholds: { retrieval: { precisionAtK: 0.99, recallAtK: 0.99, mrr: 0.99 }, risk: { accuracy: 0.99 } },
      fixtureRoots: { "sample-api": "codex/skills/solumbe/evals/files/sample-api" },
      retrieval: [
        {
          name: "impossible",
          query: "completely unrelated nonexistent symbol xyzzy",
          repoFixture: "sample-api",
          expectedPrimary: ["src/does/not/exist.ts"],
        },
      ],
      risk: [
        {
          name: "wrong-risk",
          mode: "query",
          query: "fix payload parsing",
          expectedConcepts: ["money flow"],
          notExpectedConcepts: [],
        },
      ],
    }),
  );

  const { data } = runRetrievalEval({ corpusPath, repoRoot });

  assert.equal(data.passed, false);
  assert.equal(data.exitCode, 1);
  const failing = [...data.cases.retrieval, ...data.cases.risk].filter((c) => !c.pass);
  assert.equal(failing.length, 2, "both the impossible retrieval and wrong-risk cases must fail");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runRetrievalEval reports a known gap without letting it move the floors or the exit code", () => {
  // A miss is recorded as a case before its fix lands. It still runs, so the
  // report says when it closes, but it must not fail the gate meanwhile.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-eval-gap-"));
  const corpusPath = path.join(dir, "corpus.json");
  const passing = { name: "events-controller", query: "events controller", repoFixture: "sample-api", expectedPrimary: ["src/events/events.controller.ts"] };
  fs.writeFileSync(
    corpusPath,
    JSON.stringify({
      k: 5,
      thresholds: { retrieval: { precisionAtK: 0.99, recallAtK: 0.99, mrr: 0.99 } },
      fixtureRoots: { "sample-api": "codex/skills/solumbe/evals/files/sample-api" },
      retrieval: [
        passing,
        {
          name: "open-gap",
          knownGap: true,
          query: "completely unrelated nonexistent symbol xyzzy",
          repoFixture: "sample-api",
          expectedPrimary: ["src/does/not/exist.ts"],
        },
        { ...passing, name: "closed-gap", knownGap: true },
      ],
      risk: [],
    }),
  );

  const { data, markdown } = runRetrievalEval({ corpusPath, repoRoot });

  assert.equal(data.passed, true, "a known gap must not fail the floors");
  assert.equal(data.exitCode, 0);
  assert.equal(data.counts.retrieval, 1, "known gaps are not counted as retrieval cases");
  assert.equal(data.counts.knownGaps, 2);
  assert.equal(data.scoreboard.retrieval.rAtK, 1, "the open gap's zero recall stays out of the aggregate");
  assert.match(markdown, /open-gap: still open/);
  assert.match(markdown, /closed-gap: now passes; remove its knownGap marker/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("runRetrievalEval rejects a malformed corpus", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-eval-bad-"));
  const corpusPath = path.join(dir, "corpus.json");
  fs.writeFileSync(corpusPath, JSON.stringify({ retrieval: "nope" }));
  assert.throws(() => runRetrievalEval({ corpusPath }), /retrieval\[\] and risk\[\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});
