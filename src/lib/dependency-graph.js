import path from "node:path";
import { resolveImportSpecifier } from "./ranking-rules.js";

/**
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 * @typedef {"EXTRACTED" | "INFERRED"} EdgeProvenance
 */

/**
 * @typedef {object} DependencyGraph
 * @property {Map<string, Map<string, EdgeProvenance>>} importersByPath target file -> importing file -> how the edge was found
 * @property {number} edgeCount
 * @property {number} inferredEdgeCount
 */

/**
 * @typedef {object} DependentFile
 * @property {string} path
 * @property {string} kind
 * @property {number} depth import hops from the nearest changed file
 * @property {string} via the file on that path this one imports
 * @property {EdgeProvenance} provenance EXTRACTED only when every hop on the path is
 */

/**
 * The import graph of a code map, each edge labelled with how it was found.
 *
 * An edge is EXTRACTED when the source states it: a relative or root-alias
 * specifier that resolves to one file, or a Go import that names a repository
 * package directory. It is INFERRED when a bare specifier (`utils/format`)
 * matches the name of exactly one source file and no declared package; that
 * guess is right for path-mapped imports and wrong for a package that shares a
 * file's name, so it is labelled rather than trusted.
 * @param {CodeMapFile[]} files
 * @param {{ packages?: Iterable<string> }} [options] package names the dependency manifests declare
 * @returns {DependencyGraph}
 */
export function buildDependencyGraph(files, options = {}) {
  // A doc's links name code it describes, not code it runs.
  const sources = files.filter((file) => !file.isVendor && file.kind !== "doc");
  const fileSet = new Set(sources.map((file) => file.path));
  const packages = new Set(options.packages ?? []);
  /** @type {Map<string, string[]>} */
  const byStem = new Map();
  /** @type {Map<string, string[]>} */
  const goPackages = new Map();
  for (const file of sources) {
    const stem = file.path.replace(/\.[^./]+$/, "");
    for (const key of stemKeys(stem)) byStem.set(key, [...(byStem.get(key) ?? []), file.path]);
    if (file.path.endsWith(".go") && file.kind !== "test") {
      const directory = path.posix.dirname(file.path);
      goPackages.set(directory, [...(goPackages.get(directory) ?? []), file.path]);
    }
  }

  /** @type {Map<string, Map<string, EdgeProvenance>>} */
  const importersByPath = new Map();
  let edgeCount = 0;
  let inferredEdgeCount = 0;
  /** @param {string} target @param {string} importer @param {EdgeProvenance} provenance */
  const addEdge = (target, importer, provenance) => {
    if (target === importer) return;
    const importers = importersByPath.get(target) ?? new Map();
    const existing = importers.get(importer);
    if (existing === "EXTRACTED" || existing === provenance) return;
    if (!existing) edgeCount += 1;
    if (provenance === "INFERRED") inferredEdgeCount += 1;
    else if (existing === "INFERRED") inferredEdgeCount -= 1;
    importers.set(importer, provenance);
    importersByPath.set(target, importers);
  };

  for (const file of sources) {
    for (const specifier of file.imports ?? []) {
      const resolved = resolveImportSpecifier(file.path, specifier, fileSet);
      if (resolved) {
        addEdge(resolved, file.path, "EXTRACTED");
        continue;
      }
      const inferred = inferTarget(specifier, byStem, packages);
      if (inferred) addEdge(inferred, file.path, "INFERRED");
    }
    for (const directory of file.importDirs ?? []) {
      for (const target of goPackages.get(directory || ".") ?? []) addEdge(target, file.path, "EXTRACTED");
    }
  }
  return { importersByPath, edgeCount, inferredEdgeCount };
}

/**
 * Files that import the starting files, directly or through other files, up to
 * `maxDepth` hops. Each file is reported at its shortest distance, and at that
 * distance a path made only of EXTRACTED edges is preferred over one that
 * leans on an INFERRED edge.
 * @param {DependencyGraph} graph
 * @param {Iterable<string>} startPaths
 * @param {CodeMapFile[]} files
 * @param {{ maxDepth?: number, limit?: number }} [options]
 * @returns {{ files: DependentFile[], truncated: boolean }}
 */
export function transitiveDependents(graph, startPaths, files, options = {}) {
  const maxDepth = options.maxDepth ?? 3;
  const limit = options.limit ?? 20;
  const kinds = new Map(files.map((file) => [file.path, file.kind]));
  const starts = new Set(startPaths);
  /** @type {Map<string, DependentFile>} */
  const reached = new Map();
  /** @type {{ path: string, provenance: EdgeProvenance }[]} */
  let frontier = [...starts].sort().map((start) => ({ path: start, provenance: "EXTRACTED" }));
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    /** @type {Map<string, DependentFile>} */
    const layer = new Map();
    for (const node of frontier) {
      for (const [importer, edge] of graph.importersByPath.get(node.path) ?? []) {
        if (starts.has(importer) || reached.has(importer)) continue;
        /** @type {EdgeProvenance} */
        const provenance = node.provenance === "EXTRACTED" && edge === "EXTRACTED" ? "EXTRACTED" : "INFERRED";
        const current = layer.get(importer);
        if (current && (current.provenance === "EXTRACTED" || provenance === "INFERRED")) continue;
        layer.set(importer, { path: importer, kind: kinds.get(importer) ?? "unknown", depth, via: node.path, provenance });
      }
    }
    for (const [filePath, entry] of layer) reached.set(filePath, entry);
    frontier = [...layer.values()].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => ({ path: entry.path, provenance: entry.provenance }));
  }
  const ordered = [...reached.values()].sort(
    (a, b) => a.depth - b.depth || provenanceRank(a.provenance) - provenanceRank(b.provenance) || a.path.localeCompare(b.path),
  );
  return { files: ordered.slice(0, limit), truncated: ordered.length > limit };
}

/**
 * @param {string} specifier
 * @param {Map<string, string[]>} byStem
 * @param {Set<string>} packages
 * @returns {string | undefined}
 */
function inferTarget(specifier, byStem, packages) {
  if (specifier.startsWith(".") || specifier.startsWith("node:") || /^[@~#]\//.test(specifier)) return undefined;
  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (packages.has(packageName)) return undefined;
  // A one-word specifier (`path`, `react`) is far more often a package than a
  // path-mapped module, so only a specifier with a directory is matched.
  if (!specifier.includes("/")) return undefined;
  const key = specifier.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  const candidates = byStem.get(key);
  return candidates?.length === 1 ? candidates[0] : undefined;
}

/**
 * The trailing path segments of a file stem, so `src/utils/format` is found
 * by `utils/format`, and `src/utils/index` by `utils`.
 * @param {string} stem
 * @returns {string[]}
 */
function stemKeys(stem) {
  const segments = stem.replace(/\/index$/, "").split("/");
  /** @type {string[]} */
  const keys = [];
  for (let start = segments.length - 2; start >= 0; start -= 1) keys.push(segments.slice(start).join("/"));
  return keys;
}

/** @param {EdgeProvenance} provenance */
function provenanceRank(provenance) {
  return provenance === "EXTRACTED" ? 0 : 1;
}
