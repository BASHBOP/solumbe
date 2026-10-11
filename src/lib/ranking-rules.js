// Ranking rules the context engine and the impact engine share. Each answers a
// question both engines got wrong on the same real request (bashbop-event-web,
// 2026-09-27; the recorded outputs are in .solumbe/runs/2026-09-27/):
//
// - A translation catalog holds thousands of keys, so it matched almost any
//   plain-language request, and its five locales took five ranked slots.
// - `event-service.ts` in a request tokenized to `event service ts`, and `ts`
//   then matched the extension of every TypeScript file in the repository.
// - A file or a symbol the request named outright ranked wherever its word
//   overlap happened to leave it: 40th, in the recorded case.

/// <reference types="node" />
import path from "node:path";
import { localeCatalogKey, localeOf } from "./code-map/classify.js";
import { isIdentifierShaped } from "./code-map/text.js";
import { isTestDataPath } from "./risk-paths.js";

/**
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 */

/**
 * A file the request names: by path or basename (`rule: "path"`), or as the
 * definition of a symbol the request names (`rule: "symbol"`).
 * @typedef {object} NamedFile
 * @property {string} path
 * @property {"path" | "symbol" | "implements"} rule
 * @property {string} literal - the text in the request that named it
 * @property {string} [via] - for `implements`, the registry file that names it
 * @property {number} [line] - the defining line, for a named symbol
 * @property {number} [importers] - non-test files importing the definer
 * @property {boolean} [exported]
 */

// A translation catalog is data an implementation reads. The same factor the
// impact engine applies to generated documentation.
export const TRANSLATION_DEMOTION = 0.3;

// A request about the words a user reads, rather than the code, is the one
// request a translation catalog can own.
const COPY_REQUEST_TERMS = new Set([
  "copy",
  "copywriting",
  "microcopy",
  "wording",
  "reword",
  "rephrase",
  "typo",
  "typos",
  "spelling",
  "i18n",
  "l10n",
  "translation",
  "translations",
  "translate",
  "translated",
  "translating",
  "locale",
  "locales",
  "localisation",
  "localization",
  "localise",
  "localize",
  "localised",
  "localized",
  "internationalisation",
  "internationalization",
  "language",
  "languages",
  "multilingual",
]);

/**
 * @param {Iterable<string>} terms lowercased request tokens
 * @returns {boolean}
 */
export function isCopyRequest(terms) {
  for (const term of terms) if (COPY_REQUEST_TERMS.has(term)) return true;
  return false;
}

// Extensions a request can name a file by. The indexer's own extensions, plus
// the common ones it does not index, so `styles.css` still reads as a file.
const NAMED_FILE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "go",
  "cs",
  "py",
  "java",
  "rb",
  "rs",
  "hbs",
  "handlebars",
  "json",
  "yaml",
  "yml",
  "snap",
  "md",
  "mdx",
  "markdown",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "vue",
  "svelte",
  "sql",
  "prisma",
  "graphql",
  "gql",
  "sh",
  "toml",
  "kt",
  "swift",
  "php",
];
const extensionAlternation = NAMED_FILE_EXTENSIONS.join("|");
const trailingExtension = new RegExp(`\\.(?:${extensionAlternation})$`, "i");
const inlineExtension = new RegExp(`(?<=[\\w$\\])-])\\.(?:${extensionAlternation})(?![\\w$])`, "gi");

/**
 * Drop the extension from every file name a request mentions, so the words of
 * `event-service.ts` still score and `ts` does not: an extension is shared by
 * every file of that language, which makes it evidence for none of them.
 * @param {string} request
 * @returns {string}
 */
export function stripFileExtensions(request) {
  return String(request ?? "").replace(inlineExtension, "");
}

/**
 * The literal references in a request: path-shaped text (`services/event-service.ts`,
 * `EditableDate.tsx`, `utils/create-event`) and identifier-shaped words
 * (`combineDateAndTime`, `EventService`, `date_of_birth`). A plain word is
 * neither: it is ranked by overlap, as before.
 * @param {string} request
 * @returns {{ paths: string[], symbols: string[] }}
 */
export function requestLiterals(request) {
  const text = String(request ?? "");
  /** @type {Set<string>} */
  const paths = new Set();
  /** @type {Array<[number, number]>} */
  const fileNameSpans = [];
  for (const match of text.matchAll(/[^\s`'"<>,;|]+/g)) {
    const literal = match[0]
      .replace(/^[([{]+/, "")
      .replace(/[.,:;!?)\]}]+$/, "")
      .replace(/#L\d+.*$/i, "")
      .replace(/:\d+(?::\d+)?$/, "")
      .replace(/^\.?\//, "");
    if (!literal || literal.includes("://")) continue;
    if (trailingExtension.test(literal) && /[\w$\])-]\.[a-z]+$/i.test(literal)) {
      paths.add(literal);
      fileNameSpans.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    } else if (/^[\w.@$()[\]-]+(?:\/[\w.@$()[\]-]+)+$/.test(literal)) {
      paths.add(literal);
    }
  }

  /** @type {Set<string>} */
  const symbols = new Set();
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const start = match.index ?? 0;
    // `EditableDate` inside `EditableDate.tsx` names the file, not a symbol.
    if (fileNameSpans.some(([from, to]) => start >= from && start < to)) continue;
    if (isIdentifierShaped(match[0])) symbols.add(match[0]);
  }
  return { paths: [...paths], symbols: [...symbols] };
}

// A literal that resolves to more files than this is a common name
// (`index.ts`, `page.tsx`), not a reference to one of them.
const MAX_FILES_PER_LITERAL = 3;
// A symbol defined in more files than this is a common helper name
// (`formatDate` has twelve definitions in bashbop-event-web).
const MAX_DEFINERS_PER_SYMBOL = 3;
// A registered name followed into more modules than this calls helpers too
// widely to say which one implements it.
const MAX_IMPLEMENTERS_PER_NAME = 3;
// Symbols the indexer reads from data and prose rather than code: JSON and
// YAML keys, Markdown headings and frontmatter, Handlebars references.
const ARTIFACT_SYMBOL_TYPES = new Set(["config", "heading", "frontmatter", "template"]);

/**
 * The files a request names outright. A named path or basename is pinned. A
 * named symbol pins the file that defines, exports and is imported for it —
 * the definition the code actually uses. Its other definitions (a local copy,
 * an export nothing imports) are returned as `definers`, to be surfaced but
 * not pinned.
 * @param {CodeMapFile[]} files
 * @param {string} request
 * @param {{ limit?: number }} [options]
 * @returns {{ pinned: NamedFile[], definers: NamedFile[], symbols: string[] }}
 */
export function resolveNamedFiles(files, request, options = {}) {
  const { paths, symbols } = requestLiterals(request);
  const candidates = files.filter((file) => !file.isVendor);
  /** @type {NamedFile[]} */
  const pinned = [];
  /** @type {Map<string, NamedFile>} */
  const definers = new Map();
  /** @type {Set<string>} */
  const taken = new Set();

  for (const literal of paths) {
    const matches = matchNamedPath(candidates, literal);
    if (matches.length === 0 || matches.length > MAX_FILES_PER_LITERAL) continue;
    for (const file of matches) {
      if (taken.has(file.path)) continue;
      taken.add(file.path);
      pinned.push({ path: file.path, rule: "path", literal });
    }
  }

  /** @type {Map<string, number> | undefined} */
  let importers;
  for (const literal of symbols) {
    const owners = candidates.filter(
      (file) =>
        file.kind !== "test" &&
        (file.symbols ?? []).some(
          (symbol) =>
            symbol.name === literal &&
            !ARTIFACT_SYMBOL_TYPES.has(symbol.type) &&
            // A fixture repository's registry names the same tools as the real one.
            !(symbol.type === "registered" && isTestDataPath(file.path)),
        ),
    );
    if (owners.length === 0 || owners.length > MAX_DEFINERS_PER_SYMBOL) continue;
    importers ??= countImporters(files);
    for (const file of owners) {
      const symbol = (file.symbols ?? []).find((item) => item.name === literal && !ARTIFACT_SYMBOL_TYPES.has(item.type));
      const exported = (file.exports ?? []).includes(literal);
      /** @type {NamedFile} */
      const named = { path: file.path, rule: "symbol", literal, line: symbol?.line, importers: importers.get(file.path) ?? 0, exported };
      if (exported && (named.importers ?? 0) > 0) {
        if (taken.has(file.path)) continue;
        taken.add(file.path);
        pinned.push(named);
      } else if (!definers.has(file.path)) {
        definers.set(file.path, named);
      }
    }

    // A registry names a tool as a string and calls the module that does the
    // work: `case "convergence_score":` calls `generateConvergence`, which
    // `converge.js` exports. That module implements the name the request used,
    // so it is pinned like a named file: the most likely owner of the change.
    const implementers = owners.flatMap((owner) => implementersOf(owner, literal, candidates)).slice(0, MAX_IMPLEMENTERS_PER_NAME);
    for (const { file, via } of implementers) {
      if (taken.has(file.path)) continue;
      taken.add(file.path);
      definers.delete(file.path);
      pinned.push({ path: file.path, rule: "implements", literal, via });
    }
  }

  const limit = options.limit ?? pinned.length;
  return { pinned: pinned.slice(0, limit), definers: [...definers.values()].filter((named) => !taken.has(named.path)), symbols };
}

/**
 * The files a registry imports a registered name's work from: the modules,
 * among those the registry imports, that export a function its entry calls.
 * @param {CodeMapFile} registry
 * @param {string} literal
 * @param {CodeMapFile[]} files
 * @returns {{ file: CodeMapFile, via: string }[]}
 */
function implementersOf(registry, literal, files) {
  // A fixture repository's registry names the same tools as the real one; its
  // modules implement nothing in this repository.
  if (isTestDataPath(registry.path)) return [];
  const calls = (registry.symbols ?? []).find((symbol) => symbol.type === "registered" && symbol.name === literal)?.terms ?? [];
  if (calls.length === 0) return [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const fileSet = new Set(byPath.keys());
  const nameWords = new Set(identifierWords(literal));
  /** @type {{ file: CodeMapFile, via: string, overlap: number }[]} */
  const found = [];
  for (const specifier of registry.imports ?? []) {
    const target = resolveImportSpecifier(registry.path, specifier, fileSet);
    const file = target && target !== registry.path ? byPath.get(target) : undefined;
    if (!file || file.kind === "test" || isTestDataPath(file.path) || found.some((entry) => entry.file === file)) continue;
    const called = calls.filter((call) => (file.exports ?? []).includes(call));
    if (called.length === 0) continue;
    const overlap = Math.max(...called.map((call) => identifierWords(call).filter((word) => nameWords.has(word)).length));
    found.push({ file, via: registry.path, overlap });
  }
  // A branch also calls shared helpers (`contextRepoPaths` beside
  // `generateContextPack`). The module whose function shares the most words
  // with the name does the work; with no shared word at all, none is preferred.
  const best = Math.max(0, ...found.map((entry) => entry.overlap));
  return found.filter((entry) => entry.overlap === best).map(({ file, via }) => ({ file, via }));
}

/**
 * The lowercase words of an identifier: `generateContextPack` and
 * `context_pack` both give `context` and `pack`.
 * @param {string} identifier
 * @returns {string[]}
 */
function identifierWords(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * @param {CodeMapFile[]} files
 * @param {string} literal
 * @returns {CodeMapFile[]}
 */
function matchNamedPath(files, literal) {
  const wanted = literal.toLowerCase();
  const stem = (/** @type {string} */ value) => value.replace(/\.[^./]+$/, "");
  /** @param {(value: string) => string} shape */
  const matching = (shape) =>
    files.filter((file) => {
      const candidate = shape(file.path.toLowerCase());
      const target = shape(wanted);
      return candidate === target || candidate.endsWith(`/${target}`);
    });
  if (!trailingExtension.test(wanted)) return matching(stem);
  const exact = matching((value) => value);
  // `event-service.js` in a TypeScript ESM repository names `event-service.ts`.
  return exact.length ? exact : matching(stem);
}

const importSuffixes = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * How many non-test files import each file, resolving relative specifiers and
 * the root aliases (`@/`, `~/`, `#/`) that application code uses for most of
 * its imports. Bare package specifiers name dependencies, not files.
 * @param {CodeMapFile[]} files
 * @returns {Map<string, number>}
 */
function countImporters(files) {
  return importDegrees(files).importers;
}

/**
 * The import graph as two counts per file: how many non-test files import it,
 * and how many repository files it imports. Specifiers resolve as in
 * `resolveImportSpecifier`; a bare package specifier is a dependency, not an
 * edge.
 * @param {CodeMapFile[]} files
 * @returns {{ importers: Map<string, number>, imports: Map<string, number> }}
 */
export function importDegrees(files) {
  const fileSet = new Set(files.map((file) => file.path));
  /** @type {Map<string, number>} */
  const importers = new Map();
  /** @type {Map<string, number>} */
  const imports = new Map();
  for (const file of files) {
    if (file.kind === "test" || file.isVendor) continue;
    /** @type {Set<string>} */
    const targets = new Set();
    for (const specifier of file.imports ?? []) {
      const target = resolveImportSpecifier(file.path, specifier, fileSet);
      if (target && target !== file.path) targets.add(target);
    }
    if (targets.size) imports.set(file.path, targets.size);
    for (const target of targets) importers.set(target, (importers.get(target) ?? 0) + 1);
  }
  return { importers, imports };
}

/**
 * The file in `fileSet` an import specifier names: a relative specifier from
 * `fromPath`, or a root alias (`@/lib/x`, `~/lib/x`, `#/lib/x`) from the
 * repository root or `src/`.
 * @param {string} fromPath
 * @param {string} specifier
 * @param {Set<string>} fileSet
 * @returns {string | undefined}
 */
export function resolveImportSpecifier(fromPath, specifier, fileSet) {
  /** @type {string[]} */
  let bases;
  if (specifier.startsWith(".")) {
    bases = [path.posix.join(path.posix.dirname(fromPath), specifier)];
  } else {
    const alias = /^[@~#]\/(.+)$/.exec(specifier);
    if (!alias) return undefined;
    bases = [alias[1], `src/${alias[1]}`];
  }
  for (const base of bases) {
    const normalized = path.posix.normalize(base).replace(/^\.\//, "");
    // TypeScript ESM imports name the emitted `.js`; the source is `.ts`.
    const stems = /\.[cm]?js$/.test(normalized) ? [normalized, normalized.replace(/\.([cm]?)js$/, ".$1ts"), normalized.replace(/\.js$/, ".tsx")] : [normalized];
    for (const stem of stems) {
      for (const suffix of importSuffixes) {
        if (fileSet.has(`${stem}${suffix}`)) return `${stem}${suffix}`;
      }
    }
  }
  return undefined;
}

/**
 * Fold the locale variants of one translation catalog into its highest-ranked
 * member, keeping list order, and record the others in that member's
 * `siblings`. A catalog is one owner whatever the number of locales it ships
 * in; five locales used to take five of twelve ranked slots. An entry
 * `isPinned` marks (exact Git diff evidence, a file the request names) is
 * never folded away.
 * @template {{ siblings?: string[] }} T
 * @param {T[]} entries in rank order
 * @param {(entry: T) => { path: string, kind: string, scope?: string }} describe
 * @param {(entry: T) => boolean} [isPinned]
 * @returns {T[]}
 */
export function collapseLocaleSiblings(entries, describe, isPinned = () => false) {
  /** @type {Map<string, T>} */
  const heads = new Map();
  /** @type {T[]} */
  const kept = [];
  for (const entry of entries) {
    const { path: filePath, kind, scope = "" } = describe(entry);
    const catalog = kind === "translation" ? localeCatalogKey(filePath) : null;
    const group = catalog ? `${scope}\0${catalog}` : null;
    const head = group ? heads.get(group) : undefined;
    if (!group || !head || isPinned(entry)) {
      if (group && !head) heads.set(group, entry);
      kept.push(entry);
      continue;
    }
    head.siblings = [...new Set([...(head.siblings ?? []), filePath, ...(entry.siblings ?? [])])];
  }
  return kept;
}

/**
 * `en-NG, en-US, fr` for a list of sibling catalog paths.
 * @param {string[]} siblings
 * @returns {string}
 */
export function formatLocales(siblings) {
  return siblings.map((sibling) => localeOf(sibling) ?? sibling).join(", ");
}
