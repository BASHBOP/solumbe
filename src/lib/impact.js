// solumbe impact: given a free-text change request, rank the files most likely
// to own the change. Ports impact-map's scoring (text.py + scoring.py +
// validation.py) onto solumbe's AST code map. The substrate change is the
// point — code-map already filters to source extensions, so the documentation/
// false-positive class from the field test cannot enter the candidate set.

/// <reference types="node" />
import path from "node:path";
import { companionRepos } from "./config.js";
import { getCachedCodeMap } from "./index-cache.js";
import { conceptsFromQuery, classifyPath, CONCEPT_SYNONYMS, RISK_FLAGS, glyphFor, isDocPath, isTestDataPath, singularizeToken } from "./risk-paths.js";
import { isRunnableTestPath, isTestFilePath } from "./code-map/classify.js";
import { joinedCamelCaseWords } from "./code-map/text.js";
import {
  collapseLocaleSiblings,
  formatLocales,
  importDegrees,
  isCopyRequest,
  resolveNamedFiles,
  stripFileExtensions,
  TRANSLATION_DEMOTION,
} from "./ranking-rules.js";
import { estimateTokens, estimateTokenSections } from "./tokens.js";
import { runCommand } from "./tools.js";

export const DIFF_RENAME_LIMIT = 1000;

/**
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 * @typedef {import('./index-cache.js').CodeMapRepo} CodeMapRepo
 */

/**
 * Options for generateImpact.
 * @typedef {object} ImpactOptions
 * @property {number} [top]
 * @property {string} [path]
 * @property {string} [diffBase]
 * @property {string[]} [diffFiles]
 * @property {any} [codeMap]
 * @property {boolean} [includeUntracked] count untracked files as changed against diffBase (default true)
 * @property {boolean} [companions] also rank the companion repositories in the repo's .solumberc.json (see companionLeads)
 */

/**
 * The few files a companion repository would own for the same request.
 * @typedef {object} CompanionLead
 * @property {string} repo
 * @property {string} root
 * @property {{ path: string, score: number, riskFlags: string[] }[]} topFiles
 */

/**
 * A scored candidate file as held in the scoring map.
 * @typedef {object} ScoredEntry
 * @property {CodeMapFile} file
 * @property {number} score
 * @property {string[]} reasons
 * @property {string[]} relatedFiles
 * @property {string[]} [siblings] locale files of the same catalog this entry stands for
 */

/**
 * A file the request names, with its position among the pins.
 * @typedef {import('./ranking-rules.js').NamedFile & { order: number }} PinnedFile
 */

/**
 * The per-file score/reasons produced by scoreFile.
 * @typedef {object} ScoreResult
 * @property {number} score
 * @property {string[]} reasons
 */

// 4: a file the request names is pinned as a required owner, a translation
// catalog is demoted unless the request is about copy and its locale files
// share one entry (`siblings`), and a named file's extension no longer scores.
// 5: a request no owner grounds by its words is grounded in the import graph
// when one file is named for a word in it, or is the only exporter of one.
const impactEngineVersion = 5;
const defaultTop = 10;
const companionTop = 3;

const STOP_WORDS = new Set([
  "a",
  "add",
  "also",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "change",
  "do",
  "drop",
  "fix",
  "for",
  "from",
  "get",
  "has",
  "have",
  "i",
  "in",
  "into",
  "is",
  "it",
  "just",
  "make",
  "need",
  "new",
  "of",
  "on",
  "only",
  "or",
  "our",
  "please",
  "remove",
  "rename",
  "should",
  "that",
  "the",
  "this",
  "to",
  "update",
  "use",
  "via",
  "want",
  "we",
  "when",
  "with",
]);

const DOMAIN_KEYWORDS = new Set([
  "api",
  "auth",
  "booking",
  "billing",
  "cache",
  "checkout",
  "csv",
  "database",
  "email",
  "export",
  "import",
  "invoice",
  "login",
  "migration",
  "notification",
  "order",
  "payment",
  "refund",
  "report",
  "route",
  "schema",
  "stripe",
  "subscription",
  "upload",
  "user",
  "webhook",
]);

const TEST_MATCH_STOP_TERMS = new Set([
  "app",
  "backend",
  "component",
  "components",
  "frontend",
  "helper",
  "helpers",
  "hook",
  "hooks",
  "index",
  "lib",
  "screen",
  "service",
  "services",
  "src",
  "test",
  "tests",
  "types",
  "ui",
  "util",
  "utils",
]);

// Scoring weights, kept close to impact-map's originals so the ranking remains
// intuitive for anyone familiar with that tool.
const W_PATH = 9.0;
const W_SYMBOL = 5.0;
const W_ROUTE = 7.0;
const W_EXPORT = 4.0;
const W_IMPORT = 2.5;
const W_CONCEPT = 6.0;
const W_CONFIG_HINT = 4.0;
// A definition of a symbol the request names, when it is not the definition
// the code imports (that one is pinned): a local copy, an export nothing uses.
const W_NAMED_DEFINER = 30.0;
// How far a named file sits above the best candidate the request did not
// name. A named path outranks a named symbol's definition.
const PIN_MARGIN = { path: 20.0, symbol: 10.0, implements: 10.0 };

const CONFIG_HINTS = {
  docker: ["dockerfile", "docker-compose"],
  env: [".env", "config", "settings"],
  config: ["config", "settings"],
  deploy: ["dockerfile", "procfile", "wrangler", "vercel", "netlify"],
  database: ["schema", "migration", "prisma"],
  migration: ["schema", "migration", "prisma"],
  stripe: ["stripe"],
  auth: ["auth", "session", "middleware"],
};

// Kinds that are real implementation owners. The presence of one of these in
// the top-5 is what we are optimizing for — these get the concept boost.
const OWNER_KINDS = new Set(["controller", "service", "route", "apiRoute", "apiClient", "schema", "dto", "module", "component", "template", "skill", "doc"]);
// Kinds whose behavior change usually crosses a request/response contract, so
// a "required owner" candidate of this kind is only trusted when the request
// itself names an API-boundary concern (see requestBoundaryChange below).
// `route` (a Next.js `page.tsx`/`layout.tsx`, from code-map/classify.js) is
// deliberately excluded: it is a rendered UI screen, not a request boundary —
// `apiRoute` (`app/api/**/route.ts`) already covers the actual API-boundary
// case. Recorded gap: "deprecate web scan-ticket page, direct organisers to
// iOS app download" named no API word, so the changed `page.tsx` (the actual,
// diff-confirmed, top-scored owner) was gated out of requiredOwners entirely
// while unrelated components that merely shared the word "ticket" were not.
const REQUEST_BOUNDARY_KINDS = new Set(["controller", "apiRoute", "apiClient", "dto"]);

// Markdown owner kinds only own the change when the request is actually about
// them. A SKILL.md *is* the implementation of a skill and a docs page *is* the
// implementation of documentation, so both must be able to carry a coverage
// obligation — but neither owns a code change that merely shares vocabulary
// with it. "Fix the model router scoring bug" is owned by src/lib/model-route.js,
// not by codex/skills/model-router/SKILL.md, even though the skill's path
// matches every term.
const INTENT_GATED_OWNER_KINDS = new Set(["skill", "doc"]);
const SKILL_REQUEST_TERMS = ["skill", "skills", "prompt", "prompts", "playbook", "rubric", "instruction", "instructions"];
const REQUIRED_OWNER_SCORE_RATIO = 0.8;

// Kinds that can never own an implementation change, so they are excluded from
// the generic-source fallback below. Everything else — notably plain `source`,
// `hook`, and `use` — is eligible once it matches the request directly.
const NEVER_OWNER_KINDS = new Set(["test", "changelog", "config", "translation"]);

// Libraries, CLIs, and most utility code classify as `source`, which is not in
// OWNER_KINDS. Without a fallback those repositories can never ground a task:
// `requiredOwners` stays empty, convergence reports `grounded: false`, and the
// score collapses to the same value for an exactly-correct change and a wholly
// unrelated one. The fallback only engages when no conventional owner kind
// matched, and only for a candidate whose own lexical evidence is strong, so a
// weak incidental match never becomes a coverage obligation.
const FALLBACK_OWNER_MIN_SCORE = 20;

// Paths that are usually not the owner of a behavior change. Demoted but not
// dropped — sometimes the right answer IS a script.
const PENALTY_PATH_PREFIXES = [
  { prefix: "scripts/", factor: 0.55, reason: "operational script, demoted vs implementation files" },
  { prefix: "src/scripts/", factor: 0.55, reason: "operational script, demoted vs implementation files" },
  { prefix: "documentation/", factor: 0.3, reason: "generated documentation, demoted" },
  { prefix: "docs/", factor: 0.6, reason: "documentation file, demoted unless docs are requested" },
];

/**
 * @param {string} query
 * @param {ImpactOptions} [options]
 */
export function generateImpact(query, options = {}) {
  const normalized = String(query ?? "").trim();
  if (!normalized) {
    throw new Error("impact requires a non-empty query");
  }

  const top = clampInt(options.top, defaultTop, 1, 50);
  const repoPath = options.path ?? ".";
  const map = options.codeMap ?? getCachedCodeMap(repoPath);
  // The words of a named file score; its extension, shared by every file of
  // that language, does not.
  const termsQuery = stripFileExtensions(normalized);
  const weightedQuery = weightedQueryTerms(termsQuery);
  const concepts = conceptsFromQuery(normalized);
  const wantsTests = queryMentions(weightedQuery, ["test", "tests", "spec", "coverage", "qa"]);
  const wantsDocs = queryMentions(weightedQuery, ["doc", "docs", "documentation", "readme", "changelog"]);
  const wantsCopy = isCopyRequest(weightedQuery.keys());
  const named = resolveNamedFiles(map.files, normalized, { limit: top });
  /** @type {Map<string, PinnedFile>} */
  const pinned = new Map(named.pinned.map((entry, order) => [entry.path, { ...entry, order }]));

  const docFrequency = computeTokenDocFrequency(map.files, weightedQuery);
  const scored = scoreFiles(map.files, weightedQuery, concepts, { wantsTests, wantsDocs, wantsCopy }, docFrequency);
  addNamedFiles(scored, map.files, pinned, named.definers);
  const withBoosts = applyDependencyBoosts(map.files, scored, pinned);
  liftPinnedFiles(withBoosts, pinned);
  const pinOrder = (/** @type {ScoredEntry} */ entry) => pinned.get(entry.file.path)?.order ?? Number.MAX_SAFE_INTEGER;
  const byScore = [...withBoosts.values()].sort((a, b) => b.score - a.score || pinOrder(a) - pinOrder(b));
  const heuristicRanked = collapseLocaleSiblings(byScore, describeEntry, (entry) => pinned.has(entry.file.path)).slice(0, top);
  const roles = classifyImpactRoles(heuristicRanked, map.files, termsQuery, pinned);
  const diffSnapshot = captureDiffSnapshot(map.repo.root, options.diffBase, options.diffFiles, options.includeUntracked ?? true);
  const exactDiffFiles = diffSnapshot?.ok ? (diffSnapshot.files ?? []) : [];
  const diffEvidence = diffSnapshot?.ok ? buildDiffEvidence(exactDiffFiles, map.files, withBoosts, diffSnapshot.base) : null;
  const changedPaths = new Set(diffEvidence ? diffEvidence.entries.map((entry) => entry.file.path) : []);
  // A requested Git diff is evidence, not another fuzzy ranking signal. Put every
  // mapped changed file ahead of heuristic candidates and label it as such, so an
  // agent cannot silently overlook the source files that actually changed.
  const ranked = addPredictableSupportFiles(
    diffEvidence ? mergeDiffEvidence(diffEvidence.entries, heuristicRanked) : heuristicRanked,
    map.files,
    roles,
    (entry) => pinned.has(entry.file.path) || changedPaths.has(entry.file.path),
  );
  noteLocaleSiblings(ranked);

  const testSuggestions = suggestTests(map.files, ranked, map.repo);
  // An advisory lead is a guess the change may not touch, so its domain is not
  // this change's risk: a payment page ranked as a loose lead must not raise a
  // money-flow warning on an RSVP gallery fix. Changed files always count.
  const risks = identifyRisks(
    normalized,
    ranked.filter((entry) => roles.byPath.get(entry.file.path) !== "advisory" || changedPaths.has(entry.file.path)),
    concepts,
  );
  const validation = diffSnapshot ? (diffSnapshot.ok ? validateChangedFiles(diffSnapshot.base, exactDiffFiles, roles) : diffSnapshot) : null;

  const data = /** @type {Record<string, any> & { tokenEstimate?: any }} */ ({
    ok: true,
    generatedAt: new Date().toISOString(),
    impactEngineVersion,
    query: normalized,
    repo: {
      name: map.repo.name,
      root: map.repo.root,
      sourceFileCount: map.repo.sourceFileCount,
    },
    concepts,
    diffEvidence: diffEvidence
      ? {
          base: diffEvidence.base,
          changedFileCount: diffEvidence.files.length,
          mappedFiles: diffEvidence.entries.map((entry) => entry.file.path),
          unmappedFiles: diffEvidence.unmappedFiles,
        }
      : null,
    topFiles: ranked.map((entry) => ({
      path: entry.file.path,
      kind: entry.file.kind,
      domain: entry.file.domain,
      score: round(entry.score),
      reasons: entry.reasons,
      relatedFiles: entry.relatedFiles.slice(0, 8),
      role: roles.byPath.get(entry.file.path) ?? "advisory",
      riskFlags: classifyPath(entry.file.path, { kind: entry.file.kind }),
      ...(entry.siblings?.length ? { siblings: entry.siblings } : {}),
    })),
    testSuggestions,
    risks,
    classifications: {
      requiredOwners: roles.requiredOwners,
      supportingFiles: roles.supportingFiles,
      advisoryFiles: roles.advisoryFiles,
    },
    validation,
  });
  if (options.companions) {
    const companions = companionLeads(normalized, repoPath);
    if (companions.length) data.companions = companions;
  }

  data.tokenEstimate = {
    ...estimateTokenSections([
      { name: "concepts", value: data.concepts },
      { name: "diffEvidence", value: data.diffEvidence },
      { name: "topFiles", value: data.topFiles },
      { name: "testSuggestions", value: data.testSuggestions },
      { name: "risks", value: data.risks },
    ]),
    fullJson: estimateTokens(data),
  };

  const markdown = formatImpactMarkdown(data);
  data.tokenEstimate.markdown = estimateTokens(markdown);

  return { data, markdown };
}

/**
 * Leads in the repository's companions (`companions` in its .solumberc.json):
 * the top few files each one would own for the same request, ranked by the
 * heuristic alone since a companion has no diff here. A web change whose rule
 * the API also decides then points at the API file, which a single-repo impact
 * never sees. A companion with no file scoring above zero is kept with no
 * files, so the report shows it was looked at.
 * @param {string} query
 * @param {string} repoPath
 * @param {{ top?: number }} [options]
 * @returns {CompanionLead[]}
 */
export function companionLeads(query, repoPath, options = {}) {
  const root = path.resolve(repoPath);
  const top = options.top ?? companionTop;
  return companionRepos(root)
    .filter((dir) => dir !== root)
    .map((dir) => {
      const { data } = generateImpact(query, { path: dir, top });
      return {
        repo: data.repo.name,
        root: data.repo.root,
        topFiles: data.topFiles
          .filter((/** @type {any} */ file) => file.score > 0)
          .slice(0, top)
          .map((/** @type {any} */ file) => ({ path: file.path, score: file.score, riskFlags: file.riskFlags })),
      };
    });
}

/**
 * @typedef {{ wantsTests: boolean, wantsDocs: boolean, wantsCopy: boolean }} ScoreFlags
 */

/**
 * @param {CodeMapFile[]} files
 * @param {Map<string, number>} weightedQuery
 * @param {string[]} concepts
 * @param {ScoreFlags} flags
 * @param {TokenDocFrequency} [stats]
 * @returns {Map<string, ScoredEntry>}
 */
function scoreFiles(files, weightedQuery, concepts, flags, stats) {
  /** @type {Map<string, ScoredEntry>} */
  const scored = new Map();
  for (const file of files) {
    const result = scoreFile(file, weightedQuery, concepts, flags, stats);
    if (result.score > 0) {
      scored.set(file.path, { file, score: result.score, reasons: result.reasons, relatedFiles: [] });
    }
  }
  return scored;
}

/**
 * @param {CodeMapFile} file
 * @param {Map<string, number>} weightedQuery
 * @param {string[]} concepts
 * @param {ScoreFlags} flags
 * @param {TokenDocFrequency} [stats]
 * @returns {ScoreResult}
 */
function scoreFile(file, weightedQuery, concepts, { wantsTests, wantsDocs, wantsCopy }, stats) {
  // The extension names the language, not the change: "port it to Go" must
  // not path-match every `.go` file.
  const pathTokens = tokenize(file.path.replace(/\.[A-Za-z0-9]+$/, ""));
  const pathCounts = countTokens(pathTokens);
  const symbolTokens = tokenize(file.symbols.map((symbol) => symbol.name ?? "").join(" "));
  const symbolCounts = countTokens(symbolTokens);
  const exportTokens = tokenize((file.exports ?? []).join(" "));
  const importTokens = tokenize((file.imports ?? []).join(" "));
  const routeTokens = tokenize([file.controllerBasePath ?? "", file.route ?? "", (file.httpMethods ?? []).join(" ")].join(" "));

  let score = 0;
  /** @type {string[]} */
  const reasons = [];

  // Path matches — strongest single signal because path naming reflects intent.
  // Counts capped at 1 per term so "validation" appearing twice in a directory
  // + filename can't out-rank a single-match owner file from another domain.
  // Each term's own contribution is additionally weighted by tokenWeightFactor:
  // a term that recurs across a large share of the repo (a generic domain noun
  // like "ticket" or "check" shared by several unrelated modules) counts for
  // less than one that is rare and therefore more likely to name the actual
  // owner. See computeTokenDocFrequency.
  const pathHits = matchedTerms(pathCounts, weightedQuery);
  if (pathHits.length) {
    const amount = pathHits.reduce((sum, term) => sum + W_PATH * /** @type {number} */ (weightedQuery.get(term)) * tokenWeightFactor(term, stats), 0);
    score += amount;
    reasons.push(`path matches: ${pathHits.slice(0, 8).join(", ")}`);
  }

  const symbolHits = matchedTerms(symbolCounts, weightedQuery);
  if (symbolHits.length) {
    const amount = symbolHits.reduce((sum, term) => sum + W_SYMBOL * /** @type {number} */ (weightedQuery.get(term)) * tokenWeightFactor(term, stats), 0);
    score += amount;
    reasons.push(`symbol matches: ${symbolHits.slice(0, 8).join(", ")}`);
  }

  const exportHits = matchedTerms(countTokens(exportTokens), weightedQuery);
  if (exportHits.length) {
    const amount = exportHits.reduce((sum, term) => sum + W_EXPORT * /** @type {number} */ (weightedQuery.get(term)) * tokenWeightFactor(term, stats), 0);
    score += amount;
    reasons.push(`export matches: ${exportHits.slice(0, 6).join(", ")}`);
  }

  const importHits = matchedTerms(countTokens(importTokens), weightedQuery);
  if (importHits.length) {
    const amount = importHits.reduce((sum, term) => sum + W_IMPORT * /** @type {number} */ (weightedQuery.get(term)) * tokenWeightFactor(term, stats), 0);
    score += amount;
    reasons.push(`import matches: ${importHits.slice(0, 6).join(", ")}`);
  }

  const routeHits = matchedTerms(countTokens(routeTokens), weightedQuery);
  if (routeHits.length) {
    const amount = routeHits.reduce((sum, term) => sum + W_ROUTE * /** @type {number} */ (weightedQuery.get(term)) * tokenWeightFactor(term, stats), 0);
    score += amount;
    reasons.push(`route matches: ${routeHits.slice(0, 6).join(", ")}`);
  }

  // Concept boost: file's risk flags or content overlap the query's implied
  // concepts. This is what makes "Apple sign-in" find auth controllers even
  // when the request says nothing literal about auth. Without it, a file
  // matching a generic word like "validation" out-ranks the real owner.
  const impliedConcepts = concepts.length ? fileImpliesConcepts(file, concepts) : new Set();
  if (impliedConcepts.size > 0) {
    const conceptBoost = W_CONCEPT * impliedConcepts.size;
    score = score * 1.4 + conceptBoost;
    reasons.push(`concept match: ${[...impliedConcepts].join(", ")} (×1.4 + ${conceptBoost.toFixed(1)})`);
  } else if (concepts.length > 0) {
    // No file matched the query's concepts: demote, but proportionally and
    // safely. A single confident concept is a strong signal that off-concept
    // files are wrong, so demote hard; but when several concepts were detected
    // they are more likely to disagree (and any one file rarely covers them
    // all), so soften the demotion toward 1.0 as concept count grows. This
    // keeps one stray concept from skewing the whole ranking.
    const factor = conceptDemotionFactor(concepts.length);
    score *= factor;
    reasons.push(`no concept match for query, demoted (×${factor.toFixed(2)})`);
  }

  const configBonus = computeConfigBonus(file.path, weightedQuery);
  if (configBonus) {
    score += configBonus;
    reasons.push(`configuration/domain hint (+${configBonus.toFixed(1)})`);
  }

  if (score === 0) {
    return { score: 0, reasons: [] };
  }

  // Kind/domain penalties — the substantive quality improvement over impact-map.
  if (file.kind === "test") {
    if (wantsTests) {
      score *= 0.9;
      reasons.push("test file, query mentions tests");
    } else {
      score *= 0.45;
      reasons.push("test file, ranked lower than implementation");
    }
  }

  for (const { prefix, factor, reason } of PENALTY_PATH_PREFIXES) {
    if (file.path.startsWith(prefix)) {
      if (prefix === "docs/" && wantsDocs) continue;
      score *= factor;
      reasons.push(reason);
      break;
    }
  }

  // Every JSON key is a symbol, so a catalog of a few thousand keys matches
  // most requests on several words at once: five locales of one catalog held
  // ranks 8 to 12 of a request about date rollover logic, all at 140.
  if (file.kind === "translation" && !wantsCopy) {
    score *= TRANSLATION_DEMOTION;
    reasons.push(`translation catalog, demoted unless the request is about copy or translation (×${TRANSLATION_DEMOTION})`);
  }

  if (OWNER_KINDS.has(file.kind)) {
    score *= 1.15;
    reasons.push(`owner kind ${file.kind}, slight boost`);
  }

  return { score, reasons };
}

/**
 * Per-query-term document frequency across the indexed repo. Used only as an
 * IDF-style dampener on scoreFile's path/symbol/export/import/route matches:
 * a query term that shows up in a large share of the repo (a generic domain
 * noun such as "ticket" or "check" shared by several unrelated modules)
 * carries far less evidentiary weight than one that appears in a handful of
 * files. Ported from context-engine.js's computeTokenDocFrequency, which
 * impact.js never had — without it, a file whose path, exports, imports,
 * symbols, and route all happen to repeat one generic query word stacks that
 * one weak signal five times over and can out-rank the real, narrower owner.
 * @typedef {{ totalFiles: number, docFreq: Map<string, number> }} TokenDocFrequency
 */

/**
 * @param {CodeMapFile[]} files
 * @param {Map<string, number>} weightedQuery
 * @returns {TokenDocFrequency}
 */
export function computeTokenDocFrequency(files, weightedQuery) {
  /** @type {Map<string, number>} */
  const docFreq = new Map();
  const terms = [...weightedQuery.keys()];
  if (!terms.length) {
    return { totalFiles: files.length, docFreq };
  }

  for (const file of files) {
    const text = [
      file.path,
      file.kind,
      file.domain,
      file.route ?? "",
      file.controllerBasePath ?? "",
      (file.exports ?? []).join(" "),
      (file.imports ?? []).join(" "),
      file.symbols.map((symbol) => symbol.name ?? "").join(" "),
    ].join(" ");
    const fileTokens = new Set(tokenize(text));
    for (const term of terms) {
      if (fileTokens.has(term)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return { totalFiles: files.length, docFreq };
}

/**
 * IDF-style multiplier for one query term's contribution to a file's score.
 * Below a minimum repo size the signal is too noisy to trust (small repos and
 * test fixtures), so every term is treated as neutral — matches
 * context-engine.js's tokenWeightFactor exactly, including the thresholds.
 * @param {string} term
 * @param {TokenDocFrequency} [stats]
 * @returns {number}
 */
export function tokenWeightFactor(term, stats) {
  if (!stats || stats.totalFiles < 12) {
    return 1;
  }
  const df = stats.docFreq.get(term) ?? 0;
  if (df === 0) {
    return 1;
  }
  const ratio = df / stats.totalFiles;
  if (ratio <= 0.02) return 1.4;
  if (ratio <= 0.06) return 1;
  if (ratio <= 0.15) return 0.55;
  return 0.2;
}

// Demotion factor for a file that matches none of the query's concepts.
// One concept → 0.5 (a confident single signal; matches the original behavior
// and the ranking the existing tests assert). Each additional detected concept
// softens the penalty by 0.15, capped at 0.8 so a multi-concept (and therefore
// noisier) query can never erase an otherwise strong path/symbol match.
/**
 * @param {number} conceptCount
 * @returns {number}
 */
function conceptDemotionFactor(conceptCount) {
  if (conceptCount <= 1) return 0.5;
  return Math.min(0.8, 0.5 + 0.15 * (conceptCount - 1));
}

// A file "implies" a concept if either (a) its path classifies as that
// concept, or (b) its symbols/imports/exports contain a synonym for that
// concept. (b) is what catches booking.controller.ts as money-flow-adjacent
// even though its path is "src/booking/...".
/**
 * @param {CodeMapFile} file
 * @param {string[]} concepts
 * @returns {Set<string>}
 */
function fileImpliesConcepts(file, concepts) {
  /** @type {Set<string>} */
  const implied = new Set();
  const pathFlags = new Set(classifyPath(file.path, { kind: file.kind }));
  for (const concept of concepts) {
    if (pathFlags.has(concept)) implied.add(concept);
  }
  if (implied.size === concepts.length) return implied;
  const haystack = [
    ...(file.symbols ?? []).map((s) => (s.name ?? "").toLowerCase()),
    ...(file.imports ?? []).map((i) => i.toLowerCase()),
    ...(file.exports ?? []).map((e) => e.toLowerCase()),
  ];
  if (haystack.length === 0) return implied;
  for (const concept of concepts) {
    if (implied.has(concept)) continue;
    const synonyms = CONCEPT_SYNONYMS[concept] ?? [];
    for (const synonym of synonyms) {
      if (haystack.some((token) => token === synonym || token.includes(synonym))) {
        implied.add(concept);
        break;
      }
    }
  }
  return implied;
}

/**
 * Make sure every named file has an entry, whatever its word overlap, and add
 * the bonus for a named symbol's other definitions.
 * @param {Map<string, ScoredEntry>} scored
 * @param {CodeMapFile[]} files
 * @param {Map<string, PinnedFile>} pinned
 * @param {import('./ranking-rules.js').NamedFile[]} definers
 */
function addNamedFiles(scored, files, pinned, definers) {
  if (pinned.size === 0 && definers.length === 0) return;
  const byPath = new Map(files.map((file) => [file.path, file]));
  /** @param {string} filePath @returns {ScoredEntry | undefined} */
  const entryFor = (filePath) => {
    const file = byPath.get(filePath);
    if (!file) return undefined;
    const entry = scored.get(filePath) ?? { file, score: 0, reasons: [], relatedFiles: [] };
    scored.set(filePath, entry);
    return entry;
  };
  for (const filePath of pinned.keys()) entryFor(filePath);
  for (const definer of definers) {
    const entry = entryFor(definer.path);
    if (!entry) continue;
    entry.score += W_NAMED_DEFINER;
    const where = definer.line ? ` (line ${definer.line})` : "";
    const use = definer.exported ? "exported, imported by no other file" : "a local definition";
    entry.reasons.push(`defines \`${definer.literal}\`${where}, named in the request; ${use} (+${W_NAMED_DEFINER.toFixed(1)})`);
  }
}

/**
 * Put each named file above every candidate the request did not name, keeping
 * the named files in order among themselves. A literal reference is the one
 * signal no amount of word overlap should outrank: the recorded request named
 * `event-service.ts` and the file ranked 40th.
 * @param {Map<string, ScoredEntry>} scored
 * @param {Map<string, PinnedFile>} pinned
 */
function liftPinnedFiles(scored, pinned) {
  if (pinned.size === 0) return;
  let ceiling = 0;
  for (const entry of scored.values()) {
    if (!pinned.has(entry.file.path)) ceiling = Math.max(ceiling, entry.score);
  }
  for (const [filePath, pin] of pinned) {
    const entry = scored.get(filePath);
    if (!entry) continue;
    const lifted = Math.max(entry.score, ceiling) + PIN_MARGIN[pin.rule];
    const lift = `pinned above unnamed candidates (+${(lifted - entry.score).toFixed(1)})`;
    entry.reasons.push(
      pin.rule === "path"
        ? `named in the request as \`${pin.literal}\`, ${lift}`
        : pin.rule === "implements"
          ? `implements \`${pin.literal}\`, named in the request and registered in \`${pin.via}\`, ${lift}`
          : `defines \`${pin.literal}\`${pin.line ? ` (line ${pin.line})` : ""}, named in the request; exported and imported by ${pin.importers} file(s), ${lift}`,
    );
    entry.score = lifted;
  }
}

/** @param {ScoredEntry} entry */
function describeEntry(entry) {
  return { path: entry.file.path, kind: entry.file.kind };
}

/**
 * Say which locale files an entry stands for, once the list is final.
 * @param {ScoredEntry[]} ranked
 */
function noteLocaleSiblings(ranked) {
  const visible = new Set(ranked.map((entry) => entry.file.path));
  for (const entry of ranked) {
    if (!entry.siblings) continue;
    entry.siblings = entry.siblings.filter((sibling) => !visible.has(sibling)).sort();
    if (entry.siblings.length)
      entry.reasons.push(`locale catalog, also stands for ${formatLocales(entry.siblings)} (${entry.siblings.length} sibling file(s))`);
  }
}

/**
 * @param {CodeMapFile[]} allFiles
 * @param {Map<string, ScoredEntry>} scored
 * @param {Map<string, PinnedFile>} [pinned] named files seed their imports at full weight, whatever their own score
 * @returns {Map<string, ScoredEntry>}
 */
function applyDependencyBoosts(allFiles, scored, pinned = new Map()) {
  if (scored.size === 0) return scored;
  const byPath = new Map(allFiles.map((file) => [file.path, file]));
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const seeds = [...new Set([...ranked.slice(0, 15), ...ranked.filter((entry) => pinned.has(entry.file.path))])];
  const resolve = makeImportResolver(allFiles);

  for (const seed of seeds) {
    const base = pinned.has(seed.file.path) ? 8.0 : Math.min(seed.score * 0.16, 8.0);
    /** @type {Set<string>} */
    const neighbors = new Set();
    for (const importPath of seed.file.imports ?? []) {
      for (const resolved of resolve(importPath, seed.file.path)) {
        if (resolved !== seed.file.path) neighbors.add(resolved);
      }
    }
    for (const neighbor of neighbors) {
      const existing = scored.get(neighbor);
      if (existing) {
        existing.score += base;
        existing.reasons.push(`related through imports (+${base.toFixed(1)})`);
        existing.relatedFiles.push(seed.file.path);
        seed.relatedFiles.push(neighbor);
      } else if (byPath.has(neighbor)) {
        scored.set(neighbor, {
          file: /** @type {CodeMapFile} */ (byPath.get(neighbor)),
          score: base,
          reasons: [`related through imports from ${seed.file.path} (+${base.toFixed(1)})`],
          relatedFiles: [seed.file.path],
        });
        seed.relatedFiles.push(neighbor);
      }
    }
  }

  // Keep the eight most relevant neighbours, not the first eight imports: a
  // controller that imports forty services listed affiliates and analytics
  // ahead of its own service, and they became "supporting" fan-out.
  const relevance = (/** @type {string} */ related) => scored.get(related)?.score ?? 0;
  for (const entry of scored.values()) {
    entry.relatedFiles = [...new Set(entry.relatedFiles)].sort((a, b) => relevance(b) - relevance(a)).slice(0, 8);
  }
  return scored;
}

/**
 * @param {CodeMapFile[]} files
 * @returns {(importSpec: string, fromPath: string) => string[]}
 */
function makeImportResolver(files) {
  /** @type {Map<string, string[]>} */
  const byBasename = new Map();
  /** @type {Map<string, string[]>} */
  const byStem = new Map();
  for (const file of files) {
    const base = path.basename(file.path);
    const stem = base.replace(/\.[^.]+$/, "");
    pushTo(byBasename, base, file.path);
    pushTo(byStem, stem, file.path);
  }
  return (/** @type {string} */ importSpec, /** @type {string} */ fromPath) => {
    /** @type {Set<string>} */
    const candidates = new Set();
    if (importSpec.startsWith(".")) {
      const base = path.posix.dirname(fromPath);
      const joined = path.posix.normalize(`${base}/${importSpec}`);
      for (const file of files) {
        if (file.path === joined || file.path.startsWith(`${joined}/`) || file.path.startsWith(joined.replace(/\/[^/]+$/, "/"))) {
          candidates.add(file.path);
        }
        const stem = file.path.replace(/\.[^.]+$/, "");
        if (stem === joined || stem === `${joined}/index`) {
          candidates.add(file.path);
        }
      }
    } else {
      const tail = importSpec.split("/").pop() ?? "";
      const stem = tail.replace(/\.[^.]+$/, "");
      (byBasename.get(tail) ?? []).forEach((p) => candidates.add(p));
      (byStem.get(stem) ?? []).forEach((p) => candidates.add(p));
    }
    return [...candidates].slice(0, 5);
  };
}

/**
 * @param {CodeMapFile[]} files
 * @param {ScoredEntry[]} ranked
 * @param {CodeMapRepo} repo
 * @returns {string[]}
 */
function suggestTests(files, ranked, repo) {
  /** @type {string[]} */
  const suggestions = [];
  /** @type {Record<string, string>} */
  const scripts = /** @type {any} */ (repo.package)?.scripts ?? {};
  for (const name of ["test", "test:unit", "test:integration", "test:e2e", "lint", "typecheck"]) {
    if (scripts[name]) {
      suggestions.push(`Run package script \`${name}\`: ${scripts[name]}`);
    }
  }

  /** @type {Set<string>} */
  const topTerms = new Set();
  for (const entry of ranked) {
    for (const token of tokenize(entry.file.path)) topTerms.add(token);
    for (const symbol of entry.file.symbols.slice(0, 20)) for (const token of tokenize(symbol.name ?? "")) topTerms.add(token);
  }
  const meaningfulTerms = new Set([...topTerms].filter((term) => term.length > 2 && !TEST_MATCH_STOP_TERMS.has(term)));

  // A README or a snapshot under __tests__/ is not something to run.
  const testFiles = files.filter((file) => file.kind === "test" && isRunnableTestPath(file.path));
  /** @type {{ overlap: number, path: string }[]} */
  const matches = [];
  for (const testFile of testFiles) {
    const terms = new Set([...tokenize(testFile.path)].filter((t) => t.length > 2 && !TEST_MATCH_STOP_TERMS.has(t)));
    let overlap = 0;
    for (const term of terms) if (meaningfulTerms.has(term)) overlap += 1;
    if (overlap > 0) matches.push({ overlap, path: testFile.path });
  }
  matches.sort((a, b) => b.overlap - a.overlap);
  for (const match of matches.slice(0, 8)) {
    suggestions.push(`Inspect or run related test \`${match.path}\``);
  }

  if (suggestions.length === 0) {
    suggestions.push("No matching test file found. Add focused coverage around the highest-ranked impacted file.");
  }
  return dedupe(suggestions);
}

/**
 * @param {string} query
 * @param {ScoredEntry[]} ranked
 * @param {string[]} concepts
 * @returns {string[]}
 */
function identifyRisks(query, ranked, concepts) {
  const flags = new Set(concepts);
  for (const entry of ranked) {
    // A plan that mentions Stripe or a golden fixture of fee answers is not a
    // money-flow change; the code they describe is.
    if (isDocPath(entry.file.path) || isTestDataPath(entry.file.path)) continue;
    for (const flag of classifyPath(entry.file.path, { kind: entry.file.kind })) {
      flags.add(flag);
    }
  }
  if (flags.size === 0) {
    return ["No obvious high-risk domain detected. Main risk is missing a caller or test outside the matched files."];
  }
  return [...flags].map(riskSentence);
}

/**
 * @param {string} flag
 * @returns {string}
 */
function riskSentence(flag) {
  switch (flag) {
    case RISK_FLAGS.authSecurity:
      return "Auth/security change: verify permissions, redirects, sessions, and unauthorized states.";
    case RISK_FLAGS.moneyFlow:
      return "Money-flow change: verify idempotency, webhook behavior, refunds, invoices, and provider edge cases.";
    case RISK_FLAGS.dataModel:
      return "Data-model change: check migrations, seed data, rollback behavior, and query compatibility.";
    case RISK_FLAGS.requestSurface:
      return "Request-surface change: verify request/response shape, validation, client consumers, and backward compatibility.";
    case RISK_FLAGS.contract:
      return "Frontend/backend contract change: verify the client and server agree on payload, status codes, and error shapes.";
    case RISK_FLAGS.configuration:
      return "Configuration change: verify environment variables, secrets, build output, and production defaults.";
    case RISK_FLAGS.dependency:
      return "Dependency change: check the lockfile diff for unexpected transitive bumps and confirm the build and audit still pass.";
    case RISK_FLAGS.largeFileDiff:
      return "Large-file change: review for unrelated edits and consider splitting follow-up PRs.";
    case RISK_FLAGS.secret:
      return "Secret-path change: confirm the file is not committed with real values and rotate any exposed credentials.";
    default:
      return `${flag} change: review related downstream consumers and tests.`;
  }
}

/**
 * Capture the changed-file subject once before it is used for both evidence and
 * validation. Supplied diff files come from an immutable Git subject in the
 * convergence path; direct CLI use captures the current diff plus untracked
 * user files unless `includeUntracked` is false.
 * @param {string} root
 * @param {string | undefined} base
 * @param {string[] | undefined} suppliedFiles
 * @param {boolean} includeUntracked
 */
function captureDiffSnapshot(root, base, suppliedFiles, includeUntracked) {
  if (Array.isArray(suppliedFiles)) {
    return { base: base ?? "", ok: true, files: normalizeChangedFiles(suppliedFiles) };
  }
  if (!base) {
    return null;
  }

  // Resolve user input before passing it to `git diff`. The resolved value is
  // a hex object ID, so a ref beginning with `-` cannot be parsed as an option.
  const resolved = runCommand("git", ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { cwd: root });
  if (!resolved.ok || !resolved.stdout.trim()) {
    const message = (resolved.stderr || resolved.error?.message || "command failed").trim();
    return {
      base,
      ok: false,
      error: `git diff failed: could not resolve base ref: ${message}`,
    };
  }
  const result = runCommand(
    "git",
    [
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--diff-algorithm=myers",
      "--find-renames=50%",
      `-l${DIFF_RENAME_LIMIT}`,
      "--name-only",
      "-z",
      resolved.stdout.trim(),
      "--",
    ],
    { cwd: root },
  );
  if (!result.ok) {
    const message = (result.stderr || result.error?.message || "command failed").trim();
    return {
      base,
      ok: false,
      error: `git diff failed: ${message}`,
    };
  }
  if (!includeUntracked) {
    return { base, ok: true, files: normalizeChangedFiles(result.stdout.split("\0")) };
  }
  const untracked = runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
  if (!untracked.ok) {
    const message = (untracked.stderr || untracked.error?.message || "command failed").trim();
    return {
      base,
      ok: false,
      error: `git ls-files failed: ${message}`,
    };
  }

  return {
    base,
    ok: true,
    files: normalizeChangedFiles([...result.stdout.split("\0"), ...untracked.stdout.split("\0")]),
  };
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
function normalizeChangedFiles(files) {
  return [...new Set(files.map(String).filter(Boolean))].sort();
}

/**
 * Build exact changed-file entries. A file absent from the code map can be a
 * deletion, a binary, or an unsupported file type; keep it visible separately
 * instead of pretending the map knows its owner.
 * @param {string[]} files
 * @param {CodeMapFile[]} allFiles
 * @param {Map<string, ScoredEntry>} scored
 * @param {string} base
 */
function buildDiffEvidence(files, allFiles, scored, base) {
  const byPath = new Map(allFiles.map((file) => [file.path, file]));
  /** @type {ScoredEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const unmappedFiles = [];
  for (const filePath of files) {
    const file = byPath.get(filePath);
    if (!file) {
      unmappedFiles.push(filePath);
      continue;
    }
    const candidate = scored.get(filePath);
    entries.push({
      file,
      score: candidate?.score ?? 0,
      reasons: [...(candidate?.reasons ?? []), `exact Git diff evidence against ${base}`],
      relatedFiles: candidate?.relatedFiles ?? [],
    });
  }
  return { base, files, entries, unmappedFiles };
}

/**
 * @param {ScoredEntry[]} evidence
 * @param {ScoredEntry[]} heuristic
 * @returns {ScoredEntry[]}
 */
function mergeDiffEvidence(evidence, heuristic) {
  const changed = new Map(evidence.map((entry) => [entry.file.path, entry]));
  for (const entry of heuristic) {
    // A changed catalog keeps the locale siblings its ranked entry stood for.
    const exact = changed.get(entry.file.path);
    if (exact && entry.siblings?.length) exact.siblings = [...entry.siblings];
  }
  // Changed files lead, ranked by their own score: the diff decides which files
  // surface, not their order, so a score-0 dotfile cannot head the list.
  const byScore = [...evidence].sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return [...byScore, ...heuristic.filter((entry) => !changed.has(entry.file.path))];
}

/**
 * Separate the small set of files predicted to own the implementation from
 * expected fan-out and broader inspection leads. Only required owners lower
 * convergence coverage when they are untouched; support files are accepted
 * when changed, while advisory files are deliberately non-load-bearing.
 * @param {ScoredEntry[]} heuristicRanked
 * @param {CodeMapFile[]} allFiles
 * @param {string} query
 * @param {Map<string, PinnedFile>} [pinned] files the request names; each is a required owner, whatever its kind
 */
function classifyImpactRoles(heuristicRanked, allFiles, query, pinned = new Map()) {
  /** @type {Map<string, "required" | "supporting" | "advisory">} */
  const byPath = new Map();
  const terms = new Set([...tokenize(query), ...weightedQueryTerms(query).keys()]);
  const requestBoundaryChange = ["api", "endpoint", "form", "payload", "request", "route", "submit"].some((term) => terms.has(term));
  const skillChange = SKILL_REQUEST_TERMS.some((term) => terms.has(term));
  const docsChange = ["doc", "docs", "documentation", "readme", "guide", "changelog"].some((term) => terms.has(term));
  /** @param {string} kind */
  const intentGatedOwnerAllowed = (kind) => (kind === "skill" ? skillChange : docsChange);
  // The owners the ranking infers are chosen among the files the request did
  // not name, on their own scores: a pinned file's lifted score would
  // otherwise raise the bar every inferred owner has to clear.
  const unnamed = heuristicRanked.filter((entry) => !pinned.has(entry.file.path));
  const directCandidates = unnamed
    .filter((entry) => OWNER_KINDS.has(entry.file.kind) && hasDirectIntentMatch(entry))
    .filter((entry) => requestBoundaryChange || !REQUEST_BOUNDARY_KINDS.has(entry.file.kind))
    .filter((entry) => !INTENT_GATED_OWNER_KINDS.has(entry.file.kind) || intentGatedOwnerAllowed(entry.file.kind));
  // A rendered template is a real part of the behavior, but when a specific
  // implementation owner is already known it is supporting evidence rather
  // than an additional required owner. This avoids making every similarly
  // named layout a coverage obligation.
  const nonTemplateCandidates = directCandidates.filter((entry) => entry.file.kind !== "template");
  const conventionalPool = nonTemplateCandidates.length ? nonTemplateCandidates : directCandidates;
  // genericOwnerFallback exists so a repo with no conventional owner kind at
  // all (a library, a CLI, mostly `source`/`hook` files) can still ground a
  // task. But gating it entirely behind "no conventional owner kind matched"
  // means that once ANY controller/dto/component scores at all — even one
  // that only shares a generic word with the request — a genuinely stronger
  // `*.util.ts` owner can never be promoted to required, because it is never
  // even considered. Recorded gap: a fix that actually lived in
  // ticket-qr.util.ts (kind "source") scored higher than every conventional
  // candidate, but stayed advisory because organizer-ticket-sales.controller.ts
  // (kind "controller") also matched. Merge the strong generic candidates in
  // alongside the conventional ones instead of treating them as a fallback of
  // last resort, so they compete on score like everything else.
  const ownerPool = conventionalPool.length ? mergeOwnerCandidates(conventionalPool, genericOwnerFallback(unnamed)) : genericOwnerFallback(unnamed);
  const strongestScore = ownerPool[0]?.score ?? 0;
  const directOwners = [
    ...heuristicRanked.filter((entry) => pinned.has(entry.file.path)).map((entry) => entry.file.path),
    ...ownerPool
      .filter((entry) => entry.score >= strongestScore * REQUIRED_OWNER_SCORE_RATIO)
      .slice(0, 3)
      .map((entry) => entry.file.path),
  ];
  // Words alone left the request without an owner. The import graph can still
  // settle it, and what it says is a fact about the repository, not overlap.
  if (directOwners.length === 0) {
    for (const { entry, reason } of graphAnchoredOwners(unnamed, allFiles, terms)) {
      entry.reasons.push(reason);
      directOwners.push(entry.file.path);
    }
  }
  for (const file of directOwners) byPath.set(file, "required");

  // `weightedQueryTerms` carries singular forms, so a request for
  // "templates" receives the same artifact handling as "template".
  const templateFlow = ["email", "template", "handlebars", "layout", "partial", "preview", "branding", "campaign", "audience", "newsletter"].some((term) =>
    terms.has(term),
  );
  const featureFlagFlow = terms.has("feature") && (terms.has("flag") || terms.has("flags"));
  const releaseFlow = ["release", "changelog", "version"].some((term) => terms.has(term));
  for (const file of allFiles) {
    const role = predictableRole(file, { templateFlow, featureFlagFlow, releaseFlow, terms });
    if (!role || byPath.has(file.path)) continue;
    byPath.set(file.path, "supporting");
  }

  // An import-neighbour of a required owner is expected fan-out, but it still
  // remains visible in the ranked output. This is deliberately narrower than
  // treating every file in a domain as supporting.
  const byRankedPath = new Map(heuristicRanked.map((entry) => [entry.file.path, entry]));
  const knownPaths = new Set(allFiles.map((file) => file.path));
  for (const owner of directOwners) {
    for (const related of byRankedPath.get(owner)?.relatedFiles ?? []) {
      if (knownPaths.has(related) && !byPath.has(related)) byPath.set(related, "supporting");
    }
  }
  if (releaseFlow) byPath.set("package.json", "supporting");

  for (const entry of heuristicRanked) {
    if (!byPath.has(entry.file.path)) byPath.set(entry.file.path, "advisory");
  }
  // A locale folded into its catalog's entry takes that entry's role, so a
  // change to it is read against the prediction and not as drift. The other
  // locales of a required catalog are its expected fan-out.
  for (const entry of heuristicRanked) {
    const role = byPath.get(entry.file.path);
    for (const sibling of entry.siblings ?? []) {
      if (!byPath.has(sibling)) byPath.set(sibling, role === "required" ? "supporting" : (role ?? "advisory"));
    }
  }
  const requiredOwners = [...byPath.entries()]
    .filter(([, role]) => role === "required")
    .map(([file]) => file)
    .sort();
  const supportingFiles = [...byPath.entries()]
    .filter(([, role]) => role === "supporting")
    .map(([file]) => file)
    .sort();
  const advisoryFiles = [...byPath.entries()]
    .filter(([, role]) => role === "advisory")
    .map(([file]) => file)
    .sort();
  return { byPath, requiredOwners, supportingFiles, advisoryFiles };
}

/**
 * Owner candidates for implementation files that do not carry a conventional
 * owner kind (libraries, CLIs, most `kind: "source"` code). Used both as the
 * sole pool when no conventional owner kind matched at all, and merged
 * alongside conventional candidates otherwise (see classifyImpactRoles) so a
 * strong `*.util.ts`-style owner can still compete on score.
 *
 * @param {ScoredEntry[]} heuristicRanked
 * @returns {ScoredEntry[]}
 */
function genericOwnerFallback(heuristicRanked) {
  const candidates = heuristicRanked.filter(
    (entry) => !NEVER_OWNER_KINDS.has(entry.file.kind) && !isTestFilePath(entry.file.path) && !isDocPath(entry.file.path) && hasDirectIntentMatch(entry),
  );
  if ((candidates[0]?.score ?? 0) < FALLBACK_OWNER_MIN_SCORE) return [];
  return candidates;
}

// Words that say what to do or name code in general, never a module: a file
// called `test.js` or `index.js` is not what "test the index" asks about.
const GRAPH_ANCHOR_STOP_TERMS = new Set([
  ...["app", "build", "check", "clean", "cleanup", "code", "create", "delete", "disable", "enable", "file", "files", "function", "handle", "implement"],
  ...["improve", "index", "lib", "list", "load", "logic", "main", "method", "mod", "module", "move", "read", "refactor", "replace", "run", "save", "send"],
  ...["set", "show", "simplify", "spec", "src", "support", "test", "tests", "tidy", "type", "types", "write"],
]);

/**
 * Owners the import graph names when no candidate's lexical score does.
 *
 * A file is anchored when a word of the request is its name (`util` for
 * `src/lib/util.js`) or a symbol it exports (`greet`), no other source file
 * shares that name or export, and it has at least one import edge, so it is a
 * module the repository actually uses and not a stray file. Candidates are
 * ordered by how many files import them; the lexical score only breaks ties.
 * @param {ScoredEntry[]} ranked
 * @param {CodeMapFile[]} allFiles
 * @param {Set<string>} terms
 * @returns {{ entry: ScoredEntry, reason: string }[]}
 */
function graphAnchoredOwners(ranked, allFiles, terms) {
  const anchors = [...terms].filter((term) => term.length >= 3 && !GRAPH_ANCHOR_STOP_TERMS.has(term));
  if (anchors.length === 0) return [];
  const candidates = allFiles.filter((file) => !file.isVendor && !NEVER_OWNER_KINDS.has(file.kind) && !isTestFilePath(file.path) && !isDocPath(file.path));
  /** @type {Map<string, Set<string>>} */
  const byStem = new Map();
  /** @type {Map<string, Set<string>>} */
  const byExport = new Map();
  /** @param {Map<string, Set<string>>} index @param {string} key @param {string} filePath */
  const note = (index, key, filePath) => index.set(key, (index.get(key) ?? new Set()).add(filePath));
  for (const file of candidates) {
    note(byStem, path.posix.basename(file.path).split(".")[0].toLowerCase(), file.path);
    for (const name of file.exports ?? []) note(byExport, String(name).toLowerCase(), file.path);
  }

  const degrees = importDegrees(allFiles);
  const rankedByPath = new Map(ranked.map((entry) => [entry.file.path, entry]));
  /** @type {Map<string, { entry: ScoredEntry, importers: number, reason: string }>} */
  const found = new Map();
  for (const term of anchors) {
    for (const [index, what] of /** @type {[Map<string, Set<string>>, string][]} */ ([
      [byStem, "the only source file named"],
      [byExport, "the only source file that exports"],
    ])) {
      const files = index.get(term);
      if (files?.size !== 1) continue;
      const [filePath] = files;
      const entry = rankedByPath.get(filePath);
      const importers = degrees.importers.get(filePath) ?? 0;
      const imports = degrees.imports.get(filePath) ?? 0;
      if (!entry || found.has(filePath) || importers + imports === 0) continue;
      const edges = importers > 0 ? `imported by ${importers} file(s)` : `importing ${imports} file(s)`;
      found.set(filePath, { entry, importers, reason: `grounded in the import graph: ${what} \`${term}\`, a word in the request; ${edges}` });
    }
  }
  return [...found.values()]
    .sort((a, b) => b.importers - a.importers || b.entry.score - a.entry.score || a.entry.file.path.localeCompare(b.entry.file.path))
    .slice(0, 3);
}

/**
 * Combine conventional and generic-fallback owner candidates into one
 * score-descending pool, keeping each file's higher-scored appearance when it
 * shows up in both (a conventional owner kind is also eligible for
 * genericOwnerFallback if it matches the intent terms directly).
 * @param {ScoredEntry[]} primary
 * @param {ScoredEntry[]} fallback
 * @returns {ScoredEntry[]}
 */
function mergeOwnerCandidates(primary, fallback) {
  if (!fallback.length) return primary;
  const byPath = new Map(primary.map((entry) => [entry.file.path, entry]));
  for (const entry of fallback) {
    const existing = byPath.get(entry.file.path);
    if (!existing || entry.score > existing.score) byPath.set(entry.file.path, entry);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score);
}

/** @param {ScoredEntry} entry */
function hasDirectIntentMatch(entry) {
  return entry.reasons.some((reason) => /^(path|symbol|export|route) matches:/.test(reason));
}

/** @param {CodeMapFile} file @param {{ templateFlow: boolean, featureFlagFlow: boolean, releaseFlow: boolean, terms: Set<string> }} options */
function predictableRole(file, options) {
  // A template with an exact lexical match is already a required owner above.
  // Other templates (layouts, partials) are predictable supporting fan-out:
  // they matter to scope, but an untouched adjacent template must not reduce
  // coverage.
  if (options.templateFlow && file.kind === "template") return "support";
  if (options.templateFlow && file.kind === "translation") return "support";
  if (options.featureFlagFlow && (file.kind === "config" || /feature[-_]?flags?/i.test(file.path))) return "support";
  if (options.templateFlow && file.kind === "test" && matchesIntentTerms(file.path, options.terms)) return "support";
  if (options.releaseFlow && file.kind === "changelog") return "support";
  return null;
}

/**
 * Supporting tests must share a meaningful task term. A generic snapshot or
 * preview test in a neighbouring domain is still worth inspecting, but it is
 * not evidence that this change's fan-out was anticipated.
 * @param {string} filePath
 * @param {Set<string>} terms
 */
function matchesIntentTerms(filePath, terms) {
  const ignored = new Set(["add", "change", "email", "test", "tests", "template", "templates", "preview", "focused", "update"]);
  return tokenize(filePath).some((term) => term.length > 2 && !ignored.has(term) && terms.has(term));
}

/**
 * Keep expected fan-out visible even when it lacks lexical overlap with the
 * request (for example `locales/en.json` beside an email template). These
 * entries are labelled supporting and never become convergence owners.
 * @param {ScoredEntry[]} ranked
 * @param {CodeMapFile[]} allFiles
 * @param {{ byPath: Map<string, string> }} roles
 * @param {(entry: ScoredEntry) => boolean} isPinned entries a locale catalog must not fold away
 */
function addPredictableSupportFiles(ranked, allFiles, roles, isPinned) {
  const existing = new Set(ranked.flatMap((entry) => [entry.file.path, ...(entry.siblings ?? [])]));
  const baseline = ranked[0]?.score ?? 1;
  const additions = allFiles
    .filter((file) => !existing.has(file.path) && roles.byPath.get(file.path) && roles.byPath.get(file.path) !== "advisory")
    .map((file) => ({
      file,
      score: Math.max(1, baseline * 0.2),
      reasons: [`predictable ${roles.byPath.get(file.path)} fan-out`],
      relatedFiles: [],
    }));
  // One pass over the whole list: an exact changed catalog, a ranked one and
  // the locales added as fan-out all fold into one entry per catalog.
  const kept = new Set(ranked);
  let added = 0;
  return collapseLocaleSiblings([...ranked, ...additions], describeEntry, isPinned).filter((entry) => kept.has(entry) || added++ < 12);
}

/**
 * Compare role-labelled candidates with the exact changed-file subject. Exact
 * diff evidence remains visible, but cannot turn an unexplained change into a
 * successful prediction.
 * @param {string} base
 * @param {string[]} files
 * @param {{ requiredOwners: string[], supportingFiles: string[], advisoryFiles: string[] }} roles
 */
function validateChangedFiles(base, files, roles) {
  const changedFiles = normalizeChangedFiles(files);

  const predictedDirect = new Set(roles.requiredOwners);
  const predictedRelated = new Set(roles.supportingFiles);

  const confirmedDirect = changedFiles.filter((file) => predictedDirect.has(file));
  const confirmedRelated = changedFiles.filter((file) => !predictedDirect.has(file) && predictedRelated.has(file));
  const unconfirmedCandidates = [...predictedDirect].filter((file) => !changedFiles.includes(file));
  const advisory = new Set(roles.advisoryFiles);
  // Changed files that were ranked, but only as non-load-bearing advisory
  // leads. They are neither a confirmed prediction nor an unexplained change,
  // and reporting them separately is what keeps a `missed` verdict readable:
  // without this bucket a run can report "missed" while `missedChangedFiles`
  // is empty, which reads as a contradiction rather than as "ranked, but never
  // promoted to an owner".
  const advisoryChangedFiles = changedFiles.filter((file) => !predictedDirect.has(file) && !predictedRelated.has(file) && advisory.has(file));
  const missedChangedFiles = changedFiles.filter((file) => !predictedDirect.has(file) && !predictedRelated.has(file) && !advisory.has(file));

  let verdict = "partial";
  if (confirmedDirect.length && missedChangedFiles.length === 0) verdict = "confirmed";
  else if (confirmedDirect.length === 0 && confirmedRelated.length === 0) verdict = "missed";

  return {
    base,
    ok: true,
    changedFiles,
    confirmedDirect,
    confirmedRelated,
    unconfirmedCandidates,
    missedChangedFiles,
    advisoryChangedFiles,
    verdict,
    heuristic: {
      confirmedDirect: confirmedDirect,
      confirmedRelated: confirmedRelated,
      missedChangedFiles,
    },
  };
}

/**
 * @param {ReturnType<typeof generateImpact>['data']} data
 * @returns {string}
 */
export function formatImpactMarkdown(data) {
  const lines = [
    `# Change Impact: ${data.query}`,
    "",
    `Generated: ${data.generatedAt}`,
    `Impact engine version: ${data.impactEngineVersion}`,
    "",
    "## Repo",
    "",
    `- ${data.repo.name}: ${data.repo.root} (${data.repo.sourceFileCount} source file(s))`,
    `- Inferred concepts: ${data.concepts.join(", ") || "none"}`,
    "",
  ];
  if (data.diffEvidence) {
    lines.push("## Exact Changed-File Evidence", "");
    lines.push(`- Base: ${data.diffEvidence.base}`);
    lines.push(`- Mapped changed files: ${formatList(data.diffEvidence.mappedFiles)}`);
    lines.push(`- Unmapped changed files: ${formatList(data.diffEvidence.unmappedFiles)}`);
    lines.push("");
  }
  lines.push("## Top Impacted Files", "");
  for (const [index, file] of data.topFiles.entries()) {
    const rank = index + 1;
    lines.push(`### ${rank}. \`${file.path}\``);
    lines.push("");
    lines.push(`- Kind: ${file.kind} · domain: ${file.domain}`);
    lines.push(`- Role: ${file.role}`);
    lines.push(`- Score: ${file.score}`);
    if (file.riskFlags.length) lines.push(`- Risk flags: ${file.riskFlags.join(", ")}`);
    for (const reason of file.reasons) lines.push(`- ${reason}`);
    if (file.relatedFiles.length) lines.push(`- Related: ${file.relatedFiles.map((/** @type {string} */ r) => `\`${r}\``).join(", ")}`);
    lines.push("");
  }
  lines.push("## Impact Roles", "");
  lines.push(`- Required owners: ${formatList(data.classifications.requiredOwners)}`);
  lines.push(`- Predictable supporting files: ${formatList(data.classifications.supportingFiles)}`);
  lines.push(`- Worth inspecting: ${formatList(data.classifications.advisoryFiles)}`);
  lines.push("## Tests To Run Or Add", "");
  for (const suggestion of data.testSuggestions) lines.push(`- ${suggestion}`);
  lines.push("", "## Risks To Check", "");
  for (const risk of data.risks) lines.push(`- ${risk}`);
  if (data.companions) {
    lines.push("", "## Companion Repository Leads", "");
    for (const companion of data.companions) lines.push(`- ${companion.repo}: ${formatCompanionFiles(companion)}`);
  }
  if (data.validation) {
    lines.push("", "## Validation Against Diff", "");
    lines.push(`- Base: ${data.validation.base}`);
    if (!data.validation.ok) {
      lines.push(`- Error: ${data.validation.error}`);
    } else {
      lines.push(`- Verdict: ${data.validation.verdict}`);
      lines.push(`- Confirmed direct: ${formatList(data.validation.confirmedDirect)}`);
      lines.push(`- Confirmed related: ${formatList(data.validation.confirmedRelated)}`);
      lines.push(`- Unconfirmed candidates: ${formatList(data.validation.unconfirmedCandidates)}`);
      lines.push(`- Unexplained changed files: ${formatList(data.validation.missedChangedFiles)}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function formatList(items) {
  return items.length ? items.map((item) => `\`${item}\``).join(", ") : "none";
}

/**
 * @param {CompanionLead} companion
 * @returns {string}
 */
function formatCompanionFiles(companion) {
  if (!companion.topFiles.length) return "no matching files";
  return companion.topFiles.map((file) => `\`${file.path}\` (score ${file.score}${file.riskFlags.length ? `, ${file.riskFlags.join(", ")}` : ""})`).join(", ");
}

// Tokenize a string into lowercased path/identifier tokens. Mirrors
// impact-map's tokenize/split_identifier behavior.
/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function tokenize(value) {
  const raw = String(value ?? "");
  /** @type {string[]} */
  const tokens = [];
  const chunks = raw.match(/[A-Za-z0-9_./:-]+/g) ?? [];
  for (const chunk of chunks) {
    const spaced = chunk.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    for (const part of spaced.split(/[^A-Za-z0-9]+/)) {
      if (!part) continue;
      const lower = part.toLowerCase();
      if (STOP_WORDS.has(lower)) continue;
      tokens.push(lower);
    }
  }
  return tokens;
}

/**
 * The words a request and a path can share: `tokenize`'s tokens, folded to
 * their singular, without bare numbers or single letters. `fees:` and
 * `fee-calculator.ts` meet on `fee`.
 * @param {unknown} value
 * @returns {string[]}
 */
export function scopeTokens(value) {
  const tokens = new Set();
  for (const token of tokenize(value)) {
    if (token.length < 2 || /^\d+$/.test(token)) continue;
    tokens.add(token.length > 4 ? singularizeToken(token) : token);
    tokens.add(singularizeToken(token));
  }
  return [...tokens];
}

/**
 * The words of a path a request can name: `scopeTokens` of the path without
 * its extension. `.ts` says what kind of file it is, not what it is about.
 * @param {string} file
 * @returns {string[]}
 */
export function pathScopeTokens(file) {
  const extension = path.posix.extname(file);
  return scopeTokens(extension ? file.slice(0, -extension.length) : file);
}

// Build the weighted query term counter. Longer / domain / repeated tokens
// get extra weight, and a soft singular form is added so "refunds" and
// "refund" both light up.
/**
 * @param {string} request
 * @returns {Map<string, number>}
 */
export function weightedQueryTerms(request) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const token of tokenize(request)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  /** @type {Map<string, number>} */
  const weighted = new Map();
  for (const [term, count] of counts) {
    let weight = count;
    if (term.length >= 6) weight += 1;
    if (DOMAIN_KEYWORDS.has(term)) weight += 2;
    weighted.set(term, weight);
    // Query terms only get a softer (length > 4) singular fold so very short
    // tokens like "apis" aren't stemmed into a different concept here; the
    // actual stemming rules are shared from risk-paths so path classification
    // and query weighting stay in sync.
    const singular = term.length > 4 ? singularizeToken(term) : term;
    if (singular !== term) {
      weighted.set(singular, Math.max(weighted.get(singular) ?? 0, Math.max(1, weight - 1)));
    }
  }
  // "OpenPanel" also reaches `lib/openpanel.ts`; see joinedCamelCaseWords.
  for (const joined of joinedCamelCaseWords(request)) {
    if (!weighted.has(joined)) weighted.set(joined, joined.length >= 6 ? 2 : 1);
  }
  return weighted;
}

/**
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function countTokens(tokens) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * @param {Map<string, number>} counts
 * @param {Map<string, number>} weightedQuery
 * @returns {string[]}
 */
function matchedTerms(counts, weightedQuery) {
  /** @type {string[]} */
  const hits = [];
  for (const term of counts.keys()) if (weightedQuery.has(term)) hits.push(term);
  return hits.sort();
}

/**
 * @param {Map<string, number>} weightedQuery
 * @param {string[]} tokens
 * @returns {boolean}
 */
function queryMentions(weightedQuery, tokens) {
  return tokens.some((token) => weightedQuery.has(token));
}

/**
 * @param {string} filePath
 * @param {Map<string, number>} weightedQuery
 * @returns {number}
 */
function computeConfigBonus(filePath, weightedQuery) {
  const lower = filePath.toLowerCase();
  let bonus = 0;
  for (const [term, hints] of Object.entries(CONFIG_HINTS)) {
    if (!weightedQuery.has(term)) continue;
    if (hints.some((hint) => lower.includes(hint))) bonus += W_CONFIG_HINT;
  }
  return bonus;
}

/**
 * @param {Map<string, string[]>} map
 * @param {string} key
 * @param {string} value
 */
function pushTo(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function dedupe(values) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) return fallback;
  return Math.min(max, Math.floor(num));
}

/**
 * @param {number} value
 * @returns {number}
 */
function round(value) {
  return Math.round(value * 10) / 10;
}

export const RANK_GLYPHS = ["🥇", "🥈", "🥉", "🏅", "🏅"];

/**
 * @param {ReturnType<typeof generateImpact>['data']} data
 * @param {(options: Record<string, unknown>) => any} rendererFactory
 * @returns {string}
 */
export function formatImpactTerminal(data, rendererFactory) {
  /** @type {string[]} */
  const lines = [];
  const renderer = rendererFactory({});
  // A section's own emoji, shown only by the emoji set; ascii keeps its ">".
  const decor = (/** @type {string} */ emoji) => renderer.pick({ emoji: `${emoji} `, ascii: "> ", unicode: "" });
  const headlines = [
    { text: `"${data.query}"`, glyph: "💬" },
    { text: `${data.repo.root} · ${data.repo.sourceFileCount} source file(s)`, glyph: "📂" },
  ];
  lines.push(renderer.header({ text: "solumbe impact · change blast radius", glyph: "🎯" }, headlines));
  lines.push("");
  if (data.concepts.length) {
    lines.push(
      `  ${renderer.pick({ emoji: "🧠", ascii: "[?]" })}  concepts: ${data.concepts.map((/** @type {string} */ c) => `${glyphFor(c) || ""} ${c}`.trim()).join(" · ")}`,
    );
    lines.push("");
  }
  for (const [index, file] of data.topFiles.entries()) {
    const rank = renderer.pick({ emoji: RANK_GLYPHS[index] ?? "  ", ascii: `${(index + 1).toString().padStart(2, " ")}.` });
    lines.push(`  ${rank}  ${file.path}    score ${file.score}`);
    lines.push(`       ${renderer.glyphs.box.arrow} role: ${file.role}`);
    for (const reason of file.reasons.slice(0, 4)) {
      lines.push(`       ${renderer.glyphs.box.arrow} ${reason}`);
    }
    if (file.riskFlags.length) {
      lines.push(
        `       ${renderer.glyphs.box.arrow} risk: ${file.riskFlags.map((/** @type {string} */ flag) => `${glyphFor(flag) || ""} ${flag}`.trim()).join(" · ")}`,
      );
    }
    lines.push("");
  }
  lines.push(
    renderer.section(
      `${decor("🧪")}Suggested tests`,
      data.testSuggestions.slice(0, 8).map((/** @type {string} */ t) => `${renderer.paint(renderer.glyphs.item, "dim")} ${t}`),
    ),
  );
  lines.push("");
  lines.push(
    renderer.section(
      `${decor("🚨")}Risk hotspots`,
      data.risks.slice(0, 6).map((/** @type {string} */ r) => `${renderer.paint(renderer.glyphs.item, "dim")} ${r}`),
    ),
  );
  if (data.companions) {
    lines.push("");
    lines.push(
      renderer.section(
        `${decor("🔗")}Companion repository leads`,
        data.companions.map(
          (/** @type {CompanionLead} */ companion) => `${renderer.paint(renderer.glyphs.item, "dim")} ${companion.repo}: ${formatCompanionFiles(companion)}`,
        ),
      ),
    );
  }
  if (data.validation) {
    lines.push("");
    const v = data.validation;
    lines.push(
      renderer.section(
        `${decor("🔍")}Diff validation (base ${v.base})`,
        v.ok
          ? [
              `verdict: ${v.verdict}`,
              `confirmed direct: ${formatList(v.confirmedDirect)}`,
              `confirmed related: ${formatList(v.confirmedRelated)}`,
              `unconfirmed candidates: ${formatList(v.unconfirmedCandidates)}`,
              `unexplained changed files: ${formatList(v.missedChangedFiles)}`,
            ]
          : [`error: ${v.error}`],
      ),
    );
  }
  lines.push("");
  lines.push(`  ${renderer.pick({ emoji: "📦", ascii: "[i]" })} Token estimate: JSON ${data.tokenEstimate.fullJson} · markdown ${data.tokenEstimate.markdown}`);
  return lines.join("\n");
}

/**
 * Mermaid flowchart: query → concepts → top files → related files.
 * @param {ReturnType<typeof generateImpact>['data']} data
 * @returns {string}
 */
export function formatImpactMermaid(data) {
  const lines = ["flowchart TD"];
  const query = (data.query ?? "query").slice(0, 60).replace(/"/g, "'");
  lines.push(`    Q["🔍 ${query}"]`);

  const concepts = (data.concepts ?? []).slice(0, 5);
  for (const [i, concept] of concepts.entries()) {
    lines.push(`    C${i}["💡 ${concept}"]`);
    lines.push(`    Q --> C${i}`);
  }

  const topFiles = (data.topFiles ?? []).slice(0, 8);
  const seenRelated = new Set();
  const relatedIds = uniqueIds();

  for (const [fi, file] of topFiles.entries()) {
    const basename = file.path.split("/").pop() ?? file.path;
    // Mermaid renders <br/> as a line break; a literal \n is shown as text.
    const label = `${basename}<br/>score: ${file.score}`.replace(/"/g, "'");
    lines.push(`    F${fi}["📄 ${label}"]`);
    // Attach to first concept that matches the file's domain, else concept 0 or query.
    const ci = concepts.findIndex(
      (/** @type {string} */ c) => file.domain?.includes(c) || (file.reasons ?? []).some((/** @type {string} */ r) => r.toLowerCase().includes(c)),
    );
    if (ci >= 0) lines.push(`    C${ci} --> F${fi}`);
    else if (concepts.length === 0) lines.push(`    Q --> F${fi}`);
    else lines.push(`    C0 --> F${fi}`);

    for (const rel of (file.relatedFiles ?? []).slice(0, 3)) {
      if (seenRelated.has(rel)) continue;
      seenRelated.add(rel);
      const relBase = (rel.split("/").pop() ?? rel).replace(/"/g, "'");
      const rid = relatedIds(`R_${mId(rel)}`);
      lines.push(`    ${rid}["${relBase}"]`);
      lines.push(`    F${fi} -.-> ${rid}`);
    }
  }

  return lines.join("\n");
}

/** @param {string} text @returns {string} */
function mId(text) {
  return String(text)
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/^(\d)/, "_$1");
}

/**
 * Returns a function that maps a candidate Mermaid node id to a collision-free
 * id, appending a numeric suffix when distinct labels sanitize to the same base.
 * @returns {(base: string) => string}
 */
function uniqueIds() {
  /** @type {Set<string>} */
  const used = new Set();
  return (base) => {
    let id = base;
    let n = 1;
    while (used.has(id)) id = `${base}_${n++}`;
    used.add(id);
    return id;
  };
}
