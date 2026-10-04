import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./tools.js";

const ignoredDirs = new Set([
  ".git",
  ".husky",
  ".vscode",
  ".solumbe",
  ".augment",
  ".claude",
  ".codex",
  ".worktrees",
  ".yarn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "database-backups",
  "backups",
  "documentation",
  ".next",
  "playwright-report",
  "storybook-static",
  "test-results",
  ".turbo",
  ".cache",
  "target",
  "vendor",
]);

const languageByExtension = new Map([
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".py", "Python"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".java", "Java"],
  [".kt", "Kotlin"],
  [".swift", "Swift"],
  [".rb", "Ruby"],
  [".php", "PHP"],
  [".cs", "C#"],
  [".json", "JSON"],
  [".md", "Markdown"],
  [".yml", "YAML"],
  [".yaml", "YAML"],
  [".toml", "TOML"],
]);

const maxInspectedFiles = 200;

/** @param {string} [repoPath] */
export function inspectRepo(repoPath = ".") {
  const root = path.resolve(repoPath);
  if (!fs.existsSync(root)) {
    throw new Error(`repo path does not exist: ${root}`);
  }

  const files = listRepoFiles(root);
  const packageJson = readJsonIfExists(path.join(root, "package.json"));
  const languageCounts = countLanguages(files);
  const scripts = packageJson?.scripts ?? {};

  return {
    ok: true,
    root,
    fileCount: files.length,
    package: summarizePackage(packageJson),
    languages: [...languageCounts.entries()]
      .map(([language, count]) => ({ language, count }))
      .sort((a, b) => b.count - a.count || languagePriority(a.language) - languagePriority(b.language) || a.language.localeCompare(b.language)),
    packageManagers: detectPackageManagers(root, packageJson),
    scripts,
    scriptNames: Object.keys(scripts),
    entrypoints: detectEntrypoints(root, files, packageJson),
    importantDirectories: detectImportantDirectories(root),
    git: getGitInfo(root),
    files: files.slice(0, maxInspectedFiles),
    filesTruncated: files.length > maxInspectedFiles,
  };
}

// The full scripts map can be the single heaviest part of an inspection on a
// large monorepo (long build/test command bodies). Drop the bodies by default
// so an agent still sees the script NAMES (via scriptNames) but pays no byte
// cost for command text, and only keep the full map when explicitly asked.
/**
 * @param {Record<string, unknown> | null | undefined} result
 * @param {boolean} includeScripts
 * @returns {Record<string, unknown> | null | undefined}
 */
export function gateInspectScripts(result, includeScripts) {
  if (includeScripts || !result || typeof result !== "object") {
    return result;
  }
  const { scripts: _scripts, ...rest } = result;
  return rest;
}

/**
 * @param {string} language
 * @returns {number}
 */
function languagePriority(language) {
  /** @type {Record<string, number>} */
  const priorities = {
    TypeScript: 1,
    JavaScript: 2,
    Python: 3,
    Go: 4,
    Rust: 5,
    Swift: 6,
    Kotlin: 7,
    Java: 8,
    JSON: 20,
    Markdown: 21,
    YAML: 22,
    TOML: 23,
  };
  return priorities[language] ?? 10;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function walk(root) {
  /** @type {string[]} */
  const results = [];
  visit(root);
  return results.sort();

  /** @param {string} current */
  function visit(current) {
    const entries = safeReadDir(current);
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) {
        continue;
      }

      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);

      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && !isIgnoredFile(entry.name, relative)) {
        results.push(relative);
      }
    }
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
export function listRepoFiles(root) {
  const gitFiles = gitTrackedAndUntrackedFiles(root);
  if (gitFiles.length) {
    return gitFiles;
  }

  return walk(root);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function gitTrackedAndUntrackedFiles(root) {
  const result = runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    timeout: 10000,
  });
  if (!result.ok) {
    return [];
  }

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const files = [];
  for (const file of result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (seen.has(file) || isIgnoredRepoPath(file) || !fs.existsSync(path.join(root, file))) {
      continue;
    }
    seen.add(file);
    files.push(file);
  }
  return files.sort();
}

/**
 * @param {string} fileName
 * @param {string} [relativePath]
 * @returns {boolean}
 */
function isIgnoredFile(fileName, relativePath = fileName) {
  const extension = path.extname(fileName).toLowerCase();
  // SQL is skipped as dumps and backups, except a migration: that is source.
  if (extension === ".sql" && /(^|[\\/])migrations?[\\/]/i.test(relativePath)) return false;
  return (
    fileName === ".DS_Store" ||
    fileName === ".eslintcache" ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName.endsWith(".log") ||
    fileName.endsWith(".tsbuildinfo") ||
    [".pem", ".key", ".crt", ".p12", ".sql", ".gz", ".tar"].includes(extension)
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isIgnoredRepoPath(filePath) {
  const segments = filePath.split(path.sep);
  return segments.some((segment, index) => ignoredDirs.has(segment) || isIgnoredFile(segment, index === segments.length - 1 ? filePath : segment));
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
 * @param {string} filePath
 * @returns {any}
 */
function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * @param {string[]} files
 * @returns {Map<string, number>}
 */
function countLanguages(files) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const file of files) {
    const language = languageByExtension.get(path.extname(file));
    if (!language) {
      continue;
    }
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
}

/** @param {any} packageJson */
function summarizePackage(packageJson) {
  if (!packageJson) {
    return undefined;
  }

  return {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    private: packageJson.private,
    packageManager: packageJson.packageManager,
    bin: packageJson.bin,
  };
}

/**
 * @param {string} root
 * @param {any} packageJson
 * @returns {string[]}
 */
function detectPackageManagers(root, packageJson) {
  /** @type {[string, string][]} */
  const checks = [
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["requirements.txt", "pip"],
    ["pyproject.toml", "python"],
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["Gemfile", "bundler"],
  ];
  /** @type {Set<string>} */
  const managers = new Set();
  const declaredManager = parsePackageManager(packageJson?.packageManager);
  if (declaredManager) {
    managers.add(declaredManager);
  }

  for (const [file, manager] of checks) {
    if (fs.existsSync(path.join(root, file))) {
      managers.add(manager);
    }
  }

  if (packageJson && !managers.size) {
    managers.add("npm");
  }

  return [...managers];
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function parsePackageManager(value) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.split("@")[0];
}

/**
 * @param {string} root
 * @param {string[]} files
 * @param {any} packageJson
 * @returns {string[]}
 */
function detectEntrypoints(root, files, packageJson) {
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const key of ["main", "module", "types"]) {
    if (typeof packageJson?.[key] === "string") {
      candidates.add(packageJson[key]);
    }
  }

  for (const file of packageBinEntrypoints(packageJson)) {
    candidates.add(file);
  }

  for (const file of ["src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js", "main.py", "cmd/main.go"]) {
    if (files.includes(file) || fs.existsSync(path.join(root, file))) {
      candidates.add(file);
    }
  }

  // A Go module's binaries live at the root `main.go` or under `cmd/<name>/main.go`.
  for (const file of files) {
    if (file === "main.go" || /^cmd\/[^/]+\/main\.go$/.test(file.replaceAll("\\", "/"))) candidates.add(file);
  }

  for (const file of ["src/main.ts", "main.ts", "middleware.ts", "next.config.js", "next.config.mjs", "next.config.ts"]) {
    if (files.includes(file) || fs.existsSync(path.join(root, file))) {
      candidates.add(file);
    }
  }

  if (packageJson?.dependencies?.next || packageJson?.devDependencies?.next) {
    for (const file of ["app/page.tsx", "app/layout.tsx", "pages/index.tsx", "src/app/page.tsx", "src/pages/index.tsx"]) {
      if (files.includes(file) || fs.existsSync(path.join(root, file))) {
        candidates.add(file);
      }
    }
  }

  return [...candidates];
}

/**
 * @param {any} packageJson
 * @returns {string[]}
 */
function packageBinEntrypoints(packageJson) {
  const bin = packageJson?.bin;
  if (typeof bin === "string") {
    return [normalizePackagePath(bin)];
  }
  if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
    return [];
  }
  return Object.values(bin)
    .filter((value) => typeof value === "string")
    .map(normalizePackagePath);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizePackagePath(value) {
  return String(value).replace(/^\.\//, "");
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function detectImportantDirectories(root) {
  const candidates = ["src", "app", "apps", "packages", "pages", "lib", "server", "client", "components", "tests", "test", "docs", "scripts", "bin", "cli"];
  return candidates.filter((dir) => fs.existsSync(path.join(root, dir)));
}

/** @param {string} root */
export function getGitInfo(root) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: 5000 });
  if (!result.ok) {
    return { available: false };
  }

  const branch = runCommand("git", ["branch", "--show-current"], { cwd: root, timeout: 5000 });
  const commit = runCommand("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeout: 5000 });
  const status = runCommand("git", ["status", "--short", "--branch"], { cwd: root, timeout: 5000 });
  const statusLines = status.stdout.trim().split("\n").filter(Boolean);
  const branchLine = statusLines[0] ?? "";
  const changeLines = statusLines.slice(1);
  // `## main...origin/main [ahead 1, behind 10]`, against the last fetch. A
  // checkout behind its upstream is analysed as it was, not as it is.
  const upstream = /^## [^ ]+?\.\.\.([^ ]+)/.exec(branchLine)?.[1];
  const ahead = Number(/\bahead (\d+)/.exec(branchLine)?.[1] ?? 0);
  const behind = Number(/\bbehind (\d+)/.exec(branchLine)?.[1] ?? 0);
  return {
    available: true,
    root: result.stdout.trim(),
    branch: branch.stdout.trim() || undefined,
    commit: commit.stdout.trim() || undefined,
    clean: changeLines.length === 0,
    changes: changeLines.length,
    status: branchLine || undefined,
    upstream,
    ahead,
    behind,
  };
}

/**
 * One-line git state for reports: `main @ ccbba9f (clean, 10 behind origin/main)`.
 * @param {{ available?: boolean, branch?: string, commit?: string, clean?: boolean, changes?: number, upstream?: string, behind?: number }} git
 * @returns {string}
 */
export function formatGitSummary(git) {
  if (!git.available) {
    return "not detected";
  }
  const dirty = git.clean ? "clean" : `${git.changes} change(s)`;
  const stale = git.behind ? `, ${git.behind} behind ${git.upstream}` : "";
  return `${git.branch ?? "unknown"} @ ${git.commit ?? "unknown"} (${dirty}${stale})`;
}
