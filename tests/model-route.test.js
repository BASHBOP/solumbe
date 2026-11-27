import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  askJev,
  BAND_CHEAP,
  BAND_MID,
  CONFIDENCE_FLOOR,
  loadHosts,
  offlineAnswers,
  QUESTIONS,
  routeFooter,
  scoreDecision,
  signalsFrom,
} from "../src/lib/model-route.js";
import { JEV_PER_MTOK, priceJevCall } from "../src/lib/jev.js";
import { generateAxScore } from "../src/lib/ax.js";
import { formatRouteMarkdown, formatRouteTerminal } from "../src/lib/render/route.js";
import { createRenderer } from "../src/lib/render/fancy.js";

/** Minimal answer set; override one field per test. */
function answers(overrides = {}) {
  return {
    specificity: { type: "score", score: 0, confidence: 0.9, probabilities: {} },
    blast_radius: { type: "score", score: 0, confidence: 0.9, probabilities: {} },
    novelty: { type: "noul", noul: 0 },
    ...overrides,
  };
}

function signals(overrides = {}) {
  return {
    repoName: "fixture",
    ax: 80,
    containment: 10,
    owners: 1,
    candidates: 1,
    moduleSpread: 1,
    riskPaths: [],
    riskEvidence: {},
    topFile: "src/a.js",
    evidence: [],
    ...overrides,
  };
}

test("each term takes a share of AX, so the score stays on the scale its bands were drawn for", () => {
  // A perfect request costs nothing and the score IS the AX score.
  const clean = scoreDecision({ answers: answers(), signals: signals({ ax: 80 }) });
  assert.equal(clean.route, 80);
  assert.equal(clean.baseTier, "cheap");

  // The worst request spends 60% of AX and no more, because the shares are
  // fractions of the base rather than a flat number of points.
  const worst = scoreDecision({
    answers: answers({
      specificity: { score: 2, confidence: 0.9, probabilities: {} },
      blast_radius: { score: 2, confidence: 0.9, probabilities: {} },
      novelty: { noul: 1 },
    }),
    signals: signals({ ax: 80 }),
  });
  assert.equal(worst.route, Math.round(80 * 0.4));

  // Flat points would make the penalty identical at every AX. Shares scale.
  const low = scoreDecision({
    answers: answers({ specificity: { score: 2, confidence: 0.9, probabilities: {} } }),
    signals: signals({ ax: 40 }),
  });
  const high = scoreDecision({
    answers: answers({ specificity: { score: 2, confidence: 0.9, probabilities: {} } }),
    signals: signals({ ax: 80 }),
  });
  assert.equal(low.route, Math.round(40 * 0.75));
  assert.equal(high.route, Math.round(80 * 0.75));
  assert.notEqual(high.route - low.route, 0);
});

test("bands split the route score at the documented thresholds", () => {
  const at = (route) => {
    // Pick an AX that lands exactly on `route` with no deductions.
    const scoring = scoreDecision({ answers: answers(), signals: signals({ ax: route }) });
    return scoring.baseTier;
  };
  assert.equal(at(BAND_CHEAP), "cheap");
  assert.equal(at(BAND_CHEAP - 1), "mid");
  assert.equal(at(BAND_MID), "mid");
  assert.equal(at(BAND_MID - 1), "premium");
});

test("containment above the threshold returns a share of AX", () => {
  const without = scoreDecision({ answers: answers(), signals: signals({ ax: 50, containment: 39 }) });
  const with_ = scoreDecision({ answers: answers(), signals: signals({ ax: 50, containment: 40 }) });
  assert.equal(with_.route - without.route, 5);
  assert.ok(with_.steps.some((step) => step.label === "containment"));
  assert.ok(!without.steps.some((step) => step.label === "containment"));
});

test("a route score is clamped into 0..100 and says so", () => {
  const scoring = scoreDecision({
    answers: answers({
      specificity: { score: 2, confidence: 0.9, probabilities: {} },
      blast_radius: { score: 2, confidence: 0.9, probabilities: {} },
      novelty: { noul: 1 },
    }),
    signals: signals({ ax: 0 }),
  });
  assert.equal(scoring.route, 0);
});

test("bumps only ever escalate, and report a ceiling instead of wrapping", () => {
  // A mid-band score with a top-severity risk flag moves up one tier.
  const bumped = scoreDecision({
    answers: answers(),
    signals: signals({ ax: 50, riskPaths: ["auth/security"] }),
  });
  assert.equal(bumped.baseTier, "mid");
  assert.equal(bumped.tier, "premium");

  // Already premium: the bump fires but cannot move further, and never wraps
  // back round to cheap.
  const ceiling = scoreDecision({
    answers: answers(),
    signals: signals({ ax: 20, riskPaths: ["auth/security"] }),
  });
  assert.equal(ceiling.baseTier, "premium");
  assert.equal(ceiling.tier, "premium");
  assert.equal(ceiling.bumps.find((b) => b.name === "risk path").ceiling, true);
});

test("only top-severity risk flags bump, as solumbe already weights them", () => {
  // `dependency` is weighted zero by the gate, so it must not escalate here.
  const dependency = scoreDecision({ answers: answers(), signals: signals({ ax: 50, riskPaths: ["dependency"] }) });
  assert.equal(dependency.tier, "mid");
  assert.equal(dependency.bumps.find((b) => b.name === "risk path").fired, false);

  for (const flag of ["auth/security", "money flow", "data model"]) {
    const scoring = scoreDecision({ answers: answers(), signals: signals({ ax: 50, riskPaths: [flag] }) });
    assert.equal(scoring.tier, "premium", `${flag} should bump`);
  }
});

test("confidence reads the weaker of the two Score answers, because Noul carries none", () => {
  const scoring = scoreDecision({
    answers: answers({
      specificity: { score: 0, confidence: 0.2, probabilities: {} },
      blast_radius: { score: 0, confidence: 0.99, probabilities: {} },
    }),
    signals: signals({ ax: 80 }),
  });
  assert.equal(scoring.confidence, 0.2);
  assert.ok(scoring.confidence < CONFIDENCE_FLOOR);
  // Reported, but not routed on: both answers say the change is trivial, and a
  // weak confidence on one of them does not make it less trivial.
  assert.equal(scoring.baseTier, "cheap");
  assert.equal(scoring.tier, "cheap");
});

test("an unsure question does not discard a confident one", () => {
  // Regression, measured: "rename the variable `running` to `score` in
  // model-route.js". Jev put the whole distribution on "names the exact file,
  // symbol, flag or user-visible string" at confidence 1.00 — as certain as an
  // answer gets — and 0.80 on "contained to a single file" at confidence 0.54.
  // Both say trivial. `Math.min` kept 0.54, missed the 0.55 floor by one
  // hundredth, and routed a one-file rename to the premium tier.
  const scoring = scoreDecision({
    answers: answers({
      specificity: { score: 0, confidence: 1, probabilities: {} },
      blast_radius: { score: 0.31, confidence: 0.54, probabilities: {} },
      novelty: { type: "noul", noul: 0.06 },
    }),
    signals: signals({ ax: 71, containment: 10, candidates: 3 }),
  });
  assert.ok(scoring.confidence < CONFIDENCE_FLOOR, "the weaker answer is still reported");
  assert.equal(scoring.tier, scoring.baseTier, "a weak confidence must not move the tier");
  assert.notEqual(scoring.tier, "premium");
});

test("no bump routes on confidence at all", () => {
  // The remaining bumps are solumbe's own deterministic repository signals. A
  // vendor answer's self-reported certainty is not one of them.
  const scoring = scoreDecision({
    answers: answers({ specificity: { score: 0, confidence: 0, probabilities: {} } }),
    signals: signals({ ax: 80 }),
  });
  assert.deepEqual(
    scoring.bumps.map((entry) => entry.name),
    ["no evidence", "risk path"],
  );
});

test("signals classify the top ranked predictions, not only the owner buckets", () => {
  // Regression: an auth file ranked FIRST but sitting in the advisory bucket
  // left risk_paths empty, so the auth/security bump never fired.
  const impact = {
    repo: { name: "fixture" },
    classifications: { requiredOwners: ["src/ui/panel.tsx"], supportingFiles: [], advisoryFiles: [] },
    topFiles: [{ path: "redux/slices/auth-slice.ts", kind: "state", reasons: ["path matches: auth"] }],
  };
  const ax = { ax: 60, subScores: { containment: 20 } };
  const derived = signalsFrom(impact, ax);
  assert.ok(derived.riskPaths.includes("auth/security"));
  assert.ok(derived.riskEvidence["auth/security"].includes("redux/slices/auth-slice.ts"));
});

test("reach is measured by module spread, never by containment, which AX already counts", () => {
  const base = {
    repo: { name: "fixture" },
    topFiles: [],
    classifications: { requiredOwners: ["a/one.ts", "b/two.ts", "c/three.ts"], supportingFiles: [] },
  };
  const tight = signalsFrom(base, { ax: 60, subScores: { containment: 90 } });
  const loose = signalsFrom(base, { ax: 60, subScores: { containment: 5 } });
  // Containment differs wildly; the spread that feeds the offline reach
  // estimate does not move with it.
  assert.equal(tight.moduleSpread, loose.moduleSpread);
  assert.equal(tight.moduleSpread, 3);
});

test("offline answers are deterministic, bounded, and labelled as uncalibrated", () => {
  const derived = signals({ owners: 2, moduleSpread: 3 });
  const first = offlineAnswers("figure out why the fee is wrong", derived);
  const second = offlineAnswers("figure out why the fee is wrong", derived);
  assert.deepEqual(first, second);
  assert.equal(first.source, "offline");
  assert.equal(first.tokens, null);

  for (const answer of [first.answers.specificity, first.answers.blast_radius]) {
    assert.ok(answer.score >= 0 && answer.score <= 2);
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 0.02, `probabilities should sum to 1, got ${total}`);
  }
  assert.ok(first.answers.novelty.noul >= 0 && first.answers.novelty.noul <= 1);

  // A symptom-only request must read as less specific than a named target.
  const vague = offlineAnswers("something is broken, figure out why", derived).answers.specificity.score;
  const precise = offlineAnswers("fix the typo in the confirmation copy", derived).answers.specificity.score;
  assert.ok(vague > precise, `${vague} should exceed ${precise}`);
});

test("a fixture corpus counts toward reach but never carries a risk flag", () => {
  // Regression: routing this repository read its own shop-api eval fixture as
  // money-flow code, so a request that touched nothing shipped escalated to
  // premium on evidence from a test corpus.
  const impact = {
    repo: { name: "fixture" },
    classifications: {
      requiredOwners: ["evals/fixtures/shop-api/src/payment/checkout.service.ts"],
      supportingFiles: [],
      advisoryFiles: [],
    },
    topFiles: [{ path: "evals/fixtures/shop-api/src/payment/checkout.service.ts", kind: "service", reasons: [] }],
  };
  const derived = signalsFrom(impact, { ax: 90, subScores: { containment: 80 } });
  assert.deepEqual(derived.riskPaths, []);
  // Still a candidate: the file is real evidence about reach, just not risk.
  assert.equal(derived.candidates, 1);

  // The same path shape outside a fixture corpus still flags.
  const shipped = signalsFrom(
    {
      repo: { name: "fixture" },
      classifications: { requiredOwners: ["src/payment/checkout.service.ts"], supportingFiles: [], advisoryFiles: [] },
      topFiles: [],
    },
    { ax: 90, subScores: { containment: 80 } },
  );
  assert.ok(shipped.riskPaths.includes("money flow"));
});

test("documentation about a risky area is never evidence that a change touches it", () => {
  // Regression: #175 indexed markdown, so `docs/AUTH_TOKEN_VALIDATION.md`
  // became a candidate for "fix a typo in the README". It classified as
  // auth/security on the "auth" and "token" path tokens and forced `premium`
  // for a one-line doc edit. Prose about token validation does not validate
  // tokens.
  const ax = { ax: 60, subScores: { containment: 20 } };
  const doc = signalsFrom(
    {
      repo: { name: "fixture" },
      classifications: { requiredOwners: ["docs/AUTH_TOKEN_VALIDATION.md"], supportingFiles: [], advisoryFiles: [] },
      topFiles: [{ path: "docs/AUTH_TOKEN_VALIDATION.md", kind: "doc", reasons: [] }],
    },
    ax,
  );
  assert.deepEqual(doc.riskPaths, []);
  // Still a candidate: the doc is real evidence about reach, just not risk.
  assert.equal(doc.candidates, 1);

  // A skill page is markdown a contributor edits, not code it describes.
  const skill = signalsFrom(
    {
      repo: { name: "fixture" },
      classifications: { requiredOwners: ["skills/session-helper/SKILL.md"], supportingFiles: [], advisoryFiles: [] },
      topFiles: [{ path: "skills/session-helper/SKILL.md", kind: "skill", reasons: [] }],
    },
    ax,
  );
  assert.deepEqual(skill.riskPaths, []);

  // Owner buckets are bare paths, so a candidate the ranking never reached has
  // no kind to read. The path-shape fallback still recognises the doc.
  const unranked = signalsFrom(
    {
      repo: { name: "fixture" },
      classifications: { requiredOwners: ["docs/AUTH_TOKEN_VALIDATION.md"], supportingFiles: [], advisoryFiles: [] },
      topFiles: [],
    },
    ax,
  );
  assert.deepEqual(unranked.riskPaths, []);
});

test("auth code still carries the risk flag, and the doc beside it is not listed as evidence", () => {
  // The bump itself is sound — excluding docs must not blunt it. Exclusion is
  // outright rather than "only when the doc is the sole evidence": where real
  // code carries the flag the doc adds nothing, so listing it would assert
  // that a prose file is part of why the change is risky.
  const derived = signalsFrom(
    {
      repo: { name: "fixture" },
      classifications: {
        requiredOwners: ["src/auth/session.service.ts"],
        supportingFiles: ["docs/AUTH_TOKEN_VALIDATION.md"],
        advisoryFiles: [],
      },
      topFiles: [
        { path: "src/auth/session.service.ts", kind: "service", reasons: [] },
        { path: "docs/AUTH_TOKEN_VALIDATION.md", kind: "doc", reasons: [] },
      ],
    },
    { ax: 60, subScores: { containment: 20 } },
  );
  assert.deepEqual(derived.riskPaths, ["auth/security"]);
  assert.deepEqual(derived.riskEvidence["auth/security"], ["src/auth/session.service.ts"]);
  assert.equal(derived.candidates, 2);

  // And the flag still bumps a mid read one tier.
  const scoring = scoreDecision({ answers: answers(), signals: signals({ ax: 50, riskPaths: derived.riskPaths }) });
  assert.equal(scoring.bumps.find((entry) => entry.name === "risk path").fired, true);
});

test("the offline estimate reports no confidence, so the fail-safe cannot read its shape", () => {
  // Regression: `distribute(0.6)` — the baseline for any request the keyword
  // lists do not recognise — peaks at 0.40, which read as confidence sat below
  // the floor and bumped every unknown request one tier.
  const derived = signals();
  const offline = offlineAnswers("add a --json flag to the seating export", derived);
  assert.equal(offline.answers.specificity.confidence, null);
  assert.equal(offline.answers.blast_radius.confidence, null);

  const scoring = scoreDecision({ answers: offline.answers, signals: derived });
  assert.equal(scoring.confidence, null);
  assert.equal(
    scoring.bumps.find((entry) => entry.name === "low confidence"),
    undefined,
  );
  assert.equal(scoring.tier, scoring.baseTier);
});

test("a measured confidence below the floor does not escalate", () => {
  // The inverse of the bug: an unsure answer whose own score says "trivial"
  // stays in the tier its score earned. Uncertainty is already priced into
  // `score`, which is the expectation over that question's level distribution.
  const scoring = scoreDecision({
    answers: answers({ specificity: { score: 0, confidence: 0.2, probabilities: {} } }),
    signals: signals({ ax: 80 }),
  });
  assert.equal(scoring.confidence, 0.2);
  assert.equal(scoring.tier, scoring.baseTier);
  assert.equal(scoring.tier, "cheap");
});

test("Score questions send criteria as an ordered list, which the API requires", () => {
  for (const name of ["specificity", "blast_radius"]) {
    assert.equal(QUESTIONS[name].type, "score");
    assert.ok(Array.isArray(QUESTIONS[name].criteria), `${name} criteria must be a list`);
    assert.equal(QUESTIONS[name].criteria.length, 3);
  }
  assert.equal(QUESTIONS.novelty.type, "noul");
});

test("askJev normalises a level-indexed distribution onto level names", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      model: "jev-1.13.0",
      usage: { input_tokens: 700 },
      answers: {
        specificity: { type: "score", score: 1.2, confidence: 0.8, probabilities: [0.1, 0.7, 0.2] },
        blast_radius: { type: "score", score: 0.5, confidence: 0.6, probabilities: { 0: 0.6, 1: 0.3, 2: 0.1 } },
        novelty: { type: "noul", noul: 0.3 },
      },
    }),
  });
  const result = await askJev("a request", signals(), { apiKey: "test-key", fetchImpl });
  assert.equal(result.source, "jev");
  assert.equal(result.tokens, 700);
  assert.equal(result.billableTokens, 700);
  assert.equal(result.tokenKind, "input");
  assert.deepEqual(Object.keys(result.answers.specificity.probabilities), ["names the target", "names an area", "names a symptom"]);
  assert.deepEqual(Object.keys(result.answers.blast_radius.probabilities), ["one file", "one module", "cross-cutting"]);
  assert.equal(result.answers.blast_radius.probabilities["one file"], 0.6);
});

test("askJev sends the request and repository evidence as state", async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ answers: { ...answers(), recommended_tier: { choice: "premium" } } }) };
  };
  const result = await askJev("migrate the session cookie", signals({ riskPaths: ["auth/security"], evidence: [{ path: "a.ts" }] }), {
    apiKey: "k",
    fetchImpl,
  });
  assert.equal(sent.state.request, "migrate the session cookie");
  assert.deepEqual(sent.state.risk_flags, ["auth/security"]);
  assert.deepEqual(sent.state.likely_files, [{ path: "a.ts" }]);
  assert.equal(sent.model, "jev-latest");
  assert.equal(sent.questions.recommended_tier.type, "choice");
  assert.equal(result.answers.recommended_tier.choice, "premium");
});

test("askJev folds the request read into the same call and keeps it out of the score", async () => {
  let sent;
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    sent = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        answers: {
          specificity: { type: "score", score: 0.2, confidence: 0.9, probabilities: [0.9, 0.08, 0.02] },
          blast_radius: { type: "score", score: 0.1, confidence: 0.9, probabilities: [0.9, 0.08, 0.02] },
          novelty: { type: "noul", noul: 0.1 },
          read_intent: { type: "choice", choice: "change", confidence: 0.8, probabilities: { change: 0.87 } },
          read_capability: { type: "choice", choice: "model_route", confidence: 0.2, probabilities: { model_route: 0.4 } },
          read_file_0: { type: "noul", noul: 0.9 },
          read_file_1: { type: "noul", noul: 0.05 },
        },
      }),
    };
  };
  const result = await askJev("reword the doctor banner", signals({ evidence: [{ path: "src/doctor.js" }, { path: "src/billing.js" }] }), {
    apiKey: "k",
    fetchImpl,
  });

  assert.equal(calls, 1, "one round trip for route and read together");
  assert.deepEqual(Object.keys(sent.questions), [
    "specificity",
    "blast_radius",
    "novelty",
    "recommended_tier",
    "read_intent",
    "read_capability",
    "read_file_0",
    "read_file_1",
  ]);
  assert.deepEqual(Object.keys(result.answers), ["specificity", "blast_radius", "novelty"], "the scorer sees route answers only");
  assert.equal(result.read.intent.choice, "change");
  assert.equal(result.read.intent.accepted, true);
  assert.equal(result.read.capability.accepted, false);
  assert.deepEqual(result.read.relevance, [
    { path: "src/doctor.js", relevance: 0.9 },
    { path: "src/billing.js", relevance: 0.05 },
  ]);

  // The read never moves the tier: the same route answers with and without it
  // score identically.
  const withRead = scoreDecision({ answers: result.answers, signals: signals() });
  const withoutRead = scoreDecision({ answers: pickRoute(result.answers), signals: signals() });
  assert.deepEqual(withRead, withoutRead);

  const markdown = formatRouteMarkdown({
    request: "reword the doctor banner",
    repo: { name: "fixture" },
    scoring: withRead,
    model: { source: "jev", model: "jev-test", answers: result.answers, read: result.read },
    signals: signals(),
  });
  assert.match(markdown, /Request read, reported and never scored/);
  assert.match(markdown, /\*\*Intent\*\*: change \(confidence 0\.8\)/);
  assert.match(markdown, /\*\*solumbe tool\*\*: model_route \(confidence 0\.2, under the floor\)/);
  assert.match(markdown, /`src\/billing\.js` 0\.05/);

  const terminal = formatRouteTerminal(
    {
      request: "reword the doctor banner",
      repo: { name: "fixture" },
      scoring: withRead,
      model: { source: "jev", model: "jev-test", answers: result.answers, read: result.read, tokens: null },
      signals: signals(),
      costUsd: null,
    },
    createRenderer({ color: false, emoji: false }),
  );
  assert.match(terminal, /request read {2}\(reported, never scored\)/);
  assert.match(terminal, /solumbe tool {4}model_route {2}0\.20 {2}under the floor/);
});

/** @param {Record<string, any>} answers */
function pickRoute(answers) {
  return { specificity: answers.specificity, blast_radius: answers.blast_radius, novelty: answers.novelty };
}

test("an offline route has no request read to report", () => {
  assert.equal(offlineAnswers("a request", signals()).read, null);
});

test("askJev surfaces an API failure rather than inventing an answer", async (t) => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  await assert.rejects(() => askJev("q", signals(), { apiKey: "k", fetchImpl }), /401/);

  // The missing-key path has to be asserted against a controlled environment,
  // not the developer's. `askJev` falls back to process.env.TYPESAFE_API_KEY,
  // so on a machine that exports one this test used to pass a real key to the
  // stub and assert the wrong error.
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  });
  await assert.rejects(() => askJev("q", signals(), { apiKey: undefined, fetchImpl }), /TYPESAFE_API_KEY/);
});

test("host maps merge built-ins with repo config, and repo wins", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-route-hosts-"));
  fs.mkdirSync(path.join(fixture, ".solumbe"), { recursive: true });
  fs.writeFileSync(path.join(fixture, ".solumbe", "model-route.json"), JSON.stringify({ hosts: { cursor: { cheap: "c", mid: "m", premium: "p" } } }));
  const hosts = loadHosts(fixture);
  assert.equal(hosts.cursor.premium, "p");
  assert.equal(hosts["claude-code"].premium, "claude-opus-5-5");

  // A missing or unreadable config is not an error.
  const empty = loadHosts(fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-route-empty-")));
  assert.ok(empty["claude-code"]);
});

test("the advisory footer is offline, one line, and names itself uncalibrated", () => {
  const impact = {
    repo: { name: "fixture" },
    topFiles: [],
    classifications: { requiredOwners: ["src/a.ts"], supportingFiles: [] },
  };
  const footer = routeFooter("fix the typo in the label", impact, { ax: 80, subScores: { containment: 50 } });
  assert.ok(["cheap", "mid", "premium"].includes(footer.tier));
  assert.match(footer.line, /^model route: /);
  assert.match(footer.line, /offline estimate, advisory$/);
  assert.equal(footer.line.includes("\n"), false);
});

test("terminal output carries no escape codes when colour is off", () => {
  const data = {
    request: "a request",
    repo: { name: "fixture" },
    scoring: scoreDecision({ answers: answers(), signals: signals() }),
    model: { source: "offline", model: "offline-heuristic", answers: answers(), tokens: null, latencyMs: 0 },
    signals: signals(),
    costUsd: null,
  };
  const plain = formatRouteTerminal(data, createRenderer({ color: false, emoji: false }));
  assert.equal(plain.includes(String.fromCharCode(27)), false);
  assert.match(plain, /MODEL ROUTE/);
  assert.match(plain, /advisory/);

  const coloured = formatRouteTerminal(data, createRenderer({ color: true, emoji: false }));
  assert.ok(coloured.includes(String.fromCharCode(27)));
});

test("markdown output records the tier, the source, and that it is advisory", () => {
  const data = {
    request: "a request",
    repo: { name: "fixture" },
    scoring: scoreDecision({ answers: answers(), signals: signals() }),
    model: { source: "offline", model: "offline-heuristic", answers: answers() },
    signals: signals(),
  };
  const markdown = formatRouteMarkdown(data);
  assert.match(markdown, /# Model route: cheap/);
  assert.match(markdown, /offline estimate, not calibrated/);
  assert.match(markdown, /\*\*Advisory\*\*/);
});

test("AX accepts an injected impact pass, so a composite command pays for it once", () => {
  // `solumbe route` needs the impact pass for its own signals and AX needs it for
  // changeability. Without injection the expensive half runs twice, which was
  // the whole of the prototype's local cost.
  const impact = {
    repo: { name: "fixture", root: "/tmp/fixture" },
    topFiles: [],
    classifications: { requiredOwners: [], supportingFiles: [] },
    tokenEstimate: { total: 200 },
    risks: [],
    concepts: [],
    validation: {},
  };
  const cheapToChange = generateAxScore("a request", { path: ".", impact });

  const expensive = { ...impact, tokenEstimate: { total: 400000 } };
  const costlyToChange = generateAxScore("a request", { path: ".", impact: expensive });

  // The injected pass is what AX scored: a huge token estimate must lower
  // changeability. If the option were ignored both calls would be identical.
  assert.ok(
    cheapToChange.subScores.changeability > costlyToChange.subScores.changeability,
    `${cheapToChange.subScores.changeability} should beat ${costlyToChange.subScores.changeability}`,
  );
});

test("no evidence goes straight to the ceiling instead of reading as a contained change", () => {
  // The failure this exists for: a request asked against a repository that has
  // no such code matches nothing, so containment reads 100 for the same reason
  // AX is high — there is nothing to spread across. Before the floor, that
  // routed `cheap` on a score of 85.
  const empty = scoreDecision({ answers: answers(), signals: signals({ ax: 84, containment: 100, candidates: 0, owners: 0, topFile: null }) });
  assert.equal(empty.tier, "premium", "an unexplained request must never land in a cheap lane");
  assert.equal(empty.evidence.sufficient, false);
  assert.equal(empty.evidence.candidates, 0);

  const fired = empty.bumps.find((bump) => bump.name === "no evidence");
  assert.equal(fired?.fired, true);
  assert.match(String(fired?.note), /matched no files/);
});

test("the evidence floor jumps the ceiling rather than stepping one tier", () => {
  // A one-tier step would leave a high-AX empty read at `mid`, which is the
  // same mistake one notch quieter.
  const empty = scoreDecision({ answers: answers(), signals: signals({ ax: 95, containment: 100, candidates: 0 }) });
  assert.equal(empty.baseTier, "cheap", "the arithmetic still reports what it computed");
  assert.equal(empty.tier, "premium", "the floor overrides it outright");
});

test("a request with evidence is unaffected by the floor", () => {
  const scoring = scoreDecision({ answers: answers(), signals: signals({ ax: 80, candidates: 3 }) });
  assert.equal(scoring.tier, "cheap");
  assert.equal(scoring.evidence.sufficient, true);
  assert.equal(scoring.evidence.candidates, 3);
  assert.equal(scoring.bumps.find((bump) => bump.name === "no evidence")?.fired, false);
});

/** One fetch that answers with whatever usage block a test hands it. */
function usageFetch(usage) {
  return async () => ({
    ok: true,
    json: async () => ({ model: "jev-1.13.1", usage, answers: answers() }),
  });
}

test("askJev prices input tokens and refuses to price a total", async () => {
  const input = await askJev("a request", signals(), { apiKey: "k", fetchImpl: usageFetch({ input_tokens: 700 }) });
  assert.equal(input.tokens, 700);
  assert.equal(input.billableTokens, 700);
  assert.equal(input.tokenKind, "input");

  // The rate covers input only. A total also contains output, so the count is
  // reported and the cost is withheld rather than billed at the wrong rate.
  const total = await askJev("a request", signals(), { apiKey: "k", fetchImpl: usageFetch({ total_tokens: 900 }) });
  assert.equal(total.tokens, 900);
  assert.equal(total.billableTokens, null);
  assert.equal(total.tokenKind, "total");
  assert.equal(priceJevCall(total.billableTokens), null);

  // A bare `tokens` field is no more specific than a total, and is read as one.
  const bare = await askJev("a request", signals(), { apiKey: "k", fetchImpl: usageFetch({ tokens: 120 }) });
  assert.equal(bare.tokenKind, "total");
  assert.equal(bare.billableTokens, null);

  // An input count alongside a total still prices on the input count.
  const both = await askJev("a request", signals(), { apiKey: "k", fetchImpl: usageFetch({ input_tokens: 700, total_tokens: 900 }) });
  assert.equal(both.tokens, 700);
  assert.equal(both.billableTokens, 700);
  assert.equal(priceJevCall(both.billableTokens), Number(((700 * JEV_PER_MTOK) / 1e6).toFixed(6)));

  const none = await askJev("a request", signals(), { apiKey: "k", fetchImpl: usageFetch(undefined) });
  assert.equal(none.tokens, null);
  assert.equal(none.tokenKind, null);
});

test("offlineAnswers reports no tokens of any kind", () => {
  const offline = offlineAnswers("a request", signals());
  assert.equal(offline.tokens, null);
  assert.equal(offline.billableTokens, null);
  assert.equal(offline.tokenKind, null);
  assert.equal(priceJevCall(offline.billableTokens), null);
});

test("the route call line reports a total it cannot price, and omits itself with no tokens", () => {
  const base = {
    request: "a request",
    repo: { name: "fixture" },
    scoring: scoreDecision({ answers: answers(), signals: signals() }),
    signals: signals(),
  };
  const render = (/** @type {any} */ model, /** @type {number|null} */ costUsd) =>
    formatRouteTerminal({ ...base, model: { source: "jev", answers: answers(), ...model }, costUsd }, createRenderer({ color: false, emoji: false }));

  const priced = render({ tokens: 700, billableTokens: 700, tokenKind: "input", latencyMs: 40 }, 0.0000294);
  assert.match(priced, /route call: 700 tokens, \$0\.000029, 40 ms/);

  // A total is still worth printing; the price is not, so the line says why.
  const unpriced = render({ tokens: 900, billableTokens: null, tokenKind: "total", latencyMs: 55 }, null);
  assert.match(unpriced, /route call: 900 total tokens, not priced \(rate covers input tokens only\), 55 ms/);
  assert.equal(/\$/.test(unpriced.split("route call:")[1]), false);

  // An offline run measured no tokens at all, so there is no call to report.
  const offline = render({ source: "offline", tokens: null, billableTokens: null, tokenKind: null, latencyMs: 0 }, null);
  assert.equal(offline.includes("route call:"), false);
});

test("each question reports its own confidence, not only the weaker of the two", () => {
  const scoring = scoreDecision({
    answers: answers({
      specificity: { type: "score", score: 0, confidence: 0.95, probabilities: {} },
      blast_radius: { type: "score", score: 0, confidence: 0.4, probabilities: {} },
    }),
    signals: signals(),
  });
  assert.equal(scoring.confidence, 0.4);
  assert.deepEqual(scoring.confidences, { specificity: 0.95, blast_radius: 0.4 });
  assert.equal(scoring.tier, "cheap", "confidence stays display only");

  const offline = scoreDecision({
    answers: answers({ specificity: { type: "score", score: 0, confidence: null, probabilities: {} } }),
    signals: signals(),
  });
  assert.equal(offline.confidences.specificity, null);
});

test("no evidence renders as no recommendation, still naming the fail-safe tier", () => {
  const data = {
    request: "fix scanning multi date event ticket",
    repo: { name: "fixture" },
    scoring: scoreDecision({ answers: answers(), signals: signals({ ax: 84, containment: 100, candidates: 0 }) }),
    model: { source: "offline", model: "offline-heuristic", answers: answers() },
    signals: signals({ candidates: 0 }),
    costUsd: null,
  };
  const plain = formatRouteTerminal(data, createRenderer({ color: false, emoji: false }));
  assert.match(plain, /NO RECOMMENDATION\s+fails safe to premium/);
  assert.doesNotMatch(plain, /TIER\s+PREMIUM/);

  const markdown = formatRouteMarkdown(data);
  assert.match(markdown, /# Model route: no recommendation/);
  assert.match(markdown, /fails safe to premium/);
});

test("markdown shows each question's confidence beside its score", () => {
  const data = {
    request: "a request",
    repo: { name: "fixture" },
    scoring: scoreDecision({ answers: answers(), signals: signals() }),
    model: { source: "jev", model: "jev-1", answers: answers() },
    signals: signals(),
  };
  const markdown = formatRouteMarkdown(data);
  assert.match(markdown, /\| specificity \| 0\.00 \(confidence 0\.90\) \|/);
  assert.match(markdown, /\| blast_radius \| 0\.00 \(confidence 0\.90\) \|/);
});

test("a hosted tier controls the recommendation before repository-risk overrides", () => {
  const hosted = { ...answers(), recommended_tier: { choice: "cheap" } };
  const direct = scoreDecision({ answers: hosted, signals: signals({ ax: 20 }) });
  assert.equal(direct.tierSource, "model");
  assert.equal(direct.baseTier, "cheap");
  assert.equal(direct.tier, "cheap");
  assert.equal(scoreDecision({ answers: hosted, signals: signals({ ax: 20, riskPaths: ["auth/security"] }) }).tier, "mid");
  assert.equal(scoreDecision({ answers: hosted, signals: signals({ candidates: 0 }) }).tier, "premium");
  const invalid = scoreDecision({ answers: { ...hosted, recommended_tier: { choice: "constructor" } }, signals: signals({ ax: 20 }) });
  assert.equal(invalid.tierSource, "weighted-score");
  assert.equal(invalid.tier, "premium");
});
