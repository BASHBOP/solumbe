// Release-discipline check ported from pullpass/internal/release/check.go.
// When version-bearing files change, this verifies SemVer + cross-file
// agreement + that the changelog was bumped. Returns the same check record
// shape as the other pass checks: { name, status, summary, details? }.

/// <reference types="node" />

import fs from "node:fs";
import path from "node:path";

/** @typedef {import('./pass-local.js').Check} Check */
/** @typedef {import('./pass-local.js').Verdict} Verdict */
/** @typedef {{ source: string, version: string }} VersionValue */

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const STRING_VERSION_RE = /^\s*version\s*=\s*"([^"]+)"/m;

const VERSION_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "server.json", "pyproject.toml", "cargo.toml"]);

const CHANGELOG_PATHS = new Set(["changelog.md", "docs/changelog.md"]);

/** @type {{ pass: "PASS", warn: "WARN", fail: "FAIL" }} */
export const STATUS = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
};

// `options.baseContent(file)` may return the content of a version file at the
// comparison base (or null/undefined when unavailable). When supplied, every
// rule below only applies if a `version` field actually changed: a dependency
// or lockfile edit that leaves every version untouched is not a release and
// must not be blocked. That includes a package.json with no `version` at all.
//
// `options.headContent(file)` returns the file as it is in the change under
// review (the exact head tree for `--head`/`--staged`, the PR head commit in
// PR mode). It matters because the working tree is not that change: reading
// it there compared a historic base against whatever the checkout happened to
// contain and called every package.json edit a version bump. When it returns
// null the working tree is read, which is right only for working-tree scope.
//
// `options.governance` ("team" or "solo") relaxes only the missing-changelog
// and manual-bump rules: a private (`"private": true`) package under solo
// governance is not publishing releases, so those findings are a WARN instead
// of a FAIL. SemVer violations and version-file mismatches stay FAIL in every
// configuration.
//
// In a Release Please repository the release PR owns `version` and the
// changelog, so a version change anywhere else is the finding ("bumped by
// hand"), not a missing changelog entry. `options.headRefName` identifies a
// release PR by its `release-please--*` branch.
/**
 * @param {string} root
 * @param {string[]} files
 * @param {{ baseContent?: (file: string) => string | null, headContent?: (file: string) => string | null, governance?: string, headRefName?: string }} [options]
 * @returns {Check}
 */
export function checkRelease(root, files, options = {}) {
  const versionFiles = pickVersionFiles(files);
  if (versionFiles.length === 0) {
    return check("Release discipline", STATUS.pass, "No version metadata changes found.");
  }

  const { values, warnings } = readVersions(root, versionFiles, options.headContent);
  if (warnings.length > 0) {
    return check("Release discipline", STATUS.warn, "Version metadata changed, but some files could not be inspected.", warnings);
  }

  const changes = typeof options.baseContent === "function" ? collectVersionChanges(versionFiles, values, options.baseContent) : null;
  if (changes && changes.length === 0) {
    return check(
      "Release discipline",
      STATUS.pass,
      "Version metadata changed but the project version is unchanged (dependency or lockfile update).",
      formatValues(values),
    );
  }

  if (values.length === 0) {
    return check("Release discipline", STATUS.warn, "Version metadata changed, but no supported version value was found.", versionFiles);
  }

  const invalid = values.filter((item) => !SEMVER_RE.test(item.version)).map((item) => `${item.source} -> ${item.version}`);
  if (invalid.length > 0) {
    return check("Release discipline", STATUS.fail, "Version metadata contains non-SemVer values.", invalid);
  }

  const mismatches = collectMismatches(values);
  if (mismatches.length > 0) {
    return check("Release discipline", STATUS.fail, "Version metadata files do not agree.", mismatches);
  }

  if (changes && usesReleasePlease(root, options.baseContent)) {
    if (isReleasePleaseRelease(files, options.headRefName)) {
      return check("Release discipline", STATUS.pass, "Version change comes from a Release Please release PR.", formatValues(values));
    }
    const summary = "Version bumped by hand in a Release Please repository; Release Please owns the version and CHANGELOG.md.";
    const details = [...changes.map(describeChange), "Remove the version change; Release Please bumps it in its own release PR."];
    if (isPrivateSoloRepo(root, options.governance)) {
      return check("Release discipline", STATUS.warn, `${summary} (private package, solo governance)`, details);
    }
    return check("Release discipline", STATUS.fail, summary, details);
  }

  if (!changedChangelog(files)) {
    if (isPrivateSoloRepo(root, options.governance)) {
      return check("Release discipline", STATUS.warn, "Version metadata changed without a changelog update (private package, solo governance).", versionFiles);
    }
    return check("Release discipline", STATUS.fail, "Version metadata changed without a changelog update.", versionFiles);
  }

  return check("Release discipline", STATUS.pass, "Version metadata is SemVer and changelog was updated.", formatValues(values));
}

// A private package under solo governance bumping its version without a
// changelog entry is sloppy, not a release-discipline failure: nothing is
// published and no team relies on the changelog. Anything else (public or
// publishable package, team governance, unreadable package.json) keeps the
// strict behavior.
/**
 * @param {string} root
 * @param {string | undefined} governance
 * @returns {boolean}
 */
function isPrivateSoloRepo(root, governance) {
  if (governance !== "solo") return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return parsed?.private === true;
  } catch {
    return false;
  }
}

/**
 * @typedef {{ source: string, from: string | null, to: string | null }} VersionChange
 */

// Every version value that differs between the base and the change under
// review, per source (`package.json`, `server.json#packages[0]`, ...). A value
// that only exists on one side counts as changed. When the base cannot be read
// at all the head values all count as changed, which keeps the strict path.
/**
 * @param {string[]} versionFiles
 * @param {VersionValue[]} headValues
 * @param {(file: string) => string | null} baseContent
 * @returns {VersionChange[]}
 */
function collectVersionChanges(versionFiles, headValues, baseContent) {
  const head = new Map(headValues.map((item) => [item.source, item.version]));
  /** @type {Map<string, string>} */
  const base = new Map();
  for (const file of versionFiles) {
    for (const item of readBaseValues(file, baseContent)) base.set(item.source, item.version);
  }
  /** @type {VersionChange[]} */
  const changes = [];
  for (const source of [...new Set([...head.keys(), ...base.keys()])].sort()) {
    const from = base.get(source) ?? null;
    const to = head.get(source) ?? null;
    if (from !== to) changes.push({ source, from, to });
  }
  return changes;
}

/**
 * @param {string} file
 * @param {(file: string) => string | null} baseContent
 * @returns {VersionValue[]}
 */
function readBaseValues(file, baseContent) {
  let content;
  try {
    content = baseContent(file);
  } catch {
    content = null;
  }
  if (content == null) return [];
  try {
    return parseVersionFile(file, content);
  } catch {
    // Unparseable base content has no comparable version.
    return [];
  }
}

/** @param {VersionChange} change */
function describeChange(change) {
  return `${change.source}: ${change.from ?? "(none)"} -> ${change.to ?? "(none)"}`;
}

const RELEASE_PLEASE_FILES = ["release-please-config.json", ".release-please-manifest.json"];

// A repository is a Release Please repository when its config or manifest
// exists at the base (the policy the change is judged against) or, failing
// that, in the working tree.
/**
 * @param {string} root
 * @param {((file: string) => string | null) | undefined} baseContent
 * @returns {boolean}
 */
function usesReleasePlease(root, baseContent) {
  return RELEASE_PLEASE_FILES.some((file) => {
    try {
      if (typeof baseContent === "function" && baseContent(file) != null) return true;
    } catch {
      // Fall through to the working tree.
    }
    return fs.existsSync(path.join(root, file));
  });
}

// The release PR is the one change that is supposed to move the version: it
// lives on a `release-please--*` branch and rewrites the manifest.
/**
 * @param {string[]} files
 * @param {string | undefined} headRefName
 * @returns {boolean}
 */
function isReleasePleaseRelease(files, headRefName) {
  if (/^release-please--/.test(String(headRefName ?? ""))) return true;
  return files.some((file) => normalize(file) === ".release-please-manifest.json");
}

/**
 * @param {string[]} files
 * @returns {string[]}
 */
function pickVersionFiles(files) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const matches = [];
  for (const file of files) {
    const normalized = normalize(file);
    if (VERSION_FILES.has(normalized) && !seen.has(normalized)) {
      seen.add(normalized);
      matches.push(normalized);
    }
  }
  matches.sort();
  return matches;
}

/**
 * @param {string[]} files
 * @returns {boolean}
 */
function changedChangelog(files) {
  return files.some((file) => CHANGELOG_PATHS.has(normalize(file)));
}

/**
 * @param {string} root
 * @param {string[]} files
 * @param {((file: string) => string | null) | undefined} headContent
 * @returns {{ values: VersionValue[], warnings: string[] }}
 */
function readVersions(root, files, headContent) {
  /** @type {VersionValue[]} */
  const values = [];
  /** @type {string[]} */
  const warnings = [];
  for (const file of files) {
    let data;
    try {
      data = readHeadFile(root, file, headContent);
    } catch (error) {
      warnings.push(`${file} -> ${/** @type {Error} */ (error)?.message ?? String(error)}`);
      continue;
    }
    try {
      const parsed = parseVersionFile(file, data);
      values.push(...parsed);
    } catch (error) {
      warnings.push(`${file} -> ${/** @type {Error} */ (error)?.message ?? String(error)}`);
    }
  }
  return { values, warnings };
}

// The change's own copy of `file` when the caller can supply it, the working
// tree otherwise.
/**
 * @param {string} root
 * @param {string} file
 * @param {((file: string) => string | null) | undefined} headContent
 * @returns {string}
 */
function readHeadFile(root, file, headContent) {
  if (typeof headContent === "function") {
    let content;
    try {
      content = headContent(file);
    } catch {
      content = null;
    }
    if (typeof content === "string") return content;
  }
  return fs.readFileSync(path.join(root, file), "utf8");
}

/**
 * @param {string} file
 * @param {string} data
 * @returns {VersionValue[]}
 */
function parseVersionFile(file, data) {
  switch (normalize(file)) {
    case "package.json": {
      const version = parseJsonVersion(data);
      return version ? [{ source: file, version }] : [];
    }
    case "package-lock.json":
    case "npm-shrinkwrap.json": {
      const version = parseLockVersion(data);
      return version ? [{ source: file, version }] : [];
    }
    case "server.json": {
      return parseServerManifestVersions(file, data);
    }
    case "pyproject.toml":
    case "cargo.toml": {
      const match = data.match(STRING_VERSION_RE);
      return match ? [{ source: file, version: match[1] }] : [];
    }
    default:
      return [];
  }
}

/**
 * @param {string} data
 * @returns {string}
 */
function parseJsonVersion(data) {
  const parsed = JSON.parse(data);
  return String(parsed?.version ?? "").trim();
}

/**
 * @param {string} data
 * @returns {string}
 */
function parseLockVersion(data) {
  const parsed = JSON.parse(data);
  const rootEntry = parsed?.packages?.[""];
  const rootVersion = String(rootEntry?.version ?? "").trim();
  if (rootVersion) return rootVersion;
  return String(parsed?.version ?? "").trim();
}

/**
 * @param {string} file
 * @param {string} data
 * @returns {VersionValue[]}
 */
function parseServerManifestVersions(file, data) {
  const parsed = JSON.parse(data);
  /** @type {VersionValue[]} */
  const values = [];
  const manifestVersion = String(parsed?.version ?? "").trim();
  if (manifestVersion) {
    values.push({ source: file, version: manifestVersion });
  }
  for (const [index, pkg] of (parsed?.packages ?? []).entries()) {
    const packageVersion = String(pkg?.version ?? "").trim();
    if (packageVersion) {
      values.push({ source: `${file}#packages[${index}]`, version: packageVersion });
    }
  }
  return values;
}

/**
 * @param {VersionValue[]} values
 * @returns {string[]}
 */
function collectMismatches(values) {
  if (values.length < 2) return [];
  const expected = values[0].version;
  /** @type {Set<string>} */
  const mismatches = new Set();
  for (let i = 1; i < values.length; i += 1) {
    if (values[i].version !== expected) {
      mismatches.add(`${values[0].source} -> ${expected}`);
      mismatches.add(`${values[i].source} -> ${values[i].version}`);
    }
  }
  return [...mismatches];
}

/**
 * @param {VersionValue[]} values
 * @returns {string[]}
 */
function formatValues(values) {
  return [...new Set(values.map((item) => `${item.source} -> ${item.version}`))].sort();
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function normalize(filePath) {
  return String(filePath ?? "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * @param {string} name
 * @param {Verdict} status
 * @param {string} summary
 * @param {string[]} [details]
 * @returns {Check}
 */
function check(name, status, summary, details) {
  if (details && details.length > 0) {
    return { name, status, summary, details };
  }
  return { name, status, summary };
}
