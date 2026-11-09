import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  askClaudeRead,
  askRequestRead,
  claudeAnswers,
  CLAUDE_API_URL,
  CLAUDE_READ_MODEL,
  CLAUDE_READ_TOOL,
  priceClaudeCall,
  readProvider,
  readReasoning,
  readTool,
  validateReadInput,
} from "../src/lib/claude-read.js";
import { generateContextPack } from "../src/lib/context-engine.js";
import { readContextPack } from "../src/lib/context-read.js";
import { CAPABILITIES, CHOICE_FLOOR, INTENTS, interpretRead } from "../src/lib/jev.js";
import { aggregateReads, runReadEval } from "../src/lib/read-eval.js";

const files = [{ path: "src/a.js" }, { path: "docs/b.md" }];
const labels = files.map((file) => file.path);

/** A Messages API reply carrying one forced tool call. */
function toolReply(input, { id = "toolu_1", usage = { input_tokens: 900, output_tokens: 60 }, stop_reason = "tool_use" } = {}) {
  return {
    id: "msg_1",
    model: CLAUDE_READ_MODEL,
    stop_reason,
    usage,
    content: [{ type: "tool_use", id, name: CLAUDE_READ_TOOL, input }],
  };
}

/** A fetch that answers each request with the next payload and records what was sent. */
function scripted(payloads, sent = []) {
  return async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const payload = payloads[Math.min(sent.length - 1, payloads.length - 1)];
    return /** @type {any} */ ({ ok: true, json: async () => payload });
  };
}

/** The answers alone, as a read with --no-reasoning writes them. */
const answersOnly = {
  intent: "review",
  intent_confidence: 0.82,
  capability: "review_context",
  capability_confidence: 0.6,
  relevance: [
    { file: "src/a.js", relevance: 0.9 },
    { file: "docs/b.md", relevance: 0.1 },
  ],
};
const thought = "It asks to check a against b, with no edit asked for, so it is a review.";
/** A read as the default asks for it: the reasoning first, then the answers. */
const good = { reasoning: thought, ...answersOnly };

test("the read tool's schema is the answer: enums over INTENTS and CAPABILITIES, every file by name", () => {
  const tool = readTool({ labels, intent: true, capability: true });
  assert.equal(tool.name, CLAUDE_READ_TOOL);
  assert.equal(tool.strict, true);
  const schema = /** @type {any} */ (tool.input_schema);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ["capability", "capability_confidence", "intent", "intent_confidence", "relevance"]);
  assert.deepEqual(schema.properties.intent.enum, Object.keys(INTENTS));
  assert.deepEqual(schema.properties.capability.enum, Object.keys(CAPABILITIES));
  assert.deepEqual(schema.properties.relevance.items.properties.file.enum, labels);
  assert.equal(schema.properties.relevance.items.additionalProperties, false);

  const intentOnly = /** @type {any} */ (readTool({ labels: [], intent: true, capability: false }).input_schema);
  assert.deepEqual(Object.keys(intentOnly.properties).sort(), ["intent", "intent_confidence"], "no files, no relevance array to fill");
});

test("validation catches what the schema cannot say: ranges, and every file exactly once", () => {
  const shape = { labels, intent: true, capability: true };
  assert.deepEqual(validateReadInput(good, shape), []);
  const errors = validateReadInput(
    {
      ...good,
      intent: "constructor",
      intent_confidence: 1.4,
      relevance: [
        { file: "src/a.js", relevance: 0.9 },
        { file: "src/a.js", relevance: 0.8 },
        { file: "src/elsewhere.js", relevance: 0.5 },
      ],
    },
    shape,
  );
  assert.ok(
    errors.some((error) => /intent must be one of/.test(error)),
    "an inherited key is not a choice",
  );
  assert.ok(errors.some((error) => /intent_confidence/.test(error)));
  assert.ok(errors.some((error) => /src\/a\.js 2 times/.test(error)));
  assert.ok(errors.some((error) => /missing docs\/b\.md/.test(error)));
  assert.ok(errors.some((error) => /not a candidate/.test(error)));
});

test("asked for reasoning, the read tool puts it first in the schema, so it is written before the answers", () => {
  const plain = /** @type {any} */ (readTool({ labels, intent: true, capability: true }).input_schema);
  assert.equal(Object.hasOwn(plain.properties, "reasoning"), false, "readTool adds only what its caller asks for");

  const shape = { labels, intent: true, capability: true, reasoning: true };
  const schema = /** @type {any} */ (readTool(shape).input_schema);
  assert.equal(Object.keys(schema.properties)[0], "reasoning", "strict tool use writes properties in schema order");
  assert.equal(schema.required[0], "reasoning");
  assert.equal(schema.properties.reasoning.type, "string");

  assert.deepEqual(validateReadInput(good, shape), []);
  assert.ok(validateReadInput(answersOnly, shape).some((error) => /reasoning must be a string/.test(error)));
  assert.deepEqual(validateReadInput(answersOnly, { labels, intent: true, capability: true }), [], "not asked, not required");
});

test("the Claude read reasons first by default; the option, then SOLUMBE_CLAUDE_READ_REASONING, turn it off", () => {
  assert.equal(readReasoning({}, {}), true);
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(readReasoning({}, { SOLUMBE_CLAUDE_READ_REASONING: off }), false, off);
  assert.equal(readReasoning({}, { SOLUMBE_CLAUDE_READ_REASONING: "1" }), true);
  assert.equal(readReasoning({ reasoning: false }, {}), false);
  assert.equal(readReasoning({ reasoning: true }, { SOLUMBE_CLAUDE_READ_REASONING: "0" }), true, "an explicit option beats the environment");
});

test("with or without reasoning the read sends the same prompt and applies the same answers; only the default returns the reasoning", async () => {
  const plainSent = [];
  const plain = await askClaudeRead(
    { request: "check a against b" },
    { files, capability: true },
    { anthropicApiKey: "k", reasoning: false, fetchImpl: scripted([toolReply(answersOnly)], plainSent) },
  );
  assert.equal(plain.reasoning, undefined);
  assert.equal(Object.hasOwn(plainSent[0].body.tools[0].input_schema.properties, "reasoning"), false);

  const sent = [];
  const reply = await askClaudeRead(
    { request: "check a against b" },
    { files, capability: true },
    { anthropicApiKey: "k", fetchImpl: scripted([toolReply(good)], sent) },
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.system, plainSent[0].body.system, "only the schema changes, so the eval compares one thing");
  assert.deepEqual(sent[0].body.tool_choice, plainSent[0].body.tool_choice);
  assert.equal(Object.keys(sent[0].body.tools[0].input_schema.properties)[0], "reasoning");
  assert.equal(reply.reasoning, thought);
  assert.deepEqual(reply.answers, plain.answers, "the reasoning is not an answer");

  const retried = [];
  const second = await askClaudeRead(
    { request: "check a against b" },
    { files, capability: true },
    { anthropicApiKey: "k", fetchImpl: scripted([toolReply(answersOnly), toolReply(good, { id: "toolu_2" })], retried) },
  );
  assert.equal(second.attempts, 2, "a read that skips the reasoning it was asked for is sent back once");
  assert.match(retried[1].body.messages[2].content[0].content, /reasoning must be a string/);
  assert.equal(second.reasoning, thought);
});

test("a forced tool call maps into the RequestRead shape interpretRead already reads", async () => {
  const sent = [];
  const reply = await askClaudeRead(
    { request: "check a against b" },
    { files, capability: true },
    { anthropicApiKey: "k", fetchImpl: scripted([toolReply(good)], sent) },
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, CLAUDE_API_URL);
  assert.equal(sent[0].headers["x-api-key"], "k");
  assert.equal(sent[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(sent[0].body.model, CLAUDE_READ_MODEL);
  assert.deepEqual(sent[0].body.tool_choice, { type: "tool", name: CLAUDE_READ_TOOL }, "the call is forced, not left to the model");
  assert.equal(sent[0].body.tools.length, 1);
  assert.equal(sent[0].body.temperature, undefined, "Haiku 5.5 rejects non-default sampling parameters");

  assert.equal(reply.source, "claude");
  assert.equal(reply.attempts, 1);
  assert.deepEqual(reply.validationErrors, []);
  assert.equal(reply.costUsd, priceClaudeCall(CLAUDE_READ_MODEL, 900, 60));

  const read = interpretRead(reply.answers, files);
  assert.deepEqual(read.intent, { choice: "review", confidence: 0.82, accepted: true, probabilities: { review: 0.82 } });
  assert.equal(read.capability?.choice, "review_context");
  assert.deepEqual(
    read.relevance.map((entry) => entry.relevance),
    [0.9, 0.1],
  );
});

test("a reply that fails validation goes back as an is_error tool_result, once", async () => {
  const sent = [];
  const bad = { ...good, intent_confidence: 1.4, relevance: [{ file: "src/a.js", relevance: 0.9 }] };
  const reply = await askClaudeRead(
    { request: "r" },
    { files },
    {
      anthropicApiKey: "k",
      fetchImpl: scripted([toolReply(bad, { id: "toolu_bad" }), toolReply(good, { id: "toolu_good", usage: { input_tokens: 1200, output_tokens: 70 } })], sent),
    },
  );

  assert.equal(sent.length, 2);
  const retry = sent[1].body.messages;
  assert.equal(retry.length, 3, "the original request, the assistant's call, and the error");
  assert.equal(retry[1].role, "assistant");
  assert.equal(retry[1].content[0].id, "toolu_bad");
  const result = retry[2].content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "toolu_bad");
  assert.equal(result.is_error, true);
  assert.match(result.content, /intent_confidence must be a number from 0 to 1/);
  assert.match(result.content, /relevance is missing docs\/b\.md/);
  assert.deepEqual(sent[1].body.tool_choice, sent[0].body.tool_choice, "the retry is forced too");

  assert.equal(reply.attempts, 2);
  assert.deepEqual(reply.validationErrors, []);
  assert.equal(reply.tokens, 900 + 60 + 1200 + 70, "both attempts are counted");
  assert.equal(reply.costUsd, priceClaudeCall(CLAUDE_READ_MODEL, 2100, 130));
  assert.equal(interpretRead(reply.answers, files).intent?.accepted, true);
});

test("after the one retry, interpretRead is the backstop: nothing invalid reads as accepted", async () => {
  const sent = [];
  // A proxy or a non-strict model could return a choice outside the enum and
  // a confidence outside 0..1. Neither survives the mapping.
  const bad = {
    intent: "constructor",
    intent_confidence: 0.99,
    capability: "review_gate",
    capability_confidence: 7,
    relevance: [{ file: "src/a.js", relevance: -1 }],
  };
  const reply = await askClaudeRead({ request: "r" }, { files }, { anthropicApiKey: "k", fetchImpl: scripted([toolReply(bad)], sent) });
  assert.equal(sent.length, 2, "one retry, then stop");
  assert.ok(reply.validationErrors?.length);

  const read = interpretRead(reply.answers, files);
  assert.equal(read.intent, null, "Object.hasOwn rejects an inherited key");
  assert.equal(read.capability?.confidence, null);
  assert.equal(read.capability?.accepted, false, "a confidence outside 0..1 is left out, so it cannot clear CHOICE_FLOOR");
  assert.deepEqual(
    read.relevance.map((entry) => entry.relevance),
    [null, null],
    "an out-of-range or missing score reads as null, never as a demotion",
  );
});

test("a reply with no tool call is retried as the same request; refusals and HTTP errors throw", async () => {
  const sent = [];
  const empty = { model: CLAUDE_READ_MODEL, stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 2048 }, content: [] };
  const reply = await askClaudeRead({ request: "r" }, { files }, { anthropicApiKey: "k", fetchImpl: scripted([empty, toolReply(good)], sent) });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.messages.length, 1, "nothing to answer with a tool_result");
  assert.equal(reply.attempts, 2);

  await assert.rejects(askClaudeRead({}, { files }, { anthropicApiKey: "k", fetchImpl: scripted([{ stop_reason: "refusal", content: [] }]) }), /refusal/);
  await assert.rejects(
    askClaudeRead(
      {},
      { files },
      { anthropicApiKey: "k", fetchImpl: async () => /** @type {any} */ ({ ok: false, status: 529, text: async () => "overloaded" }) },
    ),
    /Anthropic API 529: overloaded/,
  );
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(askClaudeRead({}, { files }, { fetchImpl: async () => assert.fail("no call without a key") }), /ANTHROPIC_API_KEY is not set/);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("claudeAnswers keeps the first score for a file scored twice and indexes by candidate order", () => {
  const answers = claudeAnswers(
    {
      relevance: [
        { file: "docs/b.md", relevance: 0.3 },
        { file: "docs/b.md", relevance: 0.9 },
      ],
    },
    files,
  );
  assert.deepEqual(answers, { read_file_1: { type: "noul", noul: 0.3 } });
});

test("priceClaudeCall prices listed models only, and an unmeasured count is not free", () => {
  assert.equal(priceClaudeCall(CLAUDE_READ_MODEL, 1_000_000, 1_000_000), 0.6);
  assert.equal(priceClaudeCall(CLAUDE_READ_MODEL, 0, 0), 0);
  assert.equal(priceClaudeCall("claude-unlisted", 10, 10), null);
  assert.equal(priceClaudeCall(CLAUDE_READ_MODEL, null, 10), null);
});

test("provider selection: a named provider, then a TypeSafe key, then an Anthropic key, else Jev", () => {
  assert.equal(readProvider({}, {}), "jev", "unkeyed keeps today's fallback reason");
  assert.equal(readProvider({}, { TYPESAFE_API_KEY: "t" }), "jev");
  assert.equal(readProvider({}, { TYPESAFE_API_KEY: "t", ANTHROPIC_API_KEY: "a" }), "jev", "both keys keep current behaviour");
  assert.equal(readProvider({}, { ANTHROPIC_API_KEY: "a" }), "claude");
  assert.equal(readProvider({}, { TYPESAFE_API_KEY: "t", SOLUMBE_READ_PROVIDER: "Claude" }), "claude");
  assert.equal(readProvider({ provider: "jev" }, { SOLUMBE_READ_PROVIDER: "claude" }), "jev", "an explicit option beats the environment");
  assert.equal(readProvider({ apiKey: "t" }, { ANTHROPIC_API_KEY: "a" }), "jev");
  assert.throws(() => readProvider({}, { SOLUMBE_READ_PROVIDER: "gpt" }), /must be jev or claude/);
});

test("askRequestRead prices a Jev reply the way context-read always did", async () => {
  const reply = await askRequestRead(
    {},
    { files },
    {
      provider: "jev",
      apiKey: "t",
      fetchImpl: async () => /** @type {any} */ ({ ok: true, json: async () => ({ model: "jev-test", usage: { input_tokens: 1_000_000 }, answers: {} }) }),
    },
  );
  assert.equal(reply.source, "jev");
  assert.equal(reply.costUsd, 0.042);
});

test("context --online with the Claude provider applies the read and says where it came from", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-claude-read-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "claude-read-fixture" }));
  fs.writeFileSync(path.join(root, "src/orders.routes.js"), "export function orderRoutes() {}\n");
  fs.writeFileSync(path.join(root, "src/orders.repository.js"), "export class OrderRepository {}\n");
  const pack = generateContextPack("check the order routes against the order repository", { path: root });
  assert.equal(pack.data.intent.action, "unknown", "the question-shaped request solumbe cannot read alone");

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const fileEnum = body.tools[0].input_schema.properties.relevance.items.properties.file.enum;
    assert.equal(body.tools[0].input_schema.properties.capability, undefined, "context packs do not ask the capability");
    assert.equal(Object.keys(body.tools[0].input_schema.properties)[0], "reasoning", "context --online reasons first by default");
    return /** @type {any} */ ({
      ok: true,
      json: async () =>
        toolReply({ reasoning: thought, intent: "review", intent_confidence: 0.8, relevance: fileEnum.map((file) => ({ file, relevance: 0.9 })) }),
    });
  };
  const read = await readContextPack(pack, { provider: "claude", anthropicApiKey: "k", fetchImpl });
  assert.equal(read.data.modelRead.source, "claude");
  assert.equal(read.data.intent.action, "review");
  assert.equal(read.data.intent.source, "claude");
  assert.equal(read.data.intent.heuristicAction, "unknown");
  assert.match(read.markdown, /Anthropic Claude, forced tool use/);
  assert.ok(read.data.modelRead.intent.confidence >= CHOICE_FLOOR);
});

test("the read eval grades a provider on the corpus reads suite without a network", async () => {
  const heuristic = await runReadEval({ provider: "heuristic" });
  assert.equal(heuristic.data.scoreboard.errors, 0);
  const comparisons = heuristic.data.cases.filter((testCase) => /^read-(check|compare)-/.test(testCase.name));
  assert.ok(comparisons.length >= 3, "the corpus carries comparison requests");
  assert.ok(
    comparisons.every((testCase) => testCase.heuristic === "unknown"),
    "solumbe alone reads 'check X against Y' as unknown",
  );
  const questions = heuristic.data.cases.filter((testCase) => /^read-(where|how|why|which|is)-/.test(testCase.name) && testCase.heuristicCorrect);
  assert.ok(questions.length >= 8, "solumbe alone reads a question about the code as explain");

  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const relevance = body.tools[0].input_schema.properties.relevance;
    const fileEnum = relevance ? relevance.items.properties.file.enum : [];
    return /** @type {any} */ ({
      ok: true,
      json: async () =>
        toolReply({
          ...(body.tools[0].input_schema.properties.reasoning ? { reasoning: "A question about the code, so explain." } : {}),
          intent: "explain",
          intent_confidence: 0.9,
          capability: "repo_search",
          capability_confidence: 0.7,
          ...(relevance ? { relevance: fileEnum.map((file) => ({ file, relevance: 0.5 })) } : {}),
        }),
    });
  };
  const claude = await runReadEval({ provider: "claude", anthropicApiKey: "k", fetchImpl });
  const board = claude.data.scoreboard;
  assert.equal(calls, board.cases, "every read was accepted first time");
  assert.equal(board.errors, 0);
  assert.equal(board.intent.acceptedRate, 1);
  assert.ok(board.intent.brier !== null);
  assert.equal(board.intent.bands.find((band) => band.band === ">= 0.9")?.n, board.read);
  assert.match(claude.markdown, /# solumbe Read Eval/);
  assert.match(claude.markdown, /Provider: claude, reasoning field before the answers/);
  assert.equal(claude.data.reasoning, true, "the default");
  assert.ok(claude.data.cases.every((testCase) => testCase.reasoning === "A question about the code, so explain."));

  calls = 0;
  const plain = await runReadEval({ provider: "claude", anthropicApiKey: "k", reasoning: false, fetchImpl });
  assert.equal(calls, plain.data.scoreboard.cases);
  assert.equal(plain.data.scoreboard.errors, 0);
  assert.equal(plain.data.reasoning, false);
  assert.match(plain.markdown, /Provider: claude, answers only \(--no-reasoning\)/);
  assert.ok(plain.data.cases.every((testCase) => !Object.hasOwn(testCase, "reasoning")));
});

test("the read eval refuses the reasoning switch for a provider without one", async () => {
  await assert.rejects(runReadEval({ provider: "heuristic", reasoning: false }), /--no-reasoning applies to the claude provider only, not heuristic/);
  await assert.rejects(runReadEval({ provider: "jev", reasoning: false }), /claude provider only, not jev/);
  const heuristic = await runReadEval({ provider: "heuristic" });
  assert.equal(heuristic.data.reasoning, false, "nothing reasons without a Claude read");
  assert.match(heuristic.markdown, /^Provider: heuristic$/m);
});

test("aggregateReads reports no rate over no cases rather than a zero", () => {
  const board = aggregateReads([]);
  assert.equal(board.intent.accuracy, null);
  assert.equal(board.intent.brier, null);
  assert.equal(board.cost.totalUsd, null);
});
