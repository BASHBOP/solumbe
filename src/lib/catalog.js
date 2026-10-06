/// <reference types="node" />
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkIndexEnvelope, getCachedCodeMap } from "./index-cache.js";
import { codeMapCapabilitySignature } from "./code-map/capabilities.js";
import { estimateTokens } from "./tokens.js";
import { formatTerminalSummary } from "./output.js";
import { computeTokenDocFrequency, extractPhrases, scorePhraseMatches, tokenWeightFactor } from "./context-engine.js";

/**
 * @typedef {import('./index-cache.js').CodeMap} CodeMap
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 * @typedef {import('./index-cache.js').CodeMapPackage} CodeMapPackage
 */

/**
 * A catalog entry persisted for an indexed repository.
 * @typedef {object} CatalogRepository
 * @property {string} root
 * @property {string} name
 * @property {string} [marker]
 * @property {CodeMapPackage} [package]
 * @property {object} [git]
 * @property {Record<string, number>|object} [languages]
 * @property {string[]} [entrypoints]
 * @property {number} [sourceFileCount]
 * @property {import('./index-cache.js').CodeMapSummary} [summary]
 * @property {import('./index-cache.js').CodeMapDomain[]} [domains]
 * @property {string} [indexPath]
 * @property {string} [fingerprint]
 * @property {string} [generatedAt]
 * @property {string} [indexedAt]
 */

/**
 * The on-disk catalog document.
 * @typedef {object} Catalog
 * @property {number} version
 * @property {string} [updatedAt]
 * @property {CatalogRepository[]} repositories
 */

/**
 * Options accepted across catalog operations. All fields optional.
 * @typedef {object} CatalogOptions
 * @property {string} [catalogPath]
 * @property {string} [catalog]
 * @property {number} [depth]
 * @property {number} [limit]
 * @property {boolean} [discover]
 * @property {boolean} [offline]
 */

const catalogVersion = 1;
const defaultLimit = 25;
const defaultDiscoverDepth = 4;
const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".solumbe",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);
const repoMarkers = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Package.swift", "pom.xml", "build.gradle", "build.gradle.kts", ".git"]);
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "with",
]);

export function defaultCatalogPath() {
  return path.resolve(process.env.SOLUMBE_CATALOG ?? path.join(os.homedir(), ".solumbe", "catalog.json"));
}

/**
 * @param {string[]} [rootPaths]
 * @param {CatalogOptions} [options]
 */
export function discoverRepositories(rootPaths = ["."], options = {}) {
  const roots = normalizePathList(rootPaths);
  const maxDepth = normalizeLimit(options.depth, defaultDiscoverDepth, 20);
  const maxRepos = normalizeLimit(options.limit, 100, 1000);
  const seen = new Set();
  /** @type {{ root: string, name: string, marker: string, package?: CodeMapPackage }[]} */
  const repositories = [];

  for (const rootPath of roots) {
    visit(path.resolve(rootPath), 0);
  }

  return {
    ok: true,
    roots,
    maxDepth,
    repositoryCount: repositories.length,
    repositories: repositories.sort((a, b) => a.root.localeCompare(b.root)),
  };

  /**
   * @param {string} current
   * @param {number} depth
   */
  function visit(current, depth) {
    if (repositories.length >= maxRepos || depth > maxDepth || !isDirectory(current)) {
      return;
    }

    const realPath = realpath(current);
    if (!realPath || seen.has(realPath)) {
      return;
    }
    seen.add(realPath);

    const marker = repoMarker(current);
    if (marker) {
      repositories.push(discoveredRepository(current, marker));
      return;
    }

    for (const entry of safeReadDir(current)) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
        continue;
      }
      visit(path.join(current, entry.name), depth + 1);
    }
  }
}

/**
 * @param {string[]} [repoPaths]
 * @param {CatalogOptions} [options]
 */
export function indexRepositories(repoPaths = ["."], options = {}) {
  const catalogPath = resolveCatalogPath(options);
  const catalog = loadCatalog({ catalogPath }).catalog;
  const indexedAt = new Date().toISOString();
  /** @type {CatalogRepository[]} */
  const repositories = [];
  /** @type {{ path: string, error: string }[]} */
  const errors = [];
  const paths = options.discover ? discoverRepositories(repoPaths, options).repositories.map((repo) => repo.root) : normalizePathList(repoPaths);

  for (const repoPath of paths) {
    try {
      const map = getCachedCodeMap(repoPath);
      const entry = catalogEntryFromMap(map, indexedAt);
      upsertRepository(catalog, entry);
      repositories.push(entry);
    } catch (error) {
      errors.push({
        path: path.resolve(repoPath),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A repository deleted from disk can never be searched again, so indexing
  // drops it instead of carrying it forward as an error on every search.
  const pruned = catalog.repositories.filter((repository) => !fs.existsSync(repository.root)).map((repository) => repository.root);
  catalog.repositories = catalog.repositories.filter((repository) => !pruned.includes(repository.root));

  catalog.updatedAt = indexedAt;
  saveCatalog(catalog, { catalogPath });

  return {
    ok: errors.length === 0,
    catalogPath,
    indexedAt,
    repositoryCount: catalog.repositories.length,
    indexedCount: repositories.length,
    repositories,
    pruned,
    errors,
  };
}

/**
 * @param {CatalogOptions} [options]
 */
export function listCatalog(options = {}) {
  const { catalog, catalogPath } = loadCatalog(options);
  return {
    ok: true,
    catalogPath,
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    repositoryCount: catalog.repositories.length,
    repositories: catalog.repositories,
  };
}

/**
 * @param {string} query
 * @param {CatalogOptions} [options]
 */
export function searchCatalog(query, options = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) {
    throw new Error("search requires a non-empty query");
  }

  const limit = normalizeLimit(options.limit, defaultLimit, 200);
  const { catalog, catalogPath } = loadCatalog(options);
  /** @type {{ repository: CatalogRepository, map: CodeMap }[]} */
  const loaded = [];
  /** @type {{ root: string, error: string }[]} */
  const errors = [];
  /** @type {string[]} */
  const stale = [];

  // One signature for the whole sweep: it is a pure hash of the running
  // indexer's probe answers, identical for every repository in the loop.
  const capabilities = options.offline ? codeMapCapabilitySignature() : "";

  for (const repository of catalog.repositories) {
    // A deleted repository is stale, not failing: say so once, and the next
    // `solumbe index` drops it.
    if (!fs.existsSync(repository.root)) {
      stale.push(repository.root);
      continue;
    }
    try {
      const map = options.offline ? readIndexedMap(repository, capabilities) : getCachedCodeMap(repository.root);
      loaded.push({ repository, map });
    } catch (error) {
      errors.push({
        root: repository.root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A phrase/frequency pass over every loaded map first, so a compound
  // identifier the query literally names (e.g. "date of birth" ->
  // `dateOfBirth`) can outrank scattered hits on generic, high-frequency
  // domain nouns (e.g. "date", "booking") shared across many unrelated files.
  const phrases = extractPhrases(query);
  const tokenStats = computeTokenDocFrequency(
    loaded.map((entry) => entry.map),
    tokens,
  );

  /** @type {ReturnType<typeof scoreFile>[]} */
  const matches = [];
  for (const { repository, map } of loaded) {
    for (const file of map.files ?? []) {
      const scored = scoreFile(repository, file, tokens, phrases, tokenStats);
      if (scored.score > 0) {
        matches.push(scored);
      }
    }
  }

  matches.sort((a, b) => b.score - a.score || a.repository.name.localeCompare(b.repository.name) || a.file.path.localeCompare(b.file.path));

  /** @type {{ ok: boolean, query: string, tokens: string[], catalogPath: string, repositoryCount: number, matchCount: number, matches: ReturnType<typeof scoreFile>[], errors: { root: string, error: string }[], stale?: string[], staleHint?: string, tokenEstimate?: object }} */
  const result = {
    ok: true,
    query,
    tokens,
    catalogPath,
    repositoryCount: catalog.repositories.length,
    matchCount: matches.length,
    matches: matches.slice(0, limit),
    errors,
    ...(stale.length ? { stale, staleHint: "These repositories no longer exist on disk; run `solumbe index` to drop them." } : {}),
  };
  result.tokenEstimate = {
    fullJson: estimateTokens(result),
    estimated: true,
    method: "ceil(characters / 4)",
  };
  return result;
}

/**
 * @param {ReturnType<typeof discoverRepositories>} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 */
export function formatDiscoverSummary(result, options = {}) {
  return formatTerminalSummary({
    title: "solumbe discover · repository finder",
    glyph: "🔎",
    subtitle: `${result.roots.join(", ")} · depth ${result.maxDepth}`,
    facts: [["Repositories discovered", result.repositoryCount]],
    sections: [
      {
        title: "Repositories",
        glyph: "📂",
        items: result.repositories.map((repository) => `${repository.root} (${repository.marker})`),
      },
    ],
    close: { status: "runs" },
    options,
  });
}

/**
 * @param {ReturnType<typeof indexRepositories>} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 */
export function formatIndexSummary(result, options = {}) {
  return formatTerminalSummary({
    title: "solumbe index · repository catalog",
    glyph: "🗂️",
    subtitle: result.catalogPath,
    facts: [
      ["Indexed repositories", result.indexedCount],
      ["Catalog repositories", result.repositoryCount],
    ],
    sections: [
      { title: "Indexed", glyph: "✅", items: result.repositories.map((repo) => `${repo.name}: ${repo.root}`) },
      { title: "Errors", glyph: "⚠️", items: result.errors.map((error) => `${error.path}: ${error.error}`) },
    ],
    close: result.errors.length ? { status: "not-verified", detail: `${result.errors[0].path} did not index` } : { status: "runs" },
    options,
  });
}

/**
 * @param {ReturnType<typeof listCatalog>} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 */
export function formatCatalogSummary(result, options = {}) {
  return formatTerminalSummary({
    title: "solumbe catalog · indexed repositories",
    glyph: "📚",
    subtitle: result.updatedAt ? `updated ${result.updatedAt}` : "not updated yet",
    facts: [["Repositories", result.repositoryCount]],
    sections: [
      {
        title: "Repositories",
        glyph: "📂",
        items: result.repositories.map((repo) => {
          const domains = repo.domains
            ?.slice(0, 5)
            .map((domain) => domain.name)
            .join(", ");
          return `${repo.name}: ${repo.root}${domains ? ` (${domains})` : ""}`;
        }),
      },
    ],
    close: { status: "runs" },
    options,
  });
}

/**
 * @param {ReturnType<typeof searchCatalog>} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 */
export function formatSearchResults(result, options = {}) {
  return formatTerminalSummary({
    title: "solumbe search · catalog matches",
    glyph: "🧭",
    subtitle: `query: ${result.query}`,
    facts: [
      ["Matches", result.matchCount],
      ["Repositories searched", result.repositoryCount],
    ],
    sections: [
      {
        title: "Matches",
        glyph: "🎯",
        items: result.matches.map((match) => {
          const reasons = match.reasons.length ? ` · ${match.reasons.join(", ")}` : "";
          return `${match.repository.name}: ${match.file.path} [${match.file.kind}/${match.file.domain}]${reasons}`;
        }),
      },
      { title: "Errors", glyph: "⚠️", items: result.errors.map((error) => `${error.root}: ${error.error}`) },
    ],
    close: result.errors.length ? { status: "not-verified", detail: `${result.errors[0].root} could not be searched` } : { status: "runs" },
    options,
  });
}

/**
 * @param {CatalogOptions} [options]
 * @returns {{ catalog: Catalog, catalogPath: string }}
 */
function loadCatalog(options = {}) {
  const catalogPath = resolveCatalogPath(options);
  /** @type {Catalog | undefined} */
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch {
    catalog = undefined;
  }

  if (!catalog || catalog.version !== catalogVersion || !Array.isArray(catalog.repositories)) {
    catalog = {
      version: catalogVersion,
      updatedAt: undefined,
      repositories: [],
    };
  }

  return { catalog, catalogPath };
}

/**
 * @param {Catalog} catalog
 * @param {CatalogOptions} [options]
 */
function saveCatalog(catalog, options = {}) {
  const catalogPath = resolveCatalogPath(options);
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
}

/**
 * @param {CatalogOptions} [options]
 * @returns {string}
 */
function resolveCatalogPath(options = {}) {
  return path.resolve(options.catalogPath ?? options.catalog ?? defaultCatalogPath());
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function normalizePathList(paths) {
  const values = Array.isArray(paths) && paths.length ? paths : ["."];
  return [...new Set(values.map((value) => path.resolve(value || ".")))];
}

/**
 * @param {CodeMap} map
 * @param {string} indexedAt
 * @returns {CatalogRepository}
 */
function catalogEntryFromMap(map, indexedAt) {
  return {
    root: map.repo.root,
    name: map.repo.name,
    package: map.repo.package,
    git: map.repo.git,
    languages: map.repo.languages,
    entrypoints: map.repo.entrypoints,
    sourceFileCount: map.repo.sourceFileCount,
    summary: map.summary,
    domains: map.domains,
    indexPath: map.cache?.path ?? path.join(map.repo.root, ".solumbe", "index.json"),
    fingerprint: map.cache?.fingerprint,
    generatedAt: map.cache?.generatedAt ?? indexedAt,
    indexedAt,
  };
}

/**
 * @param {Catalog} catalog
 * @param {CatalogRepository} entry
 */
function upsertRepository(catalog, entry) {
  catalog.repositories = [...catalog.repositories.filter((repository) => repository.root !== entry.root), entry].sort(
    (a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root),
  );
}

/**
 * Reads a catalogued repository's stored index without touching the repository
 * itself, which is what `--offline` promises: "use stored index files without
 * refreshing fingerprints".
 *
 * Not refreshing the fingerprint is not a licence to trust the file blindly.
 * The envelope already carries the indexer's version, its capability signature
 * and the root it was written for, and checking those three costs nothing
 * beyond the parse we were doing anyway. Without them an offline workspace
 * search happily serves a map from an indexer that, say, could not yet see
 * markdown — the #175/#179 failure, one repository at a time and with no
 * signal at all.
 *
 * A rejected index is skipped rather than rebuilt. Rebuilding here would
 * re-fingerprint and possibly regenerate every catalogued repository on every
 * search, which is the cost `--offline` exists to avoid; the caller records
 * the reason instead and the message says how to refresh it.
 * @param {CatalogRepository} repository
 * @param {string} capabilities - Signature of the running indexer.
 * @returns {CodeMap}
 */
function readIndexedMap(repository, capabilities) {
  const envelope = JSON.parse(fs.readFileSync(String(repository.indexPath), "utf8"));
  const root = path.resolve(String(repository.root));
  const verdict = checkIndexEnvelope(envelope, root, capabilities);
  if (!verdict.ok) {
    throw new Error(`stored index is stale: ${verdict.reason}. Re-run \`solumbe index\` for this repository, or search without --offline to rebuild it now`);
  }
  return envelope.map;
}

/**
 * @param {CatalogRepository} repository
 * @param {CodeMapFile} file
 * @param {string[]} tokens
 * @param {import('./context-engine.js').PhraseCandidate[]} [phrases]
 * @param {import('./context-engine.js').TokenStats} [tokenStats]
 */
function scoreFile(repository, file, tokens, phrases = [], tokenStats) {
  /** @type {string[]} */
  const reasons = [];
  let score = 0;

  score += scoreField(file.path, tokens, 8, "path", reasons, tokenStats);
  score += scoreField(file.kind, tokens, 4, "kind", reasons, tokenStats);
  score += scoreField(file.domains?.length ? file.domains.join(" ") : file.domain, tokens, 5, "domain", reasons, tokenStats);
  score += scoreField(repository.name, tokens, 3, "repo", reasons, tokenStats);
  score += scoreField(repository.package?.name, tokens, 3, "package", reasons, tokenStats);
  score += scoreField(file.route, tokens, 6, "route", reasons, tokenStats);
  score += scoreField(file.controllerBasePath, tokens, 6, "controller", reasons, tokenStats);

  for (const method of file.httpMethods ?? []) {
    score += scoreField(`${method.method} ${method.path}`, tokens, 7, "http", reasons, tokenStats);
  }
  for (const value of file.imports ?? []) {
    score += scoreField(value, tokens, 3, "import", reasons, tokenStats);
  }
  for (const value of file.exports ?? []) {
    score += scoreField(value, tokens, 8, "export", reasons, tokenStats);
  }
  for (const symbol of file.symbols ?? []) {
    score += scoreField(`${symbol.type} ${symbol.name}`, tokens, 9, "symbol", reasons, tokenStats);
  }

  // Hybrid literal pass: a file whose own text contains the exact multi-word
  // phrase the query names (e.g. "date of birth") is far stronger evidence
  // than several files each sharing one generic word with the query.
  score += scorePhraseMatches(file, phrases, reasons);

  return {
    score,
    reasons: [...new Set(reasons)].slice(0, 6),
    repository: {
      name: repository.name,
      root: repository.root,
    },
    file: {
      path: file.path,
      kind: file.kind,
      domain: file.domain,
      domains: file.domains ?? (file.domain ? [file.domain] : []),
      route: file.route,
      controllerBasePath: file.controllerBasePath,
      httpMethods: file.httpMethods,
      imports: file.imports?.slice(0, 8) ?? [],
      exports: file.exports?.slice(0, 8) ?? [],
      symbols: file.symbols?.slice(0, 12) ?? [],
    },
  };
}

/**
 * @param {string|null|undefined} value
 * @param {string[]} tokens
 * @param {number} weight
 * @param {string} reason
 * @param {string[]} reasons
 * @param {import('./context-engine.js').TokenStats} [tokenStats]
 * @returns {number}
 */
function scoreField(value, tokens, weight, reason, reasons, tokenStats) {
  if (!value) {
    return 0;
  }

  const normalized = normalizeText(String(value));
  let score = 0;
  for (const token of tokens) {
    const factor = tokenWeightFactor(token, tokenStats);
    if (normalized === token) {
      score += Math.round(weight * 2 * factor);
    } else if (normalized.includes(token)) {
      score += Math.round(weight * factor);
    }
  }

  if (score > 0) {
    reasons.push(reason);
  }
  return score;
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

/**
 * @param {string} root
 * @returns {string|undefined}
 */
function repoMarker(root) {
  for (const marker of repoMarkers) {
    if (fs.existsSync(path.join(root, marker))) {
      return marker;
    }
  }
  return undefined;
}

/**
 * @param {string} root
 * @param {string} marker
 * @returns {{ root: string, name: string, marker: string, package?: CodeMapPackage }}
 */
function discoveredRepository(root, marker) {
  const packageJson = readJson(path.join(root, "package.json"));
  return {
    root,
    name: packageJson?.name ?? path.basename(root),
    marker,
    package: packageJson
      ? {
          name: packageJson.name,
          version: packageJson.version,
          type: packageJson.type,
          private: packageJson.private,
        }
      : undefined,
  };
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * @param {string} directory
 * @returns {import('node:fs').Dirent[]}
 */
function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} value
 * @returns {string|undefined}
 */
function realpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return undefined;
  }
}
