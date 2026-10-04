/// <reference types="node" />
import path from "node:path";
import { isRunnableTestPath } from "./code-map/classify.js";
import { generateHarness } from "./harness.js";
import { getCachedCodeMap } from "./index-cache.js";
import { collapseLocaleSiblings, formatLocales, isCopyRequest, resolveNamedFiles, stripFileExtensions, TRANSLATION_DEMOTION } from "./ranking-rules.js";
import { getGitInfo } from "./repo.js";
import { estimateTokens, estimateTokenSections } from "./tokens.js";

/**
 * @typedef {import('./index-cache.js').CodeMap} CodeMap
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 * @typedef {import('./index-cache.js').CodeMapHttpMethod} CodeMapHttpMethod
 * @typedef {import('./index-cache.js').CodeMapSymbol} CodeMapSymbol
 */

/**
 * Parsed task intent derived from the query.
 * @typedef {object} Intent
 * @property {string} action
 * @property {string[]} topics
 */

/**
 * A file selected and scored by the context engine. `imports`/`exports`/`symbols`
 * are optional because stripEvidence may remove them from the returned packet.
 * @typedef {object} ScoredFile
 * @property {{ name: string, root: string }} repo
 * @property {string} path
 * @property {string} kind
 * @property {string} domain
 * @property {number} score
 * @property {string[]} reasons
 * @property {string|null} [route]
 * @property {string|null} [controllerBasePath]
 * @property {CodeMapHttpMethod[]} httpMethods
 * @property {string[]} [imports]
 * @property {string[]} [exports]
 * @property {CodeMapSymbol[]} [symbols]
 * @property {Array<{ type: string, name: string, line?: number, matchedTokens: string[], score: number }>} [matchedSymbols]
 * @property {boolean} [hasPhraseMatch] - true when an exact multi-word query phrase (e.g. "date of birth") was found in this file's own text.
 * @property {string[]} [siblings] - locale files of the same translation catalog this entry stands for.
 */

/**
 * What the request says outright, keyed by `${repo.root}:${path}`: the files
 * it names (`pinned`), the other definitions of a symbol it names
 * (`definers`), the identifier-shaped words themselves (`symbols`), and
 * whether it is about copy, the one request a translation catalog can own.
 * @typedef {object} RequestRules
 * @property {boolean} wantsCopy
 * @property {Map<string, import('./ranking-rules.js').NamedFile & { order: number }>} pinned
 * @property {Map<string, import('./ranking-rules.js').NamedFile>} definers
 * @property {Set<string>} symbols
 * @property {Set<string>} repoHints - repo.root values the request names directly (only populated across 2+ repos).
 */

/**
 * Per-repo import adjacency built from code-map file imports.
 * @typedef {object} ImportGraph
 * @property {Map<string, Set<string>>} importsByPath
 * @property {Map<string, Set<string>>} importedByPath
 */

/**
 * A validation/refresh command surfaced in a context pack.
 * @typedef {object} EngineCommand
 * @property {string} command
 * @property {string} reason
 * @property {string} [repo]
 * @property {string} [script]
 */

/**
 * Options accepted by generateContextPack.
 * @typedef {object} ContextPackOptions
 * @property {number} [limit]
 * @property {boolean} [includeEvidence]
 * @property {string[]} [paths]
 * @property {string} [path]
 */

// 4: a file the request names leads Primary Files, a translation catalog is
// demoted unless the request is about copy and its locale files share one
// entry (`siblings`), a named file's extension no longer scores, and Tests
// lists only files a test runner executes.
const contextEngineVersion = 4;
const defaultLimit = 8;
// A definition of a symbol the request names that is not the one the code
// imports (that one is pinned): a local copy, an export nothing uses.
const NAMED_DEFINER_BONUS = 60;
// How far a named file sits above the best candidate the request did not name.
const PIN_MARGIN = { path: 20, symbol: 10 };
// Enough to put the definition of a named symbol ahead of every hotspot that
// only shares words with the request.
const NAMED_HOTSPOT_BONUS = 200;
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "let",
  "me",
  "new",
  "of",
  "on",
  "or",
  "the",
  "to",
  "we",
  "what",
  "where",
  "which",
  "who",
  "with",
  "app",
  "mobile",
  "show",
]);

/** Raised when no action word names the work; a model read that settles the intent withdraws it. */
export const AMBIGUOUS_ACTION_QUESTION = "The requested action is ambiguous; clarify whether this is implementation, review, debugging, or exploration.";

const actionWords = new Set(["add", "build", "change", "create", "debug", "fix", "implement", "refactor", "review", "test", "update"]);
// A request framed around symptoms ("scanning and date bugs", "the app is
// broken", "crashes on submit") names no verb from actionWords at all, but it
// is unmistakably a debugging task. Recorded gap: "ticket scanning (QR
// check-in) and date/time display formatting bugs in the mobile app" came
// back with intent "unknown" and the ambiguous-action open question even
// though "bugs" is as clear a signal as "debug".
const debugSynonyms = new Set(["bug", "bugs", "bugfix", "broken", "crash", "crashes", "crashing", "regression", "regressions"]);
const importExtensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * @param {string} query
 * @param {ContextPackOptions} [options]
 */
export function generateContextPack(query, options = {}) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery) {
    throw new Error("context requires a non-empty query");
  }

  const limit = normalizeLimit(options.limit, defaultLimit, 50);
  const includeEvidence = Boolean(options.includeEvidence);
  const repoPaths = normalizePaths(options.paths ?? [options.path ?? "."]);
  // The cached map's git state is whatever the tree looked like at index time;
  // a commit leaves the index fingerprint unchanged, so read the tree live.
  const maps = repoPaths.map((repoPath) => {
    const map = getCachedCodeMap(repoPath);
    return { ...map, repo: { ...map.repo, git: getGitInfo(map.repo.root) } };
  });
  const graphs = new Map(maps.map((map) => [map.repo.root, buildImportGraph(map.files)]));
  // The words of a named file score; its extension, shared by every file of
  // that language, does not.
  const termsQuery = stripFileExtensions(normalizedQuery);
  const tokens = tokenize(termsQuery);
  const phrases = extractPhrases(termsQuery);
  const intent = inferIntent(tokens);
  const tokenStats = computeTokenDocFrequency(maps, tokens);
  const rules = requestRules(maps, normalizedQuery, tokens, limit);
  const scoredFiles = scoreMaps(maps, tokens, intent, phrases, tokenStats, rules);
  const matchedPrimaryFiles = selectPrimaryFiles(scoredFiles, limit, rules);
  const usedFallback = matchedPrimaryFiles.length === 0;
  const primaryFiles = stripEvidence(usedFallback ? selectFallbackPrimaryFiles(maps, limit) : matchedPrimaryFiles, includeEvidence);
  const relatedFiles = stripEvidence(selectRelatedFiles(maps, graphs, scoredFiles, primaryFiles, limit), includeEvidence);
  noteLocaleSiblings([...primaryFiles, ...relatedFiles]);
  const tests = stripEvidence(selectTests(maps, graphs, scoredFiles, primaryFiles, limit), includeEvidence);
  const hotspots = buildHotspots(scoredFiles, primaryFiles, relatedFiles, tokens, tokenStats, rules);
  const commands = inferCommands(repoPaths, normalizedQuery);
  const conflicts = inferConflicts(maps);
  const openQuestions = inferOpenQuestions(primaryFiles, commands, intent, usedFallback, hotspots);
  const sources = inferSources(maps, commands);

  const data = /** @type {Record<string, any> & { tokenEstimate?: any }} */ ({
    ok: true,
    generatedAt: new Date().toISOString(),
    contextEngineVersion,
    query: normalizedQuery,
    intent,
    repos: maps.map(summarizeRepo),
    hotspots,
    primaryFiles,
    relatedFiles,
    tests,
    commands,
    conflicts,
    openQuestions,
    sources,
  });

  return finalizeContextPack(data);
}

/**
 * Recompute what a pack derives from its file lists: the token estimate and
 * the markdown. For a caller that changed those lists after
 * generation, such as the opt-in model read in context-read.js.
 * @param {Record<string, any>} data
 */
export function rebuildContextPack(data) {
  return finalizeContextPack(data);
}

/**
 * @param {Record<string, any> & { tokenEstimate?: any }} data
 */
function finalizeContextPack(data) {
  data.tokenEstimate = {
    ...estimateTokenSections([
      { name: "intent", value: data.intent },
      { name: "repos", value: data.repos },
      { name: "hotspots", value: data.hotspots },
      { name: "primaryFiles", value: data.primaryFiles },
      { name: "relatedFiles", value: data.relatedFiles },
      { name: "tests", value: data.tests },
      { name: "commands", value: data.commands },
    ]),
  };
  data.tokenEstimate.fullJson = estimateTokens(data);

  let markdown = formatContextPackMarkdown(data);
  data.tokenEstimate.markdown = estimateTokens(markdown);
  markdown = formatContextPackMarkdown(data);

  return {
    data,
    markdown,
  };
}

/**
 * @param {Record<string, any>} data - The context pack data object built by generateContextPack.
 */
export function formatContextPackMarkdown(data) {
  const lines = [
    `# Context Pack: ${data.query}`,
    "",
    `Generated: ${data.generatedAt}`,
    `Context engine version: ${data.contextEngineVersion}`,
    `Intent: ${data.intent.action}${data.intent.topics.length ? ` (${data.intent.topics.join(", ")})` : ""}`,
    `Estimated JSON tokens: ${data.tokenEstimate.fullJson}`,
    `Estimated Markdown tokens: ${data.tokenEstimate.markdown ?? "pending"}`,
    "",
    ...formatModelRead(data.modelRead),
    "## Repositories",
    "",
    ...data.repos.map(
      (/** @type {{ name: string, root: string, sourceFileCount: number }} */ repo) => `- ${repo.name}: ${repo.root} (${repo.sourceFileCount} source file(s))`,
    ),
    "",
    "## Hotspots",
    "",
    ...formatHotspots(data.hotspots),
    "",
    "## Primary Files",
    "",
    ...formatFiles(data.primaryFiles, "No primary files matched the query."),
    "",
    "## Related Files",
    "",
    ...formatFiles(data.relatedFiles, "No related files selected."),
    "",
    "## Tests",
    "",
    ...formatFiles(data.tests, "No matching tests found."),
    "",
    "## Commands",
    "",
    ...(data.commands.length ? data.commands.map((/** @type {EngineCommand} */ item) => `- \`${item.command}\`: ${item.reason}`) : ["- none inferred"]),
    "",
    "## Conflicts",
    "",
    ...(data.conflicts.length ? data.conflicts.map((/** @type {string} */ item) => `- ${item}`) : ["- none detected"]),
    "",
    "## Open Questions",
    "",
    ...(data.openQuestions.length ? data.openQuestions.map((/** @type {string} */ item) => `- ${item}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

/**
 * The model-read section, present only when a caller asked for one. A pack
 * that never asked renders exactly as before.
 * @param {any} read
 * @returns {string[]}
 */
function formatModelRead(read) {
  if (!read) return [];
  if (read.source !== "jev") {
    return ["## Model Read", "", `- Not applied: ${read.fallbackReason ?? "no model call was made"}. The ranking below is solumbe's alone.`, ""];
  }
  const cost = typeof read.costUsd === "number" ? `, $${read.costUsd.toFixed(6)}` : "";
  const lines = ["## Model Read", "", `- Source: ${read.model} (TypeSafe System One), ${read.latencyMs} ms${cost}. Advisory; never read by a gate.`];
  if (read.intent) {
    lines.push(
      read.intent.accepted
        ? `- Intent: ${read.intent.choice} (confidence ${read.intent.confidence}; solumbe's own reading was ${read.intent.heuristic})`
        : `- Intent: ${read.intent.choice} at confidence ${read.intent.confidence}, under the floor; kept solumbe's reading (${read.intent.heuristic})`,
    );
  }
  if (read.demoted?.length) {
    lines.push(
      `- Demoted ${read.demoted.length} file(s) the model judged irrelevant: ${read.demoted
        .map((/** @type {{ path: string, relevance: number }} */ file) => `\`${file.path}\` (${file.relevance})`)
        .join(", ")}`,
    );
  }
  if (read.notApplied) lines.push(`- ${read.notApplied}`);
  lines.push("");
  return lines;
}

/**
 * Render the full context pack for an interactive terminal. Markdown remains
 * the durable artifact format; this presentation uses the shared renderer so
 * a long report stays easy to scan in a real terminal.
 *
 * @param {Record<string, any>} data
 * @param {(options: Record<string, unknown>) => ReturnType<typeof import("./render/fancy.js").createRenderer>} rendererFactory
 * @returns {string}
 */
export function formatContextPackTerminal(data, rendererFactory) {
  const renderer = rendererFactory({});
  // A section's own emoji, shown only by the emoji set; ascii keeps its ">".
  const decor = (/** @type {string} */ emoji) => renderer.pick({ emoji: `${emoji} `, ascii: "> ", unicode: "" });
  /** @type {string[]} */
  const lines = [];
  const repoCount = data.repos.length;
  const sourceCount = data.repos.reduce((/** @type {number} */ sum, /** @type {{ sourceFileCount?: number }} */ repo) => sum + (repo.sourceFileCount ?? 0), 0);

  lines.push(
    renderer.header({ text: "solumbe context · repository guide", glyph: "🧭" }, [
      { text: `"${data.query}"`, glyph: "💬" },
      { text: `${repoCount} repo${repoCount === 1 ? "" : "s"} · ${sourceCount} source file(s)`, glyph: "📂" },
      { text: `${data.primaryFiles.length} primary · ${data.hotspots.length} hotspots · ${data.tests.length} tests`, glyph: "🎯" },
    ]),
  );
  lines.push("");

  const modelRead = formatModelRead(data.modelRead).filter((line) => line.startsWith("- "));
  if (modelRead.length) {
    lines.push(
      renderer.section(
        `${decor("🤖")}Model read`,
        modelRead.map((line) => renderer.bullet(line.slice(2))),
      ),
    );
    lines.push("");
  }

  if (data.hotspots.length) {
    lines.push(
      renderer.section(
        `${decor("🔥")}Start here`,
        data.hotspots.slice(0, 8).map((/** @type {any} */ hotspot, /** @type {number} */ index) => {
          const location = `${hotspot.path}${hotspot.line ? `:${hotspot.line}` : ""}`;
          return `${rankLabel(index, renderer)} ${location}  ${hotspot.type} ${hotspot.symbol}  ${formatMatch(hotspot.matchedTokens)}`;
        }),
      ),
    );
  } else {
    lines.push(renderer.tip("No precise symbol hotspots yet. Start with the primary files, then refine the query with a route or method name."));
  }

  appendFileSection(lines, renderer, `${decor("🥇")}Primary files`, data.primaryFiles, "No primary files matched the query.", true);
  appendFileSection(lines, renderer, `${decor("🔗")}Related files`, data.relatedFiles, "No related files selected.", false);
  appendFileSection(lines, renderer, `${decor("🧪")}Tests`, data.tests, "No matching tests found.", false);

  lines.push("");
  lines.push(
    renderer.section(
      `${decor("▶️")}Commands`,
      data.commands.length
        ? data.commands.map(
            (/** @type {EngineCommand} */ command) => `${renderer.paint(renderer.glyphs.item, "dim")} ${command.command}\n    ${command.reason}`,
          )
        : [renderer.bullet("none inferred")],
    ),
  );

  if (data.conflicts.length) {
    lines.push("");
    lines.push(renderer.statusLine("warn", "Working tree", data.conflicts[0], data.conflicts.slice(1)));
  }
  if (data.openQuestions.length) {
    lines.push("");
    lines.push(
      renderer.section(
        `${decor("❓")}Check before changing`,
        data.openQuestions.map((/** @type {string} */ question) => renderer.bullet(question)),
      ),
    );
  }

  lines.push("");
  lines.push(
    renderer.tip(`Context engine v${data.contextEngineVersion} · ${data.tokenEstimate.fullJson} JSON tokens · ${data.tokenEstimate.markdown} markdown tokens`),
  );
  return lines.join("\n");
}

/**
 * @param {string[]} lines
 * @param {ReturnType<import("./render/fancy.js").createRenderer>} renderer
 * @param {string} title
 * @param {ScoredFile[]} files
 * @param {string} fallback
 * @param {boolean} [ranked]
 */
function appendFileSection(lines, renderer, title, files, fallback, ranked = false) {
  lines.push("");
  lines.push(
    renderer.section(
      title,
      files.length
        ? files.map((file, index) => {
            const rank = ranked ? `${rankLabel(index, renderer)} ` : "";
            const method = file.httpMethods?.[0];
            const route = method ? ` · ${method.method} ${method.path}` : "";
            const reasons = file.reasons.length ? `\n    ${renderer.glyphs.box.arrow} ${file.reasons.join(" · ")}` : "";
            return `${rank}${file.path}  ${file.kind}/${file.domain} · score ${file.score}${route}${reasons}`;
          })
        : [renderer.bullet(fallback)],
    ),
  );
}

/**
 * A medal in the emoji set, a number everywhere else.
 * @param {number} index
 * @param {ReturnType<import("./render/fancy.js").createRenderer>} renderer
 */
function rankLabel(index, renderer) {
  return renderer.pick({ emoji: ["🥇", "🥈", "🥉"][index] ?? "🏅", ascii: `${index + 1}.` });
}

/**
 * @param {string[]|undefined} tokens
 */
function formatMatch(tokens) {
  return tokens?.length ? `matches ${tokens.join(", ")}` : "matched symbol";
}

/**
 * @param {CodeMap[]} maps
 * @param {string} query
 * @param {string[]} tokens
 * @param {number} limit
 * @returns {RequestRules}
 */
function requestRules(maps, query, tokens, limit) {
  /** @type {RequestRules} */
  const rules = { wantsCopy: isCopyRequest(tokens), pinned: new Map(), definers: new Map(), symbols: new Set(), repoHints: computeRepoHints(maps, query) };
  for (const map of maps) {
    const named = resolveNamedFiles(map.files ?? [], query, { limit });
    for (const entry of named.pinned) rules.pinned.set(`${map.repo.root}:${entry.path}`, { ...entry, order: rules.pinned.size });
    for (const entry of named.definers) rules.definers.set(`${map.repo.root}:${entry.path}`, entry);
    for (const symbol of named.symbols) rules.symbols.add(symbol);
  }
  return rules;
}

/** @type {RequestRules} */
const noRequestRules = { wantsCopy: false, pinned: new Map(), definers: new Map(), symbols: new Set(), repoHints: new Set() };

// Bonus/penalty applied when a multi-repo request names one repo by a word
// from its own folder name (e.g. "in the mobile app" naming
// bashbop-mobile-app) that does not name every queried repo. "mobile" and
// "app" are ordinary stopWords for content scoring — too generic to match
// file text with — but here they are matched against repo folder names
// directly, on the raw query, so the one clear repo-scoping signal a
// multi-repo request gives isn't silently discarded. Recorded gap: a query
// mentioning "the mobile app" against `paths: [mobile, api]` came back with
// primary files almost entirely from the (larger) API repo.
const REPO_HINT_BONUS = 40;
const REPO_UNHINTED_FACTOR = 0.6;
const minRepoSegmentLength = 3;

/**
 * Repo folder-name segments the raw query names directly, restricted to
 * segments that do not name every queried repo (a segment every repo shares,
 * e.g. a shared "bashbop-" prefix, carries no scoping information).
 * Meaningless (and left empty) for a single-repo request.
 * @param {CodeMap[]} maps
 * @param {string} query
 * @returns {Set<string>} repo.root values the query names
 */
function computeRepoHints(maps, query) {
  /** @type {Set<string>} */
  const hinted = new Set();
  if (maps.length < 2) return hinted;

  const rawWords = new Set(
    String(query)
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [],
  );
  const perRepoSegments = maps.map((map) => ({
    root: map.repo.root,
    segments: new Set(
      path.posix
        .basename(normalizeRepoPath(map.repo.root))
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  }));
  /** @type {Set<string>} */
  const commonSegments = new Set(perRepoSegments[0]?.segments ?? []);
  for (const entry of perRepoSegments.slice(1)) {
    for (const segment of [...commonSegments]) {
      if (!entry.segments.has(segment)) commonSegments.delete(segment);
    }
  }

  for (const entry of perRepoSegments) {
    for (const segment of entry.segments) {
      if (segment.length < minRepoSegmentLength || commonSegments.has(segment)) continue;
      if (rawWords.has(segment)) {
        hinted.add(entry.root);
        break;
      }
    }
  }
  // A hint naming every repo is not discriminating (nothing to prefer over
  // anything else).
  return hinted.size < maps.length ? hinted : new Set();
}

/**
 * @param {CodeMap[]} maps
 * @param {string[]} tokens
 * @param {Intent} intent
 * @param {PhraseCandidate[]} [phrases]
 * @param {TokenStats} [tokenStats]
 * @param {RequestRules} [rules]
 * @returns {ScoredFile[]}
 */
function scoreMaps(maps, tokens, intent, phrases = [], tokenStats, rules = noRequestRules) {
  /** @type {ScoredFile[]} */
  const scored = [];
  const stats = tokenStats ?? computeTokenDocFrequency(maps, tokens);
  for (const map of maps) {
    for (const file of map.files ?? []) {
      const candidate = scoreFile(map, file, tokens, intent, phrases, stats, rules);
      if (candidate.score > 0 || rules.pinned.has(fileKey(candidate))) {
        scored.push(candidate);
      }
    }
  }

  liftPinnedFiles(scored, rules.pinned);
  const pinOrder = (/** @type {ScoredFile} */ file) => rules.pinned.get(fileKey(file))?.order ?? Number.MAX_SAFE_INTEGER;
  scored.sort((a, b) => b.score - a.score || pinOrder(a) - pinOrder(b) || a.repo.name.localeCompare(b.repo.name) || a.path.localeCompare(b.path));
  return collapseLocaleSiblings(scored, describeScoredFile, (file) => rules.pinned.has(fileKey(file)));
}

/**
 * Put each named file above every candidate the request did not name, keeping
 * the named files in order among themselves. The recorded request named
 * `event-service.ts` and got 21 files back without it.
 * @param {ScoredFile[]} scored
 * @param {RequestRules["pinned"]} pinned
 */
function liftPinnedFiles(scored, pinned) {
  if (pinned.size === 0) return;
  let ceiling = 0;
  for (const file of scored) {
    if (!pinned.has(fileKey(file))) ceiling = Math.max(ceiling, file.score);
  }
  for (const file of scored) {
    const pin = pinned.get(fileKey(file));
    if (!pin) continue;
    file.score = Math.max(file.score, ceiling) + PIN_MARGIN[pin.rule];
    file.reasons.push(pin.rule === "path" ? "named in request" : `defines ${pin.literal}, named in request`);
  }
}

/** @param {ScoredFile} file */
function describeScoredFile(file) {
  return { path: file.path, kind: file.kind, scope: file.repo.root };
}

/**
 * Say which locale files an entry stands for, once the lists are final.
 * @param {ScoredFile[]} files
 */
function noteLocaleSiblings(files) {
  for (const file of files) {
    if (file.siblings?.length) file.reasons = [...file.reasons, `locale catalog, also ${formatLocales(file.siblings)}`];
  }
}

/**
 * @param {CodeMap} map
 * @param {CodeMapFile} file
 * @param {string[]} tokens
 * @param {Intent} intent
 * @param {PhraseCandidate[]} phrases
 * @param {TokenStats} tokenStats
 * @param {RequestRules} [rules]
 * @returns {ScoredFile}
 */
function scoreFile(map, file, tokens, intent, phrases = [], tokenStats, rules = noRequestRules) {
  /** @type {string[]} */
  const reasons = [];
  let score = 0;

  if (file.isVendor) {
    return summarizeFile(map, file, 0, []);
  }

  score += scoreField(file.path, tokens, 8, "path", reasons, tokenStats);
  score += scoreField(file.kind, tokens, 4, "kind", reasons, tokenStats);
  score += scoreField(file.domains?.length ? file.domains.join(" ") : file.domain, tokens, 5, "domain", reasons, tokenStats);
  score += scoreField(file.route, tokens, 7, "route", reasons, tokenStats);
  score += scoreField(file.controllerBasePath, tokens, 7, "controller", reasons, tokenStats);
  score += scoreField(map.repo.name, tokens, 3, "repo", reasons, tokenStats);
  score += scoreField(map.repo.package?.name, tokens, 3, "package", reasons, tokenStats);

  let httpScore = 0;
  for (const method of file.httpMethods ?? []) {
    httpScore += scoreField(`${method.method} ${method.path}`, tokens, 7, "http", reasons, tokenStats);
  }
  score += Math.min(httpScore, 56);
  score += scoreCollection(file.imports ?? [], tokens, 3, "import", reasons, 18, tokenStats);
  score += scoreCollection(file.exports ?? [], tokens, 8, "export", reasons, 32, tokenStats);
  score += scoreField((file.formFields ?? []).join(" "), tokens, 5, "form field", reasons, tokenStats);
  score += scoreField((file.navigationTargets ?? []).join(" "), tokens, 7, "navigation", reasons, tokenStats);
  score += scoreField((file.localIdentifiers ?? []).join(" "), tokens, 4, "local identifier", reasons, tokenStats);

  const symbolMatch = scoreSymbols(file.symbols ?? [], tokens, tokenStats);
  score += symbolMatch.score;
  reasons.push(...symbolMatch.reasons);

  if ((file.dataAccess?.length ?? 0) > 0) {
    score += Math.min(15, 3 + (file.dataAccess?.length ?? 0));
    reasons.push("data access");
  }

  score += scoreTopicDomain(file, intent, reasons);
  score += scoreConceptCoverage(file, tokens, reasons, tokenStats);

  const phraseScore = scorePhraseMatches(file, phrases, reasons);
  score += phraseScore;

  if (isTypeOnlyFile(file)) {
    score = Math.floor(score * 0.4);
    reasons.push("type reference");
  }

  if (file.kind === "test" && score > 0) {
    score = Math.max(1, Math.floor(score * 0.7));
    reasons.push("test");
  }

  // Every JSON key is a symbol, so a catalog of a few thousand keys reaches the
  // symbol cap on almost any request: two locales of one catalog were Primary
  // Files in all four recorded packs, one of them for "sync local main branch".
  // Both lead the reasons, which the packet trims to eight.
  if (file.kind === "translation" && !rules.wantsCopy && score > 0) {
    score = Math.max(1, Math.floor(score * TRANSLATION_DEMOTION));
    reasons.unshift("translation catalog, demoted");
  }

  const definer = rules.definers.get(`${map.repo.root}:${file.path}`);
  if (definer) {
    score += NAMED_DEFINER_BONUS;
    reasons.unshift(`defines ${definer.literal}`);
  }

  if (rules.repoHints.size > 0 && score > 0) {
    if (rules.repoHints.has(map.repo.root)) {
      score += REPO_HINT_BONUS;
      reasons.unshift("repo named in request");
    } else {
      score = Math.floor(score * REPO_UNHINTED_FACTOR);
      reasons.push("a different repo than the one named in the request");
    }
  }

  const summarized = summarizeFile(map, file, score, reasons);
  summarized.matchedSymbols = withNamedSymbols(symbolMatch.matches, file.symbols ?? [], tokens, rules.symbols);
  summarized.hasPhraseMatch = phraseScore > 0;
  return summarized;
}

/**
 * The matched symbols, plus any symbol the request names outright that word
 * overlap did not already rank, so its definition can lead the hotspots.
 * @param {NonNullable<ScoredFile["matchedSymbols"]>} matches
 * @param {CodeMapSymbol[]} symbols
 * @param {string[]} tokens
 * @param {Set<string>} named
 * @returns {NonNullable<ScoredFile["matchedSymbols"]>}
 */
function withNamedSymbols(matches, symbols, tokens, named) {
  if (named.size === 0) return matches;
  const missing = symbols
    .filter((symbol) => named.has(symbol.name) && !matches.some((match) => match.name === symbol.name && match.line === symbol.line))
    .map((symbol) => {
      const nameTokens = new Set(tokenize(symbol.name));
      return { type: symbol.type, name: symbol.name, line: symbol.line, matchedTokens: tokens.filter((token) => nameTokens.has(token)), score: 0 };
    });
  return missing.length ? [...missing, ...matches] : matches;
}

/**
 * A file whose domain is itself one of the query topics is a direct owner
 * candidate; implementation kinds get a little more than its tests or types.
 * @param {CodeMapFile} file
 * @param {Intent} intent
 * @param {string[]} reasons
 * @returns {number}
 */
function scoreTopicDomain(file, intent, reasons) {
  const domain = normalizeText(file.domain || "");
  if (!domain || !intent.topics.includes(domain)) return 0;
  reasons.push("topic domain");
  if (file.kind === "service" || file.kind === "source" || file.kind === "hook") {
    reasons.push("implementation surface");
    return 30;
  }
  return 18;
}

/**
 * Reward files that connect several distinct concepts from a plain-language
 * question, rather than only repeating a broad noun such as `event`.
 *
 * @param {CodeMapFile} file
 * @param {string[]} tokens
 * @param {string[]} reasons
 * @param {TokenStats} [tokenStats]
 */
function scoreConceptCoverage(file, tokens, reasons, tokenStats) {
  const text = normalizeText(
    `${file.path} ${file.kind} ${file.domain} ${file.route ?? ""} ${file.controllerBasePath ?? ""} ${file.exports?.join(" ")} ${symbolTerms(file.symbols)} ${file.formFields?.join(" ")} ${file.navigationTargets?.join(" ")} ${file.localIdentifiers?.join(" ")}`,
  );
  const textTokens = new Set(tokenize(text));
  const matched = tokens.filter((token) => tokenVariants(token).some((variant) => textTokens.has(variant)));
  if (matched.length < 3) {
    return 0;
  }
  // Weight each matched token by its rarity across the repo so a file that
  // only echoes a handful of high-frequency domain nouns (e.g. "date",
  // "booking" everywhere in an events app) doesn't earn a multi-concept
  // bonus it hasn't actually demonstrated.
  const weightSum = matched.reduce((sum, token) => sum + tokenWeightFactor(token, tokenStats), 0);
  if (weightSum < 3) {
    return 0;
  }
  reasons.push("multi-concept match");
  return Math.min(36, Math.round((weightSum - 2) * 12));
}

/**
 * Per-token document frequency across the indexed repo(s), used to weight
 * down generic domain nouns that recur in many unrelated files.
 * @typedef {object} TokenStats
 * @property {number} totalFiles
 * @property {Map<string, number>} docFreq
 */

/**
 * A multi-word span pulled from the raw query that looks like it could name a
 * compound identifier (e.g. "date of birth" -> `dateOfBirth` / `date_of_birth`).
 * @typedef {object} PhraseCandidate
 * @property {string} normalized - space-joined form, matching normalizeText's camelCase/snake_case splitting.
 * @property {string} contentOnly - the same phrase with connector words (of/to/in/for) dropped.
 * @property {number} weight
 */

const phraseConnectors = new Set(["of", "in", "to", "for", "on", "at", "with"]);
const maxPhraseContentWords = 4;

/**
 * Build a per-token document-frequency table across every indexed, non-vendor
 * file. Only used as an IDF-style dampener: a token that shows up in a large
 * share of the repo (e.g. "date" or "booking" in an events codebase) carries
 * far less evidentiary weight than one that appears in a handful of files.
 * Skipped (falls back to a neutral weight) on small repos/fixtures where
 * frequency alone isn't a meaningful signal.
 * @param {CodeMap[]} maps
 * @param {string[]} tokens
 * @returns {TokenStats}
 */
export function computeTokenDocFrequency(maps, tokens) {
  /** @type {Map<string, number>} */
  const docFreq = new Map();
  let totalFiles = 0;

  if (!tokens.length) {
    return { totalFiles, docFreq };
  }

  for (const map of maps) {
    for (const file of map.files ?? []) {
      if (file.isVendor) {
        continue;
      }
      totalFiles += 1;
      const text = normalizeText(
        `${file.path} ${file.kind} ${file.domains?.length ? file.domains.join(" ") : file.domain} ${file.route ?? ""} ${file.controllerBasePath ?? ""} ${file.exports?.join(" ") ?? ""} ${symbolTerms(file.symbols)} ${file.formFields?.join(" ") ?? ""} ${file.navigationTargets?.join(" ") ?? ""} ${file.localIdentifiers?.join(" ") ?? ""} ${file.imports?.join(" ") ?? ""}`,
      );
      const fileTokens = new Set(tokenize(text));
      for (const token of tokens) {
        if (tokenVariants(token).some((variant) => fileTokens.has(variant))) {
          docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
        }
      }
    }
  }

  return { totalFiles, docFreq };
}

/**
 * IDF-style multiplier for a single query token's contribution to a score.
 * Below a minimum repo size the signal is too noisy to trust, so every token
 * is treated as neutral (matching prior, pre-dampening behaviour exactly).
 * @param {string} token
 * @param {TokenStats} [tokenStats]
 * @returns {number}
 */
export function tokenWeightFactor(token, tokenStats) {
  if (!tokenStats || tokenStats.totalFiles < 12) {
    return 1;
  }
  const df = tokenStats.docFreq.get(token) ?? 0;
  if (df === 0) {
    return 1;
  }
  const ratio = df / tokenStats.totalFiles;
  if (ratio <= 0.02) return 1.4;
  if (ratio <= 0.06) return 1;
  if (ratio <= 0.15) return 0.55;
  return 0.2;
}

/**
 * Pull multi-word, identifier-shaped spans out of the raw query, e.g. "date
 * of birth" or "next of kin" — a single connector word (of/to/in/for/...) may
 * sit between two content words, mirroring how normalizeText() splits
 * `dateOfBirth` / `date_of_birth` back into space-separated words. Longer
 * spans (more content words) are recorded with a higher weight.
 * @param {string} query
 * @returns {PhraseCandidate[]}
 */
export function extractPhrases(query) {
  const rawWords =
    String(query)
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  /** @type {Map<string, PhraseCandidate>} */
  const phraseMap = new Map();

  for (let start = 0; start < rawWords.length; start++) {
    if (stopWords.has(rawWords[start]) || rawWords[start].length <= 1) {
      continue;
    }

    const words = [rawWords[start]];
    let contentCount = 1;
    let pendingConnector = /** @type {string|null} */ (null);

    for (let i = start + 1; i < rawWords.length && contentCount < maxPhraseContentWords; i++) {
      const word = rawWords[i];
      if (word.length <= 1) {
        break;
      }
      if (stopWords.has(word)) {
        if (pendingConnector !== null || !phraseConnectors.has(word)) {
          break;
        }
        pendingConnector = word;
        continue;
      }

      if (pendingConnector !== null) {
        words.push(pendingConnector);
        pendingConnector = null;
      }
      words.push(word);
      contentCount += 1;

      // A bare two-content-word span (no connector) is too weak a signal on
      // its own — two adjacent nouns in a natural-language question collide
      // with unrelated identifiers far too often (e.g. "campaign email"
      // matching a local `campaignEmailTemplate` that has nothing to do with
      // the query). Only treat a 2-content-word span as a phrase when a
      // preposition ties the words together (e.g. "date of birth"), which is
      // exactly the shape of a real compound identifier; anything looser
      // needs a third content word before it counts as identifier-shaped.
      const isPrepositionLinkedPair = contentCount === 2 && words.length === 3;
      if (contentCount >= 3 || isPrepositionLinkedPair) {
        const normalized = words.join(" ");
        const contentOnly = words.filter((w) => !phraseConnectors.has(w)).join(" ");
        const weight = Math.min(40 + (contentCount - 2) * 25, 110);
        const existing = phraseMap.get(normalized);
        if (!existing || existing.weight < weight) {
          phraseMap.set(normalized, { normalized, contentOnly, weight });
        }
      }
    }
  }

  return [...phraseMap.values()];
}

/**
 * Hybrid literal-match pass: rather than relying only on scattered
 * single-token overlap, check whether the file's own text (path, symbols,
 * exports, form fields, etc.) contains an exact multi-word phrase pulled
 * from the query, e.g. "date of birth". A hit here is a much stronger signal
 * than several files each sharing one generic word with the query, so it is
 * scored well above ordinary token overlap.
 * @param {CodeMapFile} file
 * @param {PhraseCandidate[]} phrases
 * @param {string[]} reasons
 * @returns {number}
 */
export function scorePhraseMatches(file, phrases, reasons) {
  if (!phrases.length) {
    return 0;
  }

  const text = normalizeText(
    `${file.path} ${file.kind} ${file.domain} ${file.route ?? ""} ${file.controllerBasePath ?? ""} ${file.exports?.join(" ")} ${symbolTerms(file.symbols)} ${file.formFields?.join(" ")} ${file.navigationTargets?.join(" ")} ${file.localIdentifiers?.join(" ")}`,
  );

  let score = 0;
  let matched = false;
  for (const phrase of phrases) {
    if (text.includes(phrase.normalized)) {
      score += phrase.weight;
      matched = true;
    } else if (phrase.contentOnly !== phrase.normalized && text.includes(phrase.contentOnly)) {
      score += Math.round(phrase.weight * 0.7);
      matched = true;
    }
  }

  if (matched) {
    reasons.push("exact phrase match");
  }
  return Math.min(score, 200);
}

/**
 * Declaration-only files are valuable supporting context, but dense barrels of
 * interfaces should not outrank the screen, controller, or service that owns
 * the behaviour requested in plain language.
 *
 * @param {CodeMapFile} file
 */
function isTypeOnlyFile(file) {
  const symbols = file.symbols ?? [];
  return symbols.length > 0 && symbols.every((symbol) => ["interface", "type", "enum"].includes(symbol.type));
}

/** @param {CodeMapFile["symbols"]|undefined} symbols */
function symbolTerms(symbols) {
  return (symbols ?? []).map((symbol) => `${symbol.name} ${symbol.terms?.join(" ") ?? ""}`).join(" ");
}

/**
 * Prefer multi-token method/symbol hits over flooding score from every weak
 * single-token symbol match in large Nest services.
 * @param {CodeMapSymbol[]} symbols
 * @param {string[]} tokens
 * @param {TokenStats} [tokenStats]
 * @returns {{ score: number, matches: Array<{ type: string, name: string, line?: number, matchedTokens: string[], score: number }>, reasons: string[] }}
 */
function scoreSymbols(symbols, tokens, tokenStats) {
  if (!symbols.length || !tokens.length) {
    return { score: 0, matches: [], reasons: [] };
  }

  /** @type {Array<{ type: string, name: string, line?: number, matchedTokens: string[], score: number }>} */
  const matches = [];
  let strongScore = 0;
  /** @type {Map<string, number>} */
  const weakByToken = new Map();

  for (const symbol of symbols) {
    const nameTokens = new Set(tokenize(`${symbol.name} ${symbol.terms?.join(" ") ?? ""}`));
    const matchedTokens = tokens.filter((token) => tokenVariants(token).some((variant) => nameTokens.has(variant)));
    if (!matchedTokens.length) {
      continue;
    }

    const variantHits = tokens.flatMap((token) => tokenVariants(token).filter((variant) => nameTokens.has(variant)));
    // Two matched tokens that are both repo-wide generic nouns (e.g. "date"
    // and "booking" hitting `formatBookingDate` in an events app) shouldn't
    // score the same as two genuinely distinctive tokens. Weight each match
    // by its rarity across the indexed repo instead of counting it flatly.
    const weightSum = matchedTokens.reduce((sum, token) => sum + tokenWeightFactor(token, tokenStats), 0);
    const avgWeight = weightSum / matchedTokens.length;
    let hitScore = weightSum * 9 + Math.max(0, variantHits.length - matchedTokens.length) * 9 * avgWeight;
    if (symbol.type === "method" && matchedTokens.length >= 2) {
      hitScore += weightSum * 12;
    }
    if (symbol.type === "method" && matchedTokens.length >= 3) {
      hitScore += 24 * avgWeight;
    }
    hitScore = Math.round(hitScore);

    if (matchedTokens.length >= 2 || variantHits.length >= 2) {
      strongScore += hitScore;
    } else {
      for (const token of matchedTokens) {
        weakByToken.set(token, Math.max(weakByToken.get(token) ?? 0, hitScore));
      }
    }
    matches.push({
      type: symbol.type,
      name: symbol.name,
      line: symbol.line,
      matchedTokens,
      score: hitScore,
    });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    score: Math.min(
      strongScore +
        Math.min(
          [...weakByToken.values()].reduce((sum, value) => sum + value, 0),
          36,
        ),
      180,
    ),
    matches: matches.slice(0, 8),
    reasons: matches.length ? ["symbol"] : [],
  };
}

/**
 * Keep primary packs useful across domains instead of filling the budget with
 * one controller-heavy domain (e.g. booking) when the task spans email too.
 * @param {ScoredFile[]} files
 * @param {number} limit
 * @param {number} maxPerDomain
 * @returns {ScoredFile[]}
 */
function diversifyByDomain(files, limit, maxPerDomain = 3) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {ScoredFile[]} */
  const picked = [];

  for (const file of files) {
    const domain = file.domain || "unknown";
    const count = counts.get(domain) ?? 0;
    if (count >= maxPerDomain) {
      continue;
    }
    counts.set(domain, count + 1);
    picked.push(file);
    if (picked.length >= limit) {
      return picked;
    }
  }

  if (picked.length >= limit) {
    return picked;
  }

  for (const file of files) {
    if (picked.some((item) => fileKey(item) === fileKey(file))) {
      continue;
    }
    picked.push(file);
    if (picked.length >= limit) {
      break;
    }
  }

  return picked;
}

/**
 * @param {ScoredFile[]} scoredFiles
 * @param {ScoredFile[]} primaryFiles
 * @param {ScoredFile[]} relatedFiles
 * @param {string[]} tokens
 * @param {TokenStats} [tokenStats]
 * @param {RequestRules} [rules]
 */
function buildHotspots(scoredFiles, primaryFiles, relatedFiles, tokens, tokenStats, rules = noRequestRules) {
  const focusKeys = new Set([...primaryFiles, ...relatedFiles].map(fileKey));
  /** @type {Array<{ repo: string, path: string, kind: string, domain: string, symbol: string, type: string, line?: number, matchedTokens: string[], score: number, rank: number }>} */
  const hotspots = [];

  for (const file of scoredFiles) {
    if (!focusKeys.has(fileKey(file)) || !file.matchedSymbols?.length) {
      continue;
    }
    const catalog = file.kind === "translation" && !rules.wantsCopy;
    for (const match of file.matchedSymbols) {
      const named = rules.symbols.has(match.name);
      // A catalog key sharing one word with the request is how ten `main*`
      // keys became every hotspot for "sync local main branch". Distinct
      // words: that request says `main` twice.
      if (catalog && !named && new Set(match.matchedTokens).size < 2) {
        continue;
      }
      const topPrimary = primaryFiles.slice(0, 2).some((primary) => fileKey(primary) === fileKey(file));
      // Require the matched tokens to carry real specificity (rare across the
      // repo), not just a raw count of 2+ - two generic domain nouns (e.g.
      // "date" and "booking" both hitting `formatBookingDate`) shouldn't
      // qualify a symbol as a hotspot on their own.
      const specificity = match.matchedTokens.reduce((sum, token) => sum + tokenWeightFactor(token, tokenStats), 0);
      if (!named && specificity < 1.15 && !tokens.some((token) => token === normalizeText(file.domain)) && !topPrimary && !file.hasPhraseMatch) {
        continue;
      }
      hotspots.push({
        repo: file.repo.name,
        path: file.path,
        kind: file.kind,
        domain: file.domain,
        symbol: match.name,
        type: match.type,
        line: match.line,
        matchedTokens: match.matchedTokens,
        score: match.score,
        // The pinned definition of a named symbol (the one the code imports)
        // leads its local copies and unused duplicates.
        rank:
          (match.score + (topPrimary ? 12 : 0)) * (catalog ? TRANSLATION_DEMOTION : 1) +
          (named ? NAMED_HOTSPOT_BONUS * (rules.pinned.has(fileKey(file)) ? 2 : 1) : 0),
      });
    }
  }

  return hotspots
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol))
    .slice(0, 10)
    .map(({ rank: _rank, ...hotspot }) => hotspot);
}

/**
 * @param {Array<{ repo: string, path: string, symbol: string, type: string, line?: number, matchedTokens: string[], score: number }>|undefined} hotspots
 * @returns {string[]}
 */
function formatHotspots(hotspots) {
  if (!hotspots?.length) {
    return ["- No multi-token symbol hotspots matched; start with primary files."];
  }

  return hotspots.map((item) => {
    const line = item.line ? `:${item.line}` : "";
    return `- \`${item.repo}:${item.path}${line}\` \`${item.type} ${item.symbol}\` (tokens: ${item.matchedTokens.join(", ")}; score ${item.score})`;
  });
}

/**
 * Named files lead, ahead of the per-domain spread the rest of the list gets.
 * A named test that a runner executes leads Tests instead.
 * @param {ScoredFile[]} scoredFiles
 * @param {number} limit
 * @param {RequestRules} [rules]
 * @returns {ScoredFile[]}
 */
function selectPrimaryFiles(scoredFiles, limit, rules = noRequestRules) {
  const named = uniqueFiles(scoredFiles.filter((file) => rules.pinned.has(fileKey(file)) && !isRunnableTestPath(file.path))).slice(0, limit);
  const files = uniqueFiles(scoredFiles.filter((file) => file.kind !== "test" && !rules.pinned.has(fileKey(file))));
  const strong = files.filter((file) => file.score >= 25);
  const pool = strong.length ? strong : files.slice(0, Math.min(limit, 3));
  const remaining = limit - named.length;
  return remaining > 0 ? [...named, ...diversifyByDomain(pool, remaining, 2)] : named;
}

const fallbackEntryStems = new Map([
  ["main", 24],
  ["app", 20],
  ["index", 18],
  ["server", 16],
]);
const fallbackConfigPattern = /^(?:vite|webpack|rollup|next|nuxt|astro|svelte|remix|metro|babel|postcss|tailwind|esbuild|rsbuild)\.config\.[a-z]+$/;

// When task tokens match nothing (common on small repos or broad queries such
// as "improve SEO and performance"), fall back to a deterministic ranking of
// entrypoints, app/main/index files, and build configuration so primaryFiles
// is never empty while the repo has source files.
/**
 * @param {CodeMap[]} maps
 * @param {number} limit
 * @returns {ScoredFile[]}
 */
function selectFallbackPrimaryFiles(maps, limit) {
  /** @type {ScoredFile[]} */
  const candidates = [];
  /** @type {ScoredFile[]} */
  const everything = [];

  for (const map of maps) {
    const entrypoints = new Set(map.repo.entrypoints ?? []);
    for (const file of map.files ?? []) {
      if (file.isVendor || file.kind === "test") {
        continue;
      }

      const reasons = ["fallback: no task keywords matched indexed files"];
      let score = 0;
      const normalizedPath = normalizeRepoPath(file.path);
      const baseName = path.posix.basename(normalizedPath).toLowerCase();
      const stem = baseName.replace(/\..*$/, "");

      if (entrypoints.has(file.path)) {
        score += 30;
        reasons.push("repo entrypoint");
      }
      if (fallbackEntryStems.has(stem)) {
        score += fallbackEntryStems.get(stem) ?? 0;
        reasons.push(`${stem} entry file`);
      }
      if (fallbackConfigPattern.test(baseName)) {
        score += 14;
        reasons.push("build configuration");
      }

      const depth = normalizedPath.split("/").length - 1;
      score += Math.max(0, 6 - depth * 2);

      const summarized = summarizeFile(map, file, score, reasons);
      everything.push(summarized);
      if (score > 0) {
        candidates.push(summarized);
      }
    }
  }

  const pool = candidates.length ? candidates : everything;
  return uniqueFiles(pool)
    .sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * @param {CodeMap[]} maps
 * @param {Map<string, ImportGraph>} graphs
 * @param {ScoredFile[]} scoredFiles
 * @param {ScoredFile[]} primaryFiles
 * @param {number} limit
 * @returns {ScoredFile[]}
 */
function selectRelatedFiles(maps, graphs, scoredFiles, primaryFiles, limit) {
  const primaryKeys = new Set(primaryFiles.map(fileKey));
  /** @type {ScoredFile[]} */
  const related = [];
  const primaryByRepo = groupByRepo(primaryFiles);

  for (const map of maps) {
    // graphs is built from the same `maps` in generateContextPack, so every
    // repo.root key is present; assert non-null rather than guarding (which
    // would change runtime behavior).
    const graph = /** @type {ImportGraph} */ (graphs.get(map.repo.root));
    const filesByPath = new Map((map.files ?? []).map((file) => [file.path, file]));
    const repoPrimary = primaryByRepo.get(map.repo.root) ?? [];

    for (const primary of repoPrimary) {
      for (const imported of graph.importsByPath.get(primary.path) ?? []) {
        addRelated(related, map, filesByPath.get(imported), 18, "imported by primary file", primaryKeys);
      }
      for (const importer of graph.importedByPath.get(primary.path) ?? []) {
        addRelated(related, map, filesByPath.get(importer), 18, "imports primary file", primaryKeys);
      }
      for (const sibling of samePatternFiles(map.files, primary)) {
        addRelated(related, map, sibling, 10, "same kind/domain pattern", primaryKeys);
      }
    }
  }

  const candidates = uniqueFiles([...related, ...scoredFiles.filter((file) => file.kind !== "test" && !primaryKeys.has(fileKey(file)))]).sort(
    (a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name) || a.path.localeCompare(b.path),
  );
  // A primary catalog's other locales come back as its same-kind siblings;
  // they fold into the entry that already stands for them.
  return collapseLocaleSiblings([...primaryFiles, ...candidates], describeScoredFile)
    .filter((file) => !primaryKeys.has(fileKey(file)))
    .slice(0, limit);
}

/**
 * @param {CodeMap[]} maps
 * @param {Map<string, ImportGraph>} graphs
 * @param {ScoredFile[]} scoredFiles
 * @param {ScoredFile[]} primaryFiles
 * @param {number} limit
 * @returns {ScoredFile[]}
 */
function selectTests(maps, graphs, scoredFiles, primaryFiles, limit) {
  /** @type {ScoredFile[]} */
  const selected = [];
  const contextFiles = primaryFiles;
  const contextKeys = new Set(contextFiles.map(fileKey));
  const contextDomains = new Set(contextFiles.map((file) => file.domain).filter(Boolean));

  // Only what a test runner executes: a README or a suite summary under
  // __tests__/ is a note about the tests, and a `.snap` is their output.
  for (const file of scoredFiles.filter((item) => item.kind === "test" && isRunnableTestPath(item.path))) {
    selected.push(file);
  }

  for (const map of maps) {
    // See selectRelatedFiles: graphs always contains this repo.root.
    const graph = /** @type {ImportGraph} */ (graphs.get(map.repo.root));
    for (const file of map.files?.filter((entry) => entry.kind === "test" && isRunnableTestPath(entry.path)) ?? []) {
      const imports = graph.importsByPath.get(file.path) ?? new Set();
      const importsContext = [...imports].some((target) => contextKeys.has(`${map.repo.root}:${target}`));
      const matchesDomain =
        contextDomains.has(file.domain) || [...contextDomains].some((domain) => file.path.toLowerCase().includes(String(domain).toLowerCase()));
      if (importsContext || matchesDomain) {
        selected.push(summarizeFile(map, file, importsContext ? 16 : 8, [importsContext ? "imports selected file" : "matches selected domain", "test"]));
      }
    }
  }

  return uniqueFiles(selected)
    .sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name) || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * @param {ScoredFile[]} related
 * @param {CodeMap} map
 * @param {CodeMapFile|undefined} file
 * @param {number} score
 * @param {string} reason
 * @param {Set<string>} primaryKeys
 */
function addRelated(related, map, file, score, reason, primaryKeys) {
  if (!file || file.kind === "test") {
    return;
  }
  const summarized = summarizeFile(map, file, score, [reason]);
  if (!primaryKeys.has(fileKey(summarized))) {
    related.push(summarized);
  }
}

/**
 * `primary` is always supplied by callers; it is typed optional only because the
 * `files = []` default makes the leading parameter optional, and TS forbids a
 * required parameter after an optional one (TS1016). No runtime contract change.
 * @param {CodeMapFile[]} [files]
 * @param {CodeMapFile|ScoredFile} [primary]
 * @returns {CodeMapFile[]}
 */
function samePatternFiles(files = [], primary) {
  const ref = /** @type {CodeMapFile|ScoredFile} */ (primary);
  return files.filter((file) => file.path !== ref.path && file.kind === ref.kind && file.domain === ref.domain && file.kind !== "source").slice(0, 3);
}

/**
 * @param {string[]} repoPaths
 * @param {string} query
 * @returns {EngineCommand[]}
 */
function inferCommands(repoPaths, query) {
  /** @type {EngineCommand[]} */
  const commands = [];
  for (const repoPath of repoPaths) {
    const harness = generateHarness(repoPath).data;
    commands.push(
      .../** @type {EngineCommand[]} */ (harness.commands.validate).map((command) => ({
        ...command,
        repo: harness.repo.name,
      })),
    );
    commands.push({
      repo: harness.repo.name,
      command: `solumbe context ${JSON.stringify(query)} --path ${JSON.stringify(harness.repo.root)} --json`,
      reason: "refresh this context packet before planning or review",
    });
  }
  return uniqueCommands(commands);
}

/**
 * @param {CodeMap[]} maps
 * @returns {string[]}
 */
function inferConflicts(maps) {
  /** @type {string[]} */
  const conflicts = [];
  for (const map of maps) {
    const git = /** @type {{ available?: boolean, clean?: boolean, changes?: number, upstream?: string, behind?: number }} */ (map.repo.git);
    if (git?.available && !git.clean) {
      conflicts.push(`${map.repo.name} has ${git.changes} uncommitted git change(s); inspect the working tree before editing.`);
    }
    if (git?.available && git.behind) {
      conflicts.push(`${map.repo.name} is ${git.behind} commit(s) behind ${git.upstream} as of the last fetch; this context describes the older checkout.`);
    }
  }
  return conflicts;
}

/**
 * @param {ScoredFile[]} primaryFiles
 * @param {EngineCommand[]} commands
 * @param {Intent} intent
 * @param {boolean} usedFallback
 * @param {Array<{ path: string }>|undefined} [hotspots]
 * @returns {string[]}
 */
function inferOpenQuestions(primaryFiles, commands, intent, usedFallback, hotspots = []) {
  /** @type {string[]} */
  const questions = [];
  if (!primaryFiles.length) {
    questions.push("No strong primary files matched the task; refine the query or index more repositories.");
  } else if (usedFallback) {
    questions.push(
      "No task keywords matched indexed files; primary files fall back to repo entrypoints and build configuration — refine the query for tighter context.",
    );
  }
  if (!commands.some((command) => command.script && /test|lint|type|build|tsc/.test(command.script))) {
    questions.push("No validation script was detected; decide how the change should be verified.");
  }
  if (intent.action === "unknown") {
    questions.push(AMBIGUOUS_ACTION_QUESTION);
  }
  if (!hotspots.length && primaryFiles.length && !usedFallback) {
    questions.push("No multi-token symbol hotspots matched; confirm the exact methods or types to change.");
  }
  const primaryDomains = new Set(primaryFiles.map((file) => normalizeText(file.domain || "")).filter(Boolean));
  for (const topic of intent.topics) {
    if (
      ["email", "branding", "payment", "fees", "booking", "organisation", "organization", "auth"].includes(topic) &&
      ![...primaryDomains].some((domain) => domain.includes(topic) || topic.includes(domain))
    ) {
      questions.push(`Query topic "${topic}" is not represented in primary file domains; consider narrowing path or re-indexing.`);
    }
  }
  return questions.slice(0, 6);
}

/**
 * @param {CodeMap[]} maps
 * @param {EngineCommand[]} commands
 */
function inferSources(maps, commands) {
  return [
    ...maps.map((map) => ({
      type: "code-map",
      repo: map.repo.name,
      path: map.cache?.path,
      cacheHit: Boolean(map.cache?.hit),
      fingerprint: map.cache?.fingerprint,
    })),
    ...uniqueBy(
      commands.filter((command) => command.repo),
      (command) => command.repo ?? "",
    ).map((command) => ({
      type: "harness",
      repo: command.repo,
      command: "solumbe harness <path> --json",
    })),
  ];
}

/**
 * @param {string[]} tokens
 * @returns {Intent}
 */
function inferIntent(tokens) {
  const named = tokens.find((token) => actionWords.has(token));
  const action = named ?? (tokens.some((token) => debugSynonyms.has(token)) ? "debug" : "unknown");
  return {
    action,
    topics: tokens.filter((token) => !actionWords.has(token)).slice(0, 8),
  };
}

/**
 * @param {CodeMapFile[]} [files]
 * @returns {ImportGraph}
 */
function buildImportGraph(files = []) {
  const fileSet = new Set(files.map((file) => file.path));
  /** @type {Map<string, Set<string>>} */
  const importsByPath = new Map();
  /** @type {Map<string, Set<string>>} */
  const importedByPath = new Map();

  for (const file of files) {
    /** @type {Set<string>} */
    const imports = new Set();
    for (const specifier of file.imports ?? []) {
      const resolved = resolveImport(file.path, specifier, fileSet);
      if (!resolved) {
        continue;
      }
      imports.add(resolved);
      const importers = importedByPath.get(resolved) ?? new Set();
      importers.add(file.path);
      importedByPath.set(resolved, importers);
    }
    importsByPath.set(file.path, imports);
  }

  return { importsByPath, importedByPath };
}

/**
 * @param {string} fromPath
 * @param {string} specifier
 * @param {Set<string>} fileSet
 * @returns {string|undefined}
 */
function resolveImport(fromPath, specifier, fileSet) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = normalizeRepoPath(path.posix.join(path.posix.dirname(fromPath), specifier));
  for (const extension of importExtensions) {
    const candidate = normalizeRepoPath(`${base}${extension}`);
    if (fileSet.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * @param {CodeMap} map
 */
function summarizeRepo(map) {
  return {
    root: map.repo.root,
    name: map.repo.name,
    package: map.repo.package,
    git: map.repo.git,
    sourceFileCount: map.repo.sourceFileCount,
    summary: map.summary,
    domains: map.domains.slice(0, 12),
  };
}

/**
 * @param {CodeMap} map
 * @param {CodeMapFile} file
 * @param {number} score
 * @param {string[]} reasons
 * @returns {ScoredFile}
 */
function summarizeFile(map, file, score, reasons) {
  return {
    repo: {
      name: map.repo.name,
      root: map.repo.root,
    },
    path: file.path,
    kind: file.kind,
    domain: file.domain,
    score,
    reasons: [...new Set(reasons)].filter(Boolean).slice(0, 8),
    route: file.route,
    controllerBasePath: file.controllerBasePath,
    httpMethods: file.httpMethods ?? [],
    imports: file.imports?.slice(0, 12) ?? [],
    exports: file.exports?.slice(0, 12) ?? [],
    symbols: file.symbols?.slice(0, 16) ?? [],
  };
}

// imports/exports/symbols are the bulk of a file entry's bytes and are only
// useful when an agent wants the evidence trail. They are dropped by default
// (includeEvidence:false) so the packet stays compact; path/kind/score/reasons
// and routing fields are always kept.
const evidenceFields = ["imports", "exports", "symbols", "matchedSymbols", "hasPhraseMatch"];

/**
 * @param {ScoredFile[]} files
 * @param {boolean} includeEvidence
 * @returns {ScoredFile[]}
 */
function stripEvidence(files, includeEvidence) {
  if (includeEvidence) {
    return files;
  }
  return files.map((file) => {
    /** @type {Record<string, any>} */
    const rest = { ...file };
    for (const field of evidenceFields) {
      delete rest[field];
    }
    return /** @type {ScoredFile} */ (rest);
  });
}

/**
 * @param {string|null|undefined} value
 * @param {string[]} tokens
 * @param {number} weight
 * @param {string} reason
 * @param {string[]} reasons
 * @param {TokenStats} [tokenStats]
 * @returns {number}
 */
function scoreField(value, tokens, weight, reason, reasons, tokenStats) {
  if (!value) {
    return 0;
  }

  const normalized = normalizeText(String(value));
  const normalizedTokens = new Set(tokenize(String(value)));
  let score = 0;
  for (const token of tokens) {
    const variants = tokenVariants(token);
    const factor = tokenWeightFactor(token, tokenStats);
    if (variants.some((variant) => normalized === variant)) {
      score += Math.round(weight * 2 * factor);
    } else if (variants.some((variant) => normalizedTokens.has(variant) || normalized.includes(variant))) {
      score += Math.round(weight * factor);
    }
  }

  if (score > 0) {
    reasons.push(reason);
  }
  return score;
}

/**
 * Score a set of imports or exports once per query concept rather than once
 * per matching declaration. This stops a broad barrel such as `types/index`
 * from winning solely because it repeats a word like `event` many times.
 *
 * @param {string[]} values
 * @param {string[]} tokens
 * @param {number} weight
 * @param {string} reason
 * @param {string[]} reasons
 * @param {number} cap
 * @param {TokenStats} [tokenStats]
 */
function scoreCollection(values, tokens, weight, reason, reasons, cap, tokenStats) {
  /** @type {Map<string, number>} */
  const scoreByToken = new Map();
  for (const value of values) {
    const normalized = normalizeText(value);
    const normalizedTokens = new Set(tokenize(value));
    for (const token of tokens) {
      const variants = tokenVariants(token);
      const factor = tokenWeightFactor(token, tokenStats);
      const hit = variants.some((variant) => normalized === variant)
        ? Math.round(weight * 2 * factor)
        : variants.some((variant) => normalizedTokens.has(variant) || normalized.includes(variant))
          ? Math.round(weight * factor)
          : 0;
      if (hit > 0) {
        scoreByToken.set(token, Math.max(scoreByToken.get(token) ?? 0, hit));
      }
    }
  }
  const score = Math.min(
    [...scoreByToken.values()].reduce((sum, value) => sum + value, 0),
    cap,
  );
  if (score > 0) {
    reasons.push(reason);
  }
  return score;
}

/**
 * @param {ScoredFile[]} files
 * @param {string} fallback
 * @returns {string[]}
 */
function formatFiles(files, fallback) {
  if (!files.length) {
    return [`- ${fallback}`];
  }

  return files.map((file) => {
    const reasons = file.reasons.length ? `; ${file.reasons.join(", ")}` : "";
    return `- \`${file.repo.name}:${file.path}\` (${file.kind}/${file.domain}, score ${file.score}${reasons})`;
  });
}

/**
 * @param {ScoredFile[]} files
 * @returns {Map<string, ScoredFile[]>}
 */
function groupByRepo(files) {
  /** @type {Map<string, ScoredFile[]>} */
  const grouped = new Map();
  for (const file of files) {
    const values = grouped.get(file.repo.root) ?? [];
    values.push(file);
    grouped.set(file.repo.root, values);
  }
  return grouped;
}

/**
 * @param {ScoredFile[]} files
 * @returns {ScoredFile[]}
 */
function uniqueFiles(files) {
  return uniqueBy(files, fileKey);
}

/**
 * @param {EngineCommand[]} commands
 * @returns {EngineCommand[]}
 */
function uniqueCommands(commands) {
  return uniqueBy(commands, (command) => `${command.repo}:${command.command}`);
}

/**
 * @template T
 * @param {T[]} values
 * @param {(value: T) => string} keyForValue
 * @returns {T[]}
 */
function uniqueBy(values, keyForValue) {
  const seen = new Set();
  /** @type {T[]} */
  const result = [];
  for (const value of values) {
    const key = keyForValue(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}

/**
 * @param {ScoredFile|CodeMapFile & { repo: { root: string } }} file
 * @returns {string}
 */
function fileKey(file) {
  return `${file.repo.root}:${file.path}`;
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

/**
 * Lightweight plural / British spelling variants so query tokens like
 * "emails" still hit symbols named `...Email` / `organisation` ↔ `organization`.
 * @param {string} token
 * @returns {string[]}
 */
function tokenVariants(token) {
  /** @type {Set<string>} */
  const variants = new Set([token]);
  if (token.endsWith("ies") && token.length > 4) {
    variants.add(`${token.slice(0, -3)}y`);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    variants.add(token.slice(0, -1));
  }
  if (token === "organisation") {
    variants.add("organization");
  }
  if (token === "organization") {
    variants.add("organisation");
  }
  if (token === "branding") {
    variants.add("brand");
  }
  if (token === "signup") {
    variants.add("register");
    variants.add("registration");
  }
  if (token === "verification") {
    variants.add("verify");
    variants.add("verified");
    variants.add("validate");
    variants.add("otp");
  }
  if (token === "qr") {
    variants.add("scan");
    variants.add("ticket");
  }
  if (token === "check" || token === "checkin") {
    variants.add("scan");
  }
  if (token === "venue") {
    variants.add("address");
    variants.add("location");
  }
  if (token === "private" || token === "privacy") {
    variants.add("hide");
    variants.add("hidden");
    variants.add("visibility");
  }
  return [...variants];
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function normalizePaths(paths) {
  const values = Array.isArray(paths) && paths.length ? paths : ["."];
  return [...new Set(values.map((value) => path.resolve(String(value || "."))))];
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function normalizeLimit(value, fallback, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}
