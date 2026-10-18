// A Claude provider for the request read, and the choice between it and Jev.
//
// jev.js asks TypeSafe's Jev the read questions as typed System One questions.
// This asks Claude the same three things through one tool whose input schema
// is the answer: `intent` and `capability` are enums over INTENTS and
// CAPABILITIES, each with a stated confidence, and `relevance` scores every
// candidate file by name. The tool is forced with `tool_choice`, so the reply
// is a tool call or an error, never prose to parse.
//
// A reply that fails validation (a confidence outside 0..1, a file scored
// twice or not at all) goes back to the model as an `is_error` tool result,
// once. Whatever comes back after that is mapped into Jev's answer shape and
// handed to interpretRead, which stays the backstop: an unknown choice reads
// as null, a missing confidence is never accepted, and CHOICE_FLOOR and
// DEMOTE_BELOW gate what a caller applies.
//
// Claude's confidence is the model's own statement, not a probability trained
// against outcomes the way Jev's is. Whether it is calibrated is measured, not
// assumed: `solumbe eval --reads` grades both on the same corpus
// (docs/17-calibration-thesis).

import { askSystemOne, CAPABILITIES, INTENTS, JEV_USER_AGENT, MAX_RELEVANCE_FILES, priceJevCall, readQuestions } from "./jev.js";

export const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_API_VERSION = "2023-06-01";
/**
 * Haiku 5.5: a short classification wants the fast, cheap tier, and forced
 * `tool_choice` is refused (400) by Opus 5.5, Sonnet 5.5 and Fable 5.1.
 */
export const CLAUDE_READ_MODEL = "claude-haiku-5-5";
export const CLAUDE_READ_TOOL = "record_request_read";
export const CLAUDE_TIMEOUT_MS = 15_000;
const CLAUDE_MAX_TOKENS = 2048;

/** USD per million tokens, [input, output], for prompts under 100K tokens. */
export const CLAUDE_PER_MTOK = /** @type {Record<string, [number, number]>} */ ({
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
});

/**
 * Cost of a read, in USD. Null when the model has no listed rate or a count is
 * missing, for the same reason priceJevCall answers null: not measured is not
 * free.
 * @param {string} model
 * @param {number|null} inputTokens
 * @param {number|null} outputTokens
 * @returns {number|null}
 */
export function priceClaudeCall(model, inputTokens, outputTokens) {
  const rate = Object.hasOwn(CLAUDE_PER_MTOK, model) ? CLAUDE_PER_MTOK[model] : null;
  if (!rate || typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return null;
  return Number(((inputTokens * rate[0] + outputTokens * rate[1]) / 1e6).toFixed(6));
}

/**
 * @typedef {import("./jev.js").ReadFile} ReadFile
 * @typedef {{ files?: ReadFile[], intent?: boolean, capability?: boolean }} ReadAsk
 * @typedef {Omit<import("./jev.js").SystemOneReply, "source"> & { source: "jev"|"claude", costUsd: number|null, attempts?: number, validationErrors?: string[] }} ReadReply
 */

/**
 * The one tool whose input is the read. Only the asked-for parts are in it, so
 * a read without files has no relevance array to fill.
 * @param {{ labels: string[], intent: boolean, capability: boolean }} ask
 */
export function readTool({ labels, intent, capability }) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  const confidence = (/** @type {string} */ what) => ({
    type: "number",
    description: `How sure you are of the ${what}, from 0 to 1: 0.9 means you would expect to be right nine times in ten.`,
  });
  if (intent) {
    properties.intent = { type: "string", enum: Object.keys(INTENTS), description: `What kind of work the request asks for.\n${describe(INTENTS)}` };
    properties.intent_confidence = confidence("intent");
  }
  if (capability) {
    properties.capability = {
      type: "string",
      enum: Object.keys(CAPABILITIES),
      description: `Which one of these repository tools most directly answers the request.\n${describe(CAPABILITIES)}`,
    };
    properties.capability_confidence = confidence("capability");
  }
  if (labels.length > 0) {
    properties.relevance = {
      type: "array",
      description:
        "One entry for every candidate file, each exactly once. relevance is the probability, 0 to 1, that a developer doing this work would open the file: " +
        "high when it owns, defines, tests or configures what the request is about; low when it only shares a word, a domain or a directory with the request.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { file: { type: "string", enum: labels }, relevance: { type: "number" } },
        required: ["file", "relevance"],
      },
    };
  }
  return {
    name: CLAUDE_READ_TOOL,
    description: "Record how you read a request to change or understand a code repository.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
  };
}

/**
 * What the schema cannot say: ranges, and every file scored exactly once.
 * Enums are checked again because a proxy or a model without strict tool use
 * may not enforce them.
 * @param {any} input
 * @param {{ labels: string[], intent: boolean, capability: boolean }} ask
 * @returns {string[]}
 */
export function validateReadInput(input, { labels, intent, capability }) {
  /** @type {string[]} */
  const errors = [];
  if (!input || typeof input !== "object") return ["the tool input must be an object"];
  const unit = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (intent) {
    if (!Object.hasOwn(INTENTS, input.intent)) errors.push(`intent must be one of ${Object.keys(INTENTS).join(", ")}`);
    if (!unit(input.intent_confidence)) errors.push("intent_confidence must be a number from 0 to 1");
  }
  if (capability) {
    if (!Object.hasOwn(CAPABILITIES, input.capability)) errors.push(`capability must be one of ${Object.keys(CAPABILITIES).join(", ")}`);
    if (!unit(input.capability_confidence)) errors.push("capability_confidence must be a number from 0 to 1");
  }
  if (labels.length > 0) {
    if (!Array.isArray(input.relevance)) {
      errors.push("relevance must be an array with one entry per candidate file");
    } else {
      /** @type {Map<string, number>} */
      const seen = new Map();
      for (const entry of input.relevance) {
        if (!labels.includes(entry?.file)) errors.push(`relevance names a file that is not a candidate: ${JSON.stringify(entry?.file)}`);
        else seen.set(entry.file, (seen.get(entry.file) ?? 0) + 1);
        if (!unit(entry?.relevance)) errors.push(`relevance for ${JSON.stringify(entry?.file)} must be a number from 0 to 1`);
      }
      for (const label of labels) {
        const count = seen.get(label) ?? 0;
        if (count === 0) errors.push(`relevance is missing ${label}`);
        else if (count > 1) errors.push(`relevance scores ${label} ${count} times; score it once`);
      }
    }
  }
  return errors;
}

/**
 * Map a tool input into the answers Jev would have returned, so interpretRead
 * reads both providers the same way. A value outside its range is left out
 * rather than clamped: interpretRead then reads it as null, never as a guess.
 * @param {any} input
 * @param {ReadFile[]} files
 * @returns {Record<string, any>}
 */
export function claudeAnswers(input, files) {
  /** @type {Record<string, any>} */
  const answers = {};
  const unit = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined);
  const choice = (/** @type {unknown} */ picked, /** @type {unknown} */ stated) => {
    const confidence = unit(stated);
    return {
      type: "choice",
      choice: picked,
      confidence,
      probabilities: typeof picked === "string" && confidence !== undefined ? { [picked]: confidence } : {},
    };
  };
  if (input?.intent !== undefined) answers.read_intent = choice(input.intent, input.intent_confidence);
  if (input?.capability !== undefined) answers.read_capability = choice(input.capability, input.capability_confidence);
  /** @type {Map<string, number>} */
  const byLabel = new Map();
  for (const entry of Array.isArray(input?.relevance) ? input.relevance : []) {
    const value = unit(entry?.relevance);
    // First answer wins; a file scored twice was already reported as an error.
    if (typeof entry?.file === "string" && value !== undefined && !byLabel.has(entry.file)) byLabel.set(entry.file, value);
  }
  files.slice(0, MAX_RELEVANCE_FILES).forEach((file, index) => {
    const value = byLabel.get(file.label ?? file.path);
    if (value !== undefined) answers[`read_file_${index}`] = { type: "noul", noul: value };
  });
  return answers;
}

const SYSTEM_PROMPT =
  "You read requests that a developer gives a coding agent working in a code repository, and record your reading with the record_request_read tool. " +
  "The state names the repositories and the candidate files a deterministic ranker found, with why each was ranked. " +
  "Judge the request as written: a question that asks to check, compare or assess something, with no edit asked for, is not a request to change it. " +
  "State confidences you would stand behind; do not round them up.";

/**
 * Ask Claude for the read of one request, in one call plus at most one retry.
 * @param {unknown} state
 * @param {ReadAsk} ask
 * @param {{ apiKey?: string, anthropicApiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number, model?: string, apiUrl?: string }} [options]
 * @returns {Promise<ReadReply>}
 */
export async function askClaudeRead(state, { files = [], intent = true, capability = true } = {}, options = {}) {
  const apiKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const model = options.model ?? process.env.SOLUMBE_CLAUDE_READ_MODEL ?? CLAUDE_READ_MODEL;
  const asked = files.slice(0, MAX_RELEVANCE_FILES);
  const labels = [...new Set(asked.map((file) => file.label ?? file.path))];
  const shape = { labels, intent, capability };
  const tool = readTool(shape);

  /** @type {any[]} */
  const messages = [{ role: "user", content: `Read this request.\n\n${JSON.stringify(state, null, 2)}` }];
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  /** @type {any} */
  let input;
  /** @type {string[]} */
  let errors = [];
  let attempts = 0;
  let replyModel = model;

  while (attempts < 2) {
    attempts += 1;
    const started = Date.now();
    const response = await doFetch(options.apiUrl ?? CLAUDE_API_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VERSION, "content-type": "application/json", "user-agent": JEV_USER_AGENT },
      body: JSON.stringify({
        model,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [tool],
        tool_choice: { type: "tool", name: CLAUDE_READ_TOOL },
        messages,
      }),
      signal: globalThis.AbortSignal.timeout(options.timeoutMs ?? CLAUDE_TIMEOUT_MS),
    });
    latencyMs += Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = /** @type {any} */ (await response.json());
    replyModel = payload.model ?? model;
    if (typeof payload.usage?.input_tokens === "number") inputTokens += payload.usage.input_tokens;
    if (typeof payload.usage?.output_tokens === "number") outputTokens += payload.usage.output_tokens;
    if (payload.stop_reason === "refusal") throw new Error("Claude declined the read (stop_reason refusal)");

    const call = (payload.content ?? []).find((/** @type {any} */ block) => block?.type === "tool_use" && block.name === CLAUDE_READ_TOOL);
    if (!call) {
      // Nothing to answer with a tool_result; a forced call that never came
      // (max_tokens, say) is retried as the same request.
      input = undefined;
      errors = [`no ${CLAUDE_READ_TOOL} call in the reply (stop_reason ${payload.stop_reason ?? "unknown"})`];
      continue;
    }
    input = call.input;
    errors = validateReadInput(input, shape);
    if (errors.length === 0) break;
    messages.push(
      { role: "assistant", content: payload.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: `The read was not recorded:\n- ${errors.join("\n- ")}\nCall ${CLAUDE_READ_TOOL} again with every problem fixed.`,
          },
        ],
      },
    );
  }

  return {
    source: "claude",
    model: replyModel,
    tokens: inputTokens + outputTokens,
    billableTokens: inputTokens,
    tokenKind: "total",
    latencyMs,
    answers: claudeAnswers(input, asked),
    costUsd: priceClaudeCall(replyModel, inputTokens, outputTokens),
    attempts,
    validationErrors: errors,
  };
}

/**
 * Which provider reads requests. SOLUMBE_READ_PROVIDER names one outright;
 * otherwise a TypeSafe key keeps today's Jev read, and an Anthropic key alone
 * selects Claude. With neither, Jev is chosen so the fallback reason stays the
 * one callers already see ("TYPESAFE_API_KEY is not set").
 * @param {{ provider?: string, apiKey?: string, anthropicApiKey?: string }} [options]
 * @param {Record<string, string|undefined>} [env]
 * @returns {"jev"|"claude"}
 */
export function readProvider(options = {}, env = process.env) {
  const named = String(options.provider ?? env.SOLUMBE_READ_PROVIDER ?? "")
    .trim()
    .toLowerCase();
  if (named === "jev" || named === "claude") return named;
  if (named) throw new Error(`SOLUMBE_READ_PROVIDER must be jev or claude, not ${JSON.stringify(named)}`);
  if (options.apiKey || env.TYPESAFE_API_KEY) return "jev";
  if (options.anthropicApiKey || env.ANTHROPIC_API_KEY) return "claude";
  return "jev";
}

/**
 * Ask the selected provider for the read. Both replies carry Jev-shaped
 * answers and a price, so the caller reads them with interpretRead alike.
 * @param {unknown} state
 * @param {ReadAsk} ask
 * @param {{ provider?: string, apiKey?: string, anthropicApiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number, model?: string }} [options]
 * @returns {Promise<ReadReply>}
 */
export async function askRequestRead(state, ask, options = {}) {
  if (readProvider(options) === "claude") return askClaudeRead(state, ask, options);
  const reply = await askSystemOne(state, readQuestions(ask), options);
  return { ...reply, costUsd: priceJevCall(reply.billableTokens) };
}

/** @param {Record<string, string>} options */
const describe = (options) =>
  Object.entries(options)
    .map(([key, text]) => `- ${key}: ${text}`)
    .join("\n");
