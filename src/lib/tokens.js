const charsPerToken = 4;

/**
 * @param {unknown} value
 * @returns {number}
 */
export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / charsPerToken);
}

/**
 * @param {{ name: string, value: unknown }[]} sections
 */
export function estimateTokenSections(sections) {
  const items = sections.map((section) => ({
    name: section.name,
    tokens: estimateTokens(section.value),
    characters: textLength(section.value),
  }));

  return {
    estimated: true,
    method: `ceil(characters / ${charsPerToken})`,
    total: items.reduce((sum, item) => sum + item.tokens, 0),
    sections: items,
  };
}

// What a token of each kind costs, as a multiple of an uncached input token,
// in Anthropic's price list for every current Claude model: a cache read is a
// tenth, a cache write is 1.25 times for the 5-minute TTL and twice for the
// 1-hour one, and output is five times. Ratios rather than prices, so a price
// change moves no result unless it changes a ratio.
const BILLED_WEIGHT = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 };

/**
 * The billed tokens of one model response, from the `usage` object the API
 * returns (and a Claude Code transcript keeps), weighted into input-token
 * equivalents. A cache write that does not say its TTL counts as 5-minute.
 * @param {any} usage
 */
export function billedTokens(usage) {
  const count = (/** @type {unknown} */ value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const cacheWrite = count(usage?.cache_creation_input_tokens);
  const cacheWrite1h = Math.min(cacheWrite, count(usage?.cache_creation?.ephemeral_1h_input_tokens));
  const tokens = {
    input: count(usage?.input_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite5m: cacheWrite - cacheWrite1h,
    cacheWrite1h,
    output: count(usage?.output_tokens),
  };
  const weighted = Object.entries(tokens).reduce((sum, [kind, n]) => sum + n * BILLED_WEIGHT[/** @type {keyof typeof BILLED_WEIGHT} */ (kind)], 0);
  return { ...tokens, weighted: Math.round(weighted) };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function textLength(value) {
  return (typeof value === "string" ? value : JSON.stringify(value ?? "")).length;
}
