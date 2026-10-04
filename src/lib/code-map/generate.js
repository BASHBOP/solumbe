import fs from "node:fs";
import path from "node:path";
import { inspectRepo, listRepoFiles } from "../repo.js";
import { estimateTokens, estimateTokenSections } from "../tokens.js";
import { extractAstFacts } from "./ast.js";
import { classifyFile, extractHttpMethods, inferControllerBasePath, inferDomainInfo, inferNextRoute, isMarkdownFilePath } from "./classify.js";
import { extractDataAccess } from "./data-access.js";
import { isVendorFile } from "./vendor.js";

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".go",
  ".cs",
  ".py",
  ".java",
  ".rb",
  ".rs",
  ".hbs",
  ".handlebars",
  ".json",
  ".yaml",
  ".yml",
  ".snap",
  // The data model: a Prisma schema and SQL migrations. A migration that
  // rewrites existing rows is as much the change as the service beside it.
  ".prisma",
  ".sql",
  // Markdown ships as source in this ecosystem: agent skills (SKILL.md and
  // its companion pages) are instructions contributors are asked to edit, and
  // docs/ pages are the thing a documentation request changes. Leaving them
  // unindexed made every markdown-owned request rank library files instead.
  ".md",
  ".mdx",
  ".markdown",
]);

/** @param {string} file @returns {boolean} */
function isMigrationPath(file) {
  return /(^|\/)migrations?(\/|$)/i.test(file);
}

/** @param {string} file @returns {boolean} */
export function isSourceFilePath(file) {
  const basename = path.posix.basename(file);
  // Manifest and compiler metadata are ubiquitous but are not useful change
  // owners. Keep application JSON (translations and flag config) indexable.
  if (["package.json", "package-lock.json", "tsconfig.json"].includes(basename)) return false;
  // SQL outside a migrations directory is usually a dump or seed, not a change owner.
  if (path.posix.extname(file) === ".sql") return isMigrationPath(file) || /^(schema|structure)\.sql$/.test(basename);
  return sourceExtensions.has(path.posix.extname(file)) || (basename === ".snapshot" && /(^|\/)(feature[-_]?flags?|flags?|config)(\/|$)/i.test(file));
}

/**
 * @typedef {import('./data-access.js').DataAccessHit} DataAccessHit
 * @typedef {import('./ast.js').CodeSymbol} CodeSymbol
 */

/**
 * Per-file analysis record.
 * @typedef {object} FileRecord
 * @property {string} path
 * @property {string} kind
 * @property {string} domain
 * @property {string[]} domains
 * @property {string | undefined} route
 * @property {string | undefined} controllerBasePath
 * @property {{ method: string, path: string }[]} httpMethods
 * @property {string[]} imports
 * @property {string[]} exports
 * @property {CodeSymbol[]} symbols
 * @property {string[]} formFields
 * @property {string[]} navigationTargets
 * @property {string[]} localIdentifiers
 * @property {boolean} isVendor
 * @property {DataAccessHit[]} [dataAccess]
 */

/**
 * Aggregated counters across all analyzed source files.
 * @typedef {Record<string, number>} CodeMapSummary
 */

/**
 * One domain grouping in the code map.
 * @typedef {object} DomainKindCount
 * @property {string} kind
 * @property {number} count
 *
 * @typedef {object} DomainSummary
 * @property {string} name
 * @property {number} fileCount
 * @property {DomainKindCount[]} kinds
 */

/**
 * The full generated code map.
 * @typedef {object} CodeMap
 * @property {boolean} ok
 * @property {object} repo
 * @property {string} repo.root
 * @property {string} repo.name
 * @property {unknown} repo.package
 * @property {unknown} repo.git
 * @property {number} repo.fileCount
 * @property {number} repo.sourceFileCount
 * @property {unknown} repo.languages
 * @property {string[]} repo.entrypoints
 * @property {CodeMapSummary} summary
 * @property {DomainSummary[]} domains
 * @property {FileRecord[]} files
 * @property {{ fullJson: number, estimated: boolean, method: string, total: number, sections: { name: string, tokens: number, characters: number }[] }} [tokenEstimate]
 */

/**
 * @param {string} [repoPath]
 * @param {{ maxSymbols?: number }} [options]
 * @returns {CodeMap}
 */
export function generateCodeMap(repoPath = ".", options = {}) {
  const repo = inspectRepo(repoPath);
  const files = listRepoFiles(repo.root).filter(isSourceFilePath);
  const maxSymbols = Number(options.maxSymbols ?? 5000);
  const sourceFiles = /** @type {FileRecord[]} */ (files.map((file) => analyzeFile(repo.root, file, maxSymbols)).filter(Boolean));
  return assembleCodeMap(repo, sourceFiles);
}

/**
 * Build the same scoring map from caller-supplied immutable source text. This
 * avoids filesystem checkout semantics (filters, case folding, Unicode path
 * normalisation) when a Git tree is the exact receipt subject.
 * @param {string} repoRoot
 * @param {Iterable<{ path: string, text: string }>} sources
 * @param {{ maxSymbols?: number, name?: string }} [options]
 * @returns {CodeMap}
 */
export function generateCodeMapFromSources(repoRoot, sources, options = {}) {
  const root = path.resolve(repoRoot);
  const maxSymbols = Number(options.maxSymbols ?? 5000);
  /** @type {FileRecord[]} */
  const sourceFiles = [];
  let sourceCount = 0;
  for (const source of sources) {
    sourceCount += 1;
    const record = analyzeSource(source.path, source.text, maxSymbols);
    if (record) sourceFiles.push(record);
  }
  return assembleCodeMap(
    {
      root,
      name: options.name ?? path.basename(root),
      package: null,
      git: null,
      fileCount: sourceCount,
      languages: [],
      entrypoints: [],
    },
    sourceFiles,
  );
}

/**
 * @param {any} repo
 * @param {FileRecord[]} sourceFiles
 * @returns {CodeMap}
 */
function assembleCodeMap(repo, sourceFiles) {
  const domains = summarizeDomains(sourceFiles);

  /** @type {CodeMap} */
  const map = {
    ok: true,
    repo: {
      root: repo.root,
      name: repo.package?.name ?? repo.name ?? path.basename(repo.root),
      package: repo.package,
      git: repo.git,
      fileCount: repo.fileCount,
      sourceFileCount: sourceFiles.length,
      languages: repo.languages,
      entrypoints: repo.entrypoints,
    },
    summary: summarizeFiles(sourceFiles),
    domains,
    files: sourceFiles,
  };
  map.tokenEstimate = {
    fullJson: estimateTokens(map),
    ...estimateTokenSections([
      { name: "repo", value: map.repo },
      { name: "summary", value: map.summary },
      { name: "domains", value: map.domains },
      { name: "files", value: map.files },
    ]),
  };
  return map;
}

// Maps a file kind to its summary counter key. Kinds without an entry (e.g.
// "source", "page") are counted toward symbols/data-access only.
/** @type {Record<string, string>} */
const summaryKindKeys = {
  route: "routes",
  apiRoute: "apiRoutes",
  controller: "controllers",
  service: "services",
  module: "modules",
  component: "components",
  hook: "hooks",
  apiClient: "apiClients",
  dto: "dtos",
  schema: "schemas",
  test: "tests",
};

/**
 * @param {FileRecord[]} sourceFiles
 * @returns {CodeMapSummary}
 */
function summarizeFiles(sourceFiles) {
  /** @type {CodeMapSummary} */
  const summary = {
    routes: 0,
    apiRoutes: 0,
    controllers: 0,
    services: 0,
    modules: 0,
    components: 0,
    hooks: 0,
    apiClients: 0,
    dtos: 0,
    schemas: 0,
    tests: 0,
    symbols: 0,
    dataAccessFiles: 0,
    dataAccessHits: 0,
  };

  for (const file of sourceFiles) {
    const key = summaryKindKeys[file.kind];
    if (key) {
      summary[key] += 1;
    }
    summary.symbols += file.symbols.length;
    const dataAccessHits = file.dataAccess?.length ?? 0;
    if (dataAccessHits > 0) {
      summary.dataAccessFiles += 1;
      summary.dataAccessHits += dataAccessHits;
    }
  }

  return summary;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {number} maxSymbols
 * @returns {FileRecord | undefined}
 */
function analyzeFile(root, relativePath, maxSymbols) {
  const absolute = path.join(root, relativePath);
  const text = safeRead(absolute);
  return analyzeSource(relativePath, text, maxSymbols);
}

/**
 * @param {string} relativePath
 * @param {string} text
 * @param {number} maxSymbols
 * @returns {FileRecord | undefined}
 */
function analyzeSource(relativePath, text, maxSymbols) {
  if (!text) {
    return undefined;
  }

  // Markdown carries no module graph, and running it through the TypeScript
  // parser would mine prose and fenced examples for identifiers that name
  // nothing. `extractArtifactFacts` reads its headings and frontmatter
  // instead. Data access is skipped for the same reason: a SQL snippet quoted
  // in a doc is an example, not a query this repository runs.
  const markdown = isMarkdownFilePath(relativePath);
  // Prisma and SQL are not JavaScript; their models, tables and columns come
  // from `extractArtifactFacts`, not from the TypeScript parser.
  const schemaArtifact = /\.(prisma|sql)$/i.test(relativePath);
  const ast = markdown || schemaArtifact ? emptyAstFacts() : extractAstFacts(relativePath, text);
  const artifactFacts = extractArtifactFacts(relativePath, text);
  const vendor = isVendorFile(relativePath, text);
  const dataAccess = vendor || markdown || schemaArtifact ? [] : extractDataAccess(text);
  const domainInfo = inferDomainInfo(relativePath);
  /** @type {FileRecord} */
  const record = {
    path: relativePath,
    kind: classifyFile(relativePath),
    domain: domainInfo.primary,
    domains: domainInfo.all,
    route: inferNextRoute(relativePath),
    controllerBasePath: inferControllerBasePath(text),
    httpMethods: extractHttpMethods(text),
    imports: [...new Set([...ast.imports, ...artifactFacts.imports])],
    exports: ast.exports,
    symbols: [...ast.symbols, ...artifactFacts.symbols].slice(0, maxSymbols),
    formFields: ast.formFields ?? [],
    navigationTargets: ast.navigationTargets ?? [],
    localIdentifiers: ast.localIdentifiers ?? [],
    isVendor: vendor,
  };
  if (dataAccess.length > 0) {
    record.dataAccess = dataAccess.slice(0, 50);
  }
  return record;
}

/**
 * Extract only stable identifiers from templates and configuration. This makes
 * Handlebars partials, translation keys and feature-flag names searchable
 * without indexing template bodies, customer copy or configuration values.
 * @param {string} relativePath
 * @param {string} text
 */
function extractArtifactFacts(relativePath, text) {
  const extension = path.extname(relativePath).toLowerCase();
  /** @type {string[]} */
  const imports = [];
  /** @type {CodeSymbol[]} */
  const symbols = [];
  const seen = new Set();
  /** @param {string} type @param {string} name @param {number} offset */
  const add = (type, name, offset) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    symbols.push({ type, name, line: text.slice(0, offset).split("\n").length });
  };

  if (extension === ".hbs" || extension === ".handlebars") {
    for (const match of text.matchAll(/{{\s*[#/>]?\s*([A-Za-z_$][\w$.-]*)/g)) {
      const name = match[1];
      add("template", name, match.index ?? 0);
      if (text.slice(match.index ?? 0, (match.index ?? 0) + 5).includes(">")) imports.push(name);
    }
  } else if (extension === ".json") {
    for (const match of text.matchAll(/"([^"\\]{2,120})"\s*:/g)) add("config", match[1], match.index ?? 0);
  } else if (extension === ".yaml" || extension === ".yml") {
    for (const match of text.matchAll(/^\s*([A-Za-z_$][\w$.-]{1,120})\s*:/gm)) add("config", match[1], match.index ?? 0);
  } else if (extension === ".prisma") {
    for (const match of text.matchAll(/^\s*(model|enum|view|type)\s+([A-Za-z_]\w*)\s*{/gm))
      add(match[1] === "enum" ? "enum" : "model", match[2], match.index ?? 0);
    // Field names: `paystackKycStatus String?` is what a KYC request matches on.
    for (const match of text.matchAll(/^\s+([a-z_]\w*)\s+[A-Z]\w*(?:\[\])?\??(?:\s|$)/gm)) add("field", match[1], match.index ?? 0);
  } else if (extension === ".sql") {
    for (const match of text.matchAll(/\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(\w+)"?/gi)) add("table", match[1], match.index ?? 0);
    for (const match of text.matchAll(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?(\w+)"?/gi)) add("table", match[1], match.index ?? 0);
    for (const match of text.matchAll(/\b(?:ADD|DROP|ALTER|RENAME)\s+COLUMN\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?(\w+)"?/gi))
      add("column", match[1], match.index ?? 0);
    for (const match of text.matchAll(/\bSET\s+"?(\w+)"?\s*=/gi)) add("column", match[1], match.index ?? 0);
  } else if (extension === ".md" || extension === ".mdx" || extension === ".markdown") {
    // Frontmatter keys and their scalar values first: a skill's `name` is its
    // identifier, and it is what a request naming that skill matches on.
    const frontmatter = text.startsWith("---\n") ? text.slice(4, Math.max(4, text.indexOf("\n---", 3))) : "";
    for (const match of frontmatter.matchAll(/^([A-Za-z_][\w.-]{0,80})\s*:[ \t]*(\S[^\n]{0,120})?$/gm)) {
      add("frontmatter", match[1], match.index ?? 0);
      const value = match[2]?.trim();
      // Skip block scalars (`>-`, `|`) — the marker is not the value, and the
      // prose that follows is description, not an identifier.
      if (value && !/^[>|]/.test(value) && value.length <= 80) add("frontmatter", value, match.index ?? 0);
    }
    const body = text.slice(frontmatter.length);
    for (const match of body.matchAll(/^#{1,6}[ \t]+(\S[^\n]{0,120})$/gm)) {
      add("heading", match[1].trim().replace(/\s*#+\s*$/, ""), match.index ?? 0);
    }
    // Relative links and image targets are this document's edges to the rest
    // of the repository, so they behave like imports for relatedness.
    for (const match of body.matchAll(/]\(\s*(\.{0,2}\/[^)\s]{1,200})\s*\)/g)) {
      imports.push(match[1].replace(/#.*$/, ""));
    }
  }
  return { imports: [...new Set(imports)], symbols };
}

/** @returns {{ imports: string[], exports: string[], symbols: CodeSymbol[], formFields: string[], navigationTargets: string[], localIdentifiers: string[] }} */
function emptyAstFacts() {
  return { imports: [], exports: [], symbols: [], formFields: [], navigationTargets: [], localIdentifiers: [] };
}

/**
 * @param {FileRecord[]} files
 * @returns {DomainSummary[]}
 */
function summarizeDomains(files) {
  /** @type {Map<string, { name: string, fileCount: number, kinds: Map<string, number> }>} */
  const domains = new Map();
  for (const file of files) {
    const tags = file.domains?.length ? file.domains : [file.domain];
    for (const name of tags) {
      const domain = domains.get(name) ?? { name, fileCount: 0, kinds: new Map() };
      domain.fileCount += 1;
      domain.kinds.set(file.kind, (domain.kinds.get(file.kind) ?? 0) + 1);
      domains.set(name, domain);
    }
  }

  return [...domains.values()]
    .map((domain) => ({
      name: domain.name,
      fileCount: domain.fileCount,
      kinds: [...domain.kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function safeRead(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
