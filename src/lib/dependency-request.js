// Dependency requests: "upgrade vulnerable yarn dependencies (handlebars, tar,
// shell-quote)", "bump lint-staged to 17", "npm audit fix". The files such a
// request changes are manifests and lockfiles, which the code map does not
// index as source, and the words it uses ("upgrade", "package", "quote" out of
// `shell-quote`) name unrelated source modules. Dogfood misses (2026-10-22):
// `shell-quote` ranked quote-templates.controller.ts as a required owner,
// "handlebars" pulled in every email template, and "package" and "upgrade"
// ranked PackageSelector.tsx and EmailQuotaUpgradeModal.tsx, while yarn.lock
// and package-lock.json were never listed.
//
// This module recognises the request, names the dependency files it owns, and
// returns the request with package names and dependency vocabulary removed, so
// what is left (a call site, a symbol) still ranks source files normally.

import path from "node:path";

/**
 * @typedef {object} DependencyFile
 * @property {string} path
 * @property {"manifest" | "lockfile" | "config"} role
 * @property {string} ecosystem
 * @property {string} [manager] the package manager a lockfile or config belongs to
 * @property {string[]} [packages] names a manifest declares, or a lockfile resolves
 */

/**
 * @typedef {object} DependencyRequest
 * @property {string[]} packages package names the request names
 * @property {string} scoringQuery the request without package names or dependency vocabulary
 * @property {string[]} required dependency files the change owns
 * @property {string[]} supporting dependency files the change may touch
 */

/** @type {{ basename: string | RegExp, role: DependencyFile["role"], ecosystem: string, manager?: string }[]} */
const DEPENDENCY_FILES = [
  { basename: "package.json", role: "manifest", ecosystem: "node" },
  { basename: "package-lock.json", role: "lockfile", ecosystem: "node", manager: "npm" },
  { basename: "npm-shrinkwrap.json", role: "lockfile", ecosystem: "node", manager: "npm" },
  { basename: ".npmrc", role: "config", ecosystem: "node", manager: "npm" },
  { basename: "yarn.lock", role: "lockfile", ecosystem: "node", manager: "yarn" },
  { basename: ".yarnrc.yml", role: "config", ecosystem: "node", manager: "yarn" },
  { basename: ".yarnrc", role: "config", ecosystem: "node", manager: "yarn" },
  { basename: "pnpm-lock.yaml", role: "lockfile", ecosystem: "node", manager: "pnpm" },
  { basename: "pnpm-workspace.yaml", role: "config", ecosystem: "node", manager: "pnpm" },
  { basename: "bun.lock", role: "lockfile", ecosystem: "node", manager: "bun" },
  { basename: "bun.lockb", role: "lockfile", ecosystem: "node", manager: "bun" },
  { basename: /^requirements(?:[-_.][\w.-]+)?\.txt$/, role: "manifest", ecosystem: "python" },
  { basename: "pyproject.toml", role: "manifest", ecosystem: "python" },
  { basename: "Pipfile", role: "manifest", ecosystem: "python" },
  { basename: "Pipfile.lock", role: "lockfile", ecosystem: "python", manager: "pipenv" },
  { basename: "poetry.lock", role: "lockfile", ecosystem: "python", manager: "poetry" },
  { basename: "uv.lock", role: "lockfile", ecosystem: "python", manager: "uv" },
  { basename: "go.mod", role: "manifest", ecosystem: "go" },
  { basename: "go.sum", role: "lockfile", ecosystem: "go" },
  { basename: "Cargo.toml", role: "manifest", ecosystem: "rust" },
  { basename: "Cargo.lock", role: "lockfile", ecosystem: "rust" },
  { basename: "Gemfile", role: "manifest", ecosystem: "ruby" },
  { basename: "Gemfile.lock", role: "lockfile", ecosystem: "ruby" },
  { basename: "composer.json", role: "manifest", ecosystem: "php" },
  { basename: "composer.lock", role: "lockfile", ecosystem: "php" },
];

// Words that mean dependencies on their own (kept in step with the dependency
// concept in risk-paths.js).
const DEPENDENCY_WORDS = new Set(["dependency", "dependencies", "deps", "dep", "dependabot", "renovate", "lockfile", "lockfiles"]);
// A package manager names an ecosystem, and with it, which lockfile.
/** @type {Record<string, { ecosystem: string, manager?: string }>} */
const MANAGER_WORDS = {
  npm: { ecosystem: "node", manager: "npm" },
  yarn: { ecosystem: "node", manager: "yarn" },
  pnpm: { ecosystem: "node", manager: "pnpm" },
  bun: { ecosystem: "node", manager: "bun" },
  pip: { ecosystem: "python" },
  pipenv: { ecosystem: "python", manager: "pipenv" },
  poetry: { ecosystem: "python", manager: "poetry" },
  cargo: { ecosystem: "rust" },
  bundler: { ecosystem: "ruby" },
  composer: { ecosystem: "php" },
};
// Package-manager commands that change dependencies: `yarn up`, `npm install`.
const MANAGER_COMMANDS = new Set(["up", "add", "install", "remove", "dedupe", "outdated"]);
// "Advisory" alone also names UI copy and Solumbe's own advisory files, so it
// is dropped from a dependency request but does not make one.
const SECURITY_WORDS = new Set(["vulnerable", "vulnerability", "vulnerabilities", "cve", "cves", "ghsa"]);
const ADVISORY_WORDS = new Set(["advisory", "advisories"]);
// "upgrade" and "bump" also name pricing tiers and releases, so they imply a
// dependency request only beside a package manager, a vulnerability, or a
// package named with a version. "update" and "patch" say even less: a
// vulnerability is patched in code as often as in a lockfile.
const STRICT_UPGRADE_WORDS = new Set(["upgrade", "upgrades", "upgraded", "upgrading", "bump", "bumps", "bumped", "bumping", "downgrade"]);
const UPGRADE_WORDS = new Set([...STRICT_UPGRADE_WORDS, ...["update", "updates", "updated", "updating", "patch", "patched", "patches", "pin", "unpin"]]);
// Words a dependency request uses about the dependencies, never about a source
// module. Dropped from the scoring query once the request is read as one.
const DEPENDENCY_VOCABULARY = new Set([
  ...DEPENDENCY_WORDS,
  ...Object.keys(MANAGER_WORDS),
  ...MANAGER_COMMANDS,
  ...SECURITY_WORDS,
  ...ADVISORY_WORDS,
  ...UPGRADE_WORDS,
  ...["audit", "security", "severity", "high", "critical", "moderate", "low", "minor", "major", "latest", "version", "versions"],
  ...["transitive", "override", "overrides", "resolution", "resolutions", "package", "packages", "manifest", "manifests", "lock"],
  ...["apply", "fix", "fixes", "install", "reinstall", "to", "and", "the", "all", "other", "remaining"],
]);

const SOURCE_FILE_NAME = /\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt|cs|php|swift|md|mdx|json|ya?ml|toml|hbs|sql|prisma)$/i;

/**
 * @param {string} file repository-relative path
 * @returns {Omit<DependencyFile, "path" | "packages"> | undefined}
 */
function describeDependencyFile(file) {
  const basename = path.posix.basename(file);
  if (/(^|\/)(node_modules|vendor|\.yarn)\//.test(file)) return undefined;
  const match = DEPENDENCY_FILES.find((entry) => (typeof entry.basename === "string" ? entry.basename === basename : entry.basename.test(basename)));
  if (!match) return undefined;
  return { role: match.role, ecosystem: match.ecosystem, ...(match.manager ? { manager: match.manager } : {}) };
}

/** @param {string} file @returns {boolean} */
export function isDependencyFilePath(file) {
  return describeDependencyFile(file) !== undefined;
}

/**
 * The repository's dependency manifests, lockfiles and package-manager config,
 * with the package names each manifest declares and each lockfile resolves.
 * @param {Iterable<string>} files repository-relative paths
 * @param {(file: string) => string} readText
 * @returns {DependencyFile[]}
 */
export function summarizeDependencyFiles(files, readText) {
  /** @type {DependencyFile[]} */
  const found = [];
  for (const file of files) {
    const described = describeDependencyFile(file);
    if (!described) continue;
    const packages = described.role === "config" ? undefined : packageNames(file, described.role, readText);
    found.push({ path: file, ...described, ...(packages?.length ? { packages } : {}) });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** @param {string} file @returns {boolean} a manifest or lockfile, whose package names are read */
export function isDependencyListPath(file) {
  const role = describeDependencyFile(file)?.role;
  return role === "manifest" || role === "lockfile";
}

/**
 * @param {string} file
 * @param {"manifest" | "lockfile"} role
 * @param {(file: string) => string} readText
 * @returns {string[] | undefined}
 */
function packageNames(file, role, readText) {
  let text;
  try {
    text = readText(file) ?? "";
  } catch {
    return undefined;
  }
  const names = role === "manifest" ? declaredPackages(path.posix.basename(file), text) : resolvedPackages(path.posix.basename(file), text);
  return [...new Set(names.map((name) => name.toLowerCase()))].sort();
}

/**
 * @param {string} basename
 * @param {string} text
 * @returns {string[]}
 */
function declaredPackages(basename, text) {
  if (basename === "package.json" || basename === "composer.json") {
    const json = parseJson(text);
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "require", "require-dev"];
    return sections.flatMap((section) => Object.keys(json?.[section] ?? {}));
  }
  if (basename.endsWith(".txt")) {
    return text.split(/\r?\n/).flatMap(
      (line) =>
        line
          .replace(/#.*$/, "")
          .trim()
          .match(/^([A-Za-z0-9][\w.-]*)/)?.[1] ?? [],
    );
  }
  if (basename === "go.mod") return [...text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v\d/gm)].map((match) => match[1]);
  if (basename === "Gemfile") return [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  return [];
}

/**
 * Every package a lockfile resolves, transitive ones included: an advisory
 * names `shell-quote` or `handlebars` whether or not a manifest declares it.
 * @param {string} basename
 * @param {string} text
 * @returns {string[]}
 */
function resolvedPackages(basename, text) {
  if (basename === "yarn.lock") {
    // `"@scope/name@npm:^1.0.0", name@^2:` at the start of a line.
    return text
      .split(/\r?\n/)
      .filter((line) => /^[^\s#]/.test(line) && line.trimEnd().endsWith(":"))
      .flatMap((line) => line.split(/,\s*/).flatMap((spec) => spec.match(/^"?(@?[^@\s",]+)@/)?.[1] ?? []));
  }
  if (basename === "package-lock.json" || basename === "npm-shrinkwrap.json") {
    const json = parseJson(text);
    const keys = [...Object.keys(json?.packages ?? {}), ...Object.keys(json?.dependencies ?? {})];
    return keys.flatMap((key) => key.match(/(?:^|node_modules\/)((?:@[^/]+\/)?[^/]+)$/)?.[1] ?? []);
  }
  if (basename === "pnpm-lock.yaml" || basename === "bun.lock") {
    return [...text.matchAll(/^\s+['"]?\/?((?:@[\w.-]+\/)?[\w.-]+)[@/]\d/gm)].map((match) => match[1]);
  }
  if (/^(?:Cargo|poetry|uv)\.lock$/.test(basename)) return [...text.matchAll(/^name = "([^"]+)"/gm)].map((match) => match[1]);
  if (basename === "go.sum") return text.split(/\r?\n/).flatMap((line) => line.split(/\s+/)[0] || []);
  if (basename === "Gemfile.lock") return [...text.matchAll(/^ {4}([\w.-]+) \(/gm)].map((match) => match[1]);
  if (basename === "Pipfile.lock" || basename === "composer.lock") {
    const json = parseJson(text);
    const groups = basename === "Pipfile.lock" ? [json?.default, json?.develop] : [];
    const listed = basename === "composer.lock" ? [...(json?.packages ?? []), ...(json?.["packages-dev"] ?? [])].map((entry) => entry?.name) : [];
    return [...groups.flatMap((group) => Object.keys(group ?? {})), ...listed].filter((name) => typeof name === "string");
  }
  return [];
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read a request as a dependency request, or return undefined when it is not
 * one.
 * @param {string} query
 * @param {DependencyFile[]} [dependencyFiles] the repository's, from its code map
 * @returns {DependencyRequest | undefined}
 */
export function readDependencyRequest(query, dependencyFiles = []) {
  const text = String(query ?? "");
  /** @type {string[]} */
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const literals = requestLiterals(text);
  // A package the repository resolves anywhere (a lockfile lists transitive
  // ones) is a package name in this request, never words to match source by.
  const known = new Set(dependencyFiles.flatMap((file) => file.packages ?? []));
  const namedFiles = literals.filter((literal) => isDependencyFilePath(literal));
  const has = (/** @type {Set<string>} */ set) => words.some((word) => set.has(word));
  const managers = words.filter((word) => Object.hasOwn(MANAGER_WORDS, word));
  const advisoryId = /\b(?:cve-\d{4}-\d+|ghsa(?:-[a-z0-9]{4}){3})\b/i.test(text);
  const upgrade = has(UPGRADE_WORDS);
  const strictUpgrade = has(STRICT_UPGRADE_WORDS);
  // A known package upgraded to a version: "bump lint-staged to 17",
  // "upgrade @stream-io/node-sdk to 0.8". A plain word a manifest declares
  // ("update the stripe webhook") needs the version to count.
  const versioned = /(?:^|[\s@])(?:v|\^|~)?\d+(?:\.\d+)*(?:[\s,;)]|$)/.test(text);
  const namesPackage = literals.some((literal) => known.has(packageName(literal)) && (versioned || isPackageShaped(literal)));
  const isDependency =
    has(DEPENDENCY_WORDS) ||
    namedFiles.length > 0 ||
    (managers.length > 0 && (upgrade || has(SECURITY_WORDS) || words.includes("audit") || has(MANAGER_COMMANDS))) ||
    (has(SECURITY_WORDS) && strictUpgrade) ||
    (advisoryId && upgrade) ||
    (strictUpgrade && namesPackage);
  if (!isDependency) return undefined;

  const packages = [];
  const kept = [];
  for (const literal of literals) {
    const name = packageName(literal);
    if (isDependencyFilePath(literal) || /^v?\d[\w.^~*<>=-]*$/i.test(literal)) continue;
    // A path or file name names a file outright and is kept whole for
    // named-file pinning, unless the repository resolves it (`chart.js`).
    const fileShaped = literal.includes("/") || SOURCE_FILE_NAME.test(literal);
    if (known.has(name) || (!fileShaped && isPackageShaped(literal))) {
      packages.push(name);
      continue;
    }
    if (fileShaped) {
      kept.push(literal);
      continue;
    }
    const remaining = literal.split(/[^A-Za-z0-9_]+/).filter((word) => word && !DEPENDENCY_VOCABULARY.has(word.toLowerCase()));
    if (remaining.length) kept.push(remaining.join(" "));
  }

  const { required, supporting } = ownedDependencyFiles(dependencyFiles, { managers, packages, namedFiles });
  return { packages: [...new Set(packages)], scoringQuery: kept.join(" "), required, supporting };
}

/**
 * Whitespace-separated literals of a request, without surrounding punctuation.
 * @param {string} text
 * @returns {string[]}
 */
function requestLiterals(text) {
  return text
    .split(/[\s,;()[\]{}"'`]+/)
    .map((literal) => literal.replace(/^[.:!?]+|[.:!?]+$/g, "").replace(/^\.?\//, ""))
    .filter(Boolean);
}

/**
 * `tar@7.5.2` names `tar`; `@scope/name@1.0` names `@scope/name`.
 * @param {string} literal
 */
function packageName(literal) {
  return literal.toLowerCase().replace(/(?!^)@[^/]*$/, "");
}

/**
 * A literal that can only be a package name in a dependency request: scoped
 * (`@stream-io/node-sdk`), hyphenated or dotted (`shell-quote`, `socket.io`),
 * or pinned to a version (`tar@7.5.2`). Splitting one into words is what
 * matched `shell-quote` to quote-templates.controller.ts.
 * @param {string} literal
 */
function isPackageShaped(literal) {
  if (/^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?:@.*)?$/i.test(literal)) return true;
  if (/^[a-z0-9][\w.-]*@[\w.^~*<>=-]+$/i.test(literal)) return true;
  if (/^(?:cve|ghsa)-/i.test(literal)) return false;
  return /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+$/.test(literal);
}

/**
 * The dependency files a request owns. Manifests declaring a named package and
 * the lockfile beside them are required. A request that names packages no
 * manifest declares is a transitive fix, settled in the lockfile, so the
 * manifest is only supporting there (an override may still land in it). With
 * no package named, the top-level manifest and lockfile are required.
 * Package-manager config is supporting.
 * @param {DependencyFile[]} files
 * @param {{ managers: string[], packages: string[], namedFiles: string[] }} request
 * @returns {{ required: string[], supporting: string[] }}
 */
function ownedDependencyFiles(files, { managers, packages, namedFiles }) {
  const wanted = managers.map((word) => MANAGER_WORDS[word]);
  const ecosystems = new Set(wanted.map((entry) => entry.ecosystem));
  const managerNames = new Set(wanted.flatMap((entry) => (entry.manager ? [entry.manager] : [])));
  const inScope = files.filter(
    (file) => (ecosystems.size === 0 || ecosystems.has(file.ecosystem)) && (!file.manager || managerNames.size === 0 || managerNames.has(file.manager)),
  );
  const named = new Set(packages);
  const declaring = inScope.filter((file) => file.role === "manifest" && (file.packages ?? []).some((name) => named.has(name)));
  const depth = (/** @type {string} */ file) => (dirOf(file) ? dirOf(file).split("/").length : 0);
  const shallowest = Math.min(...inScope.filter((file) => file.role !== "config").map((file) => depth(file.path)));
  const anchors = new Set(
    declaring.length ? declaring.map((file) => dirOf(file.path)) : inScope.filter((file) => depth(file.path) === shallowest).map((file) => dirOf(file.path)),
  );
  // A workspace package's lockfile and config live at the workspace root.
  const reaches = (/** @type {string} */ dir) => [...anchors].some((anchor) => anchor === dir || dir === "" || anchor.startsWith(`${dir}/`));

  /** @type {Set<string>} */
  const required = new Set();
  /** @type {Set<string>} */
  const supporting = new Set();
  for (const file of inScope) {
    const dir = dirOf(file.path);
    if (file.role === "manifest") {
      if (!anchors.has(dir)) continue;
      if (named.size === 0 || declaring.includes(file)) required.add(file.path);
      else supporting.add(file.path);
    } else if (reaches(dir)) {
      (file.role === "lockfile" ? required : supporting).add(file.path);
    }
  }
  for (const literal of namedFiles) {
    const file = files.find((entry) => entry.path === literal) ?? files.find((entry) => path.posix.basename(entry.path) === literal && depth(entry.path) === 0);
    if (file) {
      supporting.delete(file.path);
      required.add(file.path);
    }
  }
  return { required: [...required].sort(), supporting: [...supporting].filter((file) => !required.has(file)).sort() };
}

/** @param {string} file */
function dirOf(file) {
  const dir = path.posix.dirname(file);
  return dir === "." ? "" : dir;
}

/**
 * A code-map record for a dependency file, which the code map does not index
 * as source, so the rankers can carry it beside source files.
 * @param {string} file
 * @returns {any}
 */
export function dependencyFileRecord(file) {
  return {
    path: file,
    kind: "dependency",
    domain: "dependencies",
    domains: ["dependencies"],
    route: undefined,
    controllerBasePath: undefined,
    httpMethods: [],
    imports: [],
    exports: [],
    symbols: [],
    formFields: [],
    navigationTargets: [],
    localIdentifiers: [],
    isVendor: false,
  };
}
