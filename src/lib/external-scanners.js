// External scanners: what the gate delegates rather than re-implements.
//
// Solumbe's own secret rules and path-based risk flags are deliberately small.
// A scanner with hundreds of rules, a syntax-tree matcher or a vulnerability
// database is a better use of someone else's year, so when one is installed
// the gate runs it over the exact changed content and folds what it finds into
// the verdict as a check of its own.
//
// A scanner runs when it is on the machine and the repository has taken it up:
// a `.gitleaks.toml`, a Semgrep rules file, or its name in SOLUMBE_SCANNERS.
// Nothing is installed or fetched, npx is never run, and a scanner that sends
// data off the machine runs only when it is named.
//
// Each scanner sees a temporary copy of the changed files as the gate read
// them (the staged tree, the head commit, or the working tree), never the
// whole checkout, so its findings are about this change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATUS } from "./policy.js";
import { runCommand } from "./tools.js";

/**
 * @typedef {import("./pass-local.js").Check} ScannerCheck
 * @typedef {{ dir: string, written: string[] }} Workspace
 * @typedef {{ root: string, files: string[], env: NodeJS.ProcessEnv, workspace: () => Workspace, named: boolean }} ScannerInput
 */

const MAX_DETAILS = 20;
const SCANNER_TIMEOUT_MS = 120000;

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "requirements.txt",
  "pom.xml",
  "gradle.lockfile",
]);

const SEMGREP_CONFIGS = [".semgrep.yml", ".semgrep.yaml", ".semgrep", "semgrep.yml", "semgrep.yaml"];

/**
 * The scanners the gate knows how to run, in report order. `network` marks one
 * that sends data off the machine, which the gate never does unasked.
 * @type {{ id: string, network: boolean, run: (input: ScannerInput, bin: string) => ScannerCheck | null, applies: (input: ScannerInput) => boolean, title: string }[]}
 */
const SCANNERS = [
  {
    id: "gitleaks",
    network: false,
    title: "Secret scan (gitleaks)",
    applies: (input) => input.named || fs.existsSync(gitleaksConfig(input.root)),
    run: runGitleaks,
  },
  { id: "semgrep", network: false, title: "Code patterns (semgrep)", applies: (input) => Boolean(semgrepConfig(input.root)), run: runSemgrep },
  {
    id: "osv-scanner",
    network: true,
    title: "Known vulnerabilities (osv-scanner)",
    applies: (input) => changedLockfiles(input.files).length > 0,
    run: runOsvScanner,
  },
];

/** The scanner ids `SOLUMBE_SCANNERS` accepts. */
export const EXTERNAL_SCANNER_IDS = SCANNERS.map((scanner) => scanner.id);

/**
 * Run the installed scanners over the changed content and return one check
 * per scanner that had something to look at.
 *
 * `SOLUMBE_SCANNERS` selects them: unset runs each installed scanner the
 * repository carries a config for; a comma-separated list
 * (`gitleaks,osv-scanner`) runs exactly those, config or not, which is also how
 * a scanner that needs the network is allowed; `off` runs none.
 * @param {string} root
 * @param {string[]} files changed files, repository-relative
 * @param {(file: string) => string | null} readContent the gate's exact-subject reader
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {ScannerCheck[]}
 */
export function externalScannerChecks(root, files, readContent, options = {}) {
  const env = options.env ?? process.env;
  const selection = scannerSelection(env);
  if (selection.off || (files ?? []).length === 0) return [];

  /** @type {{ workspace: Workspace | null }} */
  const state = { workspace: null };
  const workspaceOf = () => (state.workspace ??= materialize(files, readContent));
  /** @type {ScannerCheck[]} */
  const checks = [];
  try {
    for (const scanner of SCANNERS) {
      const named = selection.named.has(scanner.id);
      if (selection.named.size > 0 && !named) continue;
      const input = { root, files, env, workspace: workspaceOf, named };
      if (!scanner.applies(input)) continue;
      const bin = resolveScannerBin(scanner.id, env);
      if (!bin) {
        // Asked for by name and not there is worth saying; merely absent is not.
        if (named) checks.push({ name: scanner.title, status: STATUS.warn, summary: `${scanner.id} is named in SOLUMBE_SCANNERS but is not installed.` });
        continue;
      }
      if (scanner.network && !named) {
        checks.push({
          name: scanner.title,
          status: STATUS.skipped,
          summary: `Not run: ${scanner.id} is installed but sends package names off this machine. Name it in SOLUMBE_SCANNERS to allow it.`,
        });
        continue;
      }
      const check = scanner.run(input, bin);
      if (check) checks.push(check);
    }
  } finally {
    if (state.workspace) fs.rmSync(path.dirname(state.workspace.dir), { recursive: true, force: true });
  }
  return checks;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ off: boolean, named: Set<string> }}
 */
function scannerSelection(env) {
  const raw = String(env.SOLUMBE_SCANNERS ?? "")
    .trim()
    .toLowerCase();
  if (["off", "none", "0", "false"].includes(raw)) return { off: true, named: new Set() };
  const named = new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => EXTERNAL_SCANNER_IDS.includes(item)),
  );
  return { off: false, named };
}

/**
 * A scanner's executable: `SOLUMBE_<ID>_BIN` when set, else the name on PATH
 * when it answers. Nothing is installed and npx is never run.
 * @param {string} id
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function resolveScannerBin(id, env) {
  const configured = env[`SOLUMBE_${id.toUpperCase().replaceAll("-", "_")}_BIN`];
  if (configured) return fs.existsSync(configured) ? path.resolve(configured) : null;
  const probe = runCommand(id, ["--version"], { timeout: 10000, env });
  return probe.ok ? id : null;
}

/**
 * Copy the changed files, as the gate read them, into a temporary directory.
 * A file the reader cannot return (deleted, binary, over the scan limit) is
 * left out.
 * @param {string[]} files
 * @param {(file: string) => string | null} readContent
 * @returns {Workspace}
 */
function materialize(files, readContent) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-scan-"));
  const dir = path.join(base, "change");
  fs.mkdirSync(dir);
  /** @type {string[]} */
  const written = [];
  for (const file of files) {
    const target = path.resolve(dir, file);
    if (!target.startsWith(dir + path.sep)) continue;
    const content = readContent(file);
    if (typeof content !== "string") continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(file);
  }
  return { dir, written };
}

/** @param {string} dir @param {unknown} file @returns {string} */
function relativeTo(dir, file) {
  const text = String(file ?? "");
  const real = fs.realpathSync(dir);
  for (const prefix of [dir, real]) {
    if (text.startsWith(prefix + path.sep)) return text.slice(prefix.length + 1);
  }
  return text.replace(/^\.\//, "");
}

/** @param {string} file @returns {any} */
function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {string} stderr @returns {string[]} */
function firstLine(stderr) {
  const line = String(stderr ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  return line ? [line.slice(0, 300)] : [];
}

/** @param {number} count @param {string} noun */
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * gitleaks over the changed files. `dir` is the current command; releases
 * before 8.19 only have `detect --no-git`, tried when `dir` writes no report.
 * The report is redacted, and only the file, line and rule are repeated.
 * @param {ScannerInput} input
 * @param {string} bin
 * @returns {ScannerCheck | null}
 */
function runGitleaks(input, bin) {
  const name = "Secret scan (gitleaks)";
  const workspace = input.workspace();
  if (workspace.written.length === 0) return null;
  const report = path.join(path.dirname(workspace.dir), "gitleaks.json");
  const config = gitleaksConfig(input.root);
  const common = [
    "--report-format",
    "json",
    "--report-path",
    report,
    "--redact",
    "--no-banner",
    "--exit-code",
    "0",
    ...(fs.existsSync(config) ? ["--config", config] : []),
  ];
  const options = { cwd: workspace.dir, timeout: SCANNER_TIMEOUT_MS, env: input.env };

  let result = runCommand(bin, ["dir", workspace.dir, ...common], options);
  let findings = readJsonFile(report);
  if (!Array.isArray(findings)) {
    result = runCommand(bin, ["detect", "--no-git", "--source", workspace.dir, ...common], options);
    findings = readJsonFile(report);
  }
  if (!Array.isArray(findings)) {
    return { name, status: STATUS.warn, summary: "gitleaks is installed but did not return a readable report.", details: firstLine(result.stderr) };
  }
  if (findings.length === 0) {
    return { name, status: STATUS.pass, summary: `gitleaks found no secret in ${plural(workspace.written.length, "changed file")}.` };
  }
  return {
    name,
    status: STATUS.fail,
    summary: `gitleaks found ${plural(findings.length, "secret")} in the changed content.`,
    details: findings
      .slice(0, MAX_DETAILS)
      .map((/** @type {any} */ finding) => `${relativeTo(workspace.dir, finding.File)}:${finding.StartLine ?? "?"} ${finding.RuleID ?? "secret"}`),
  };
}

/** @param {string} root @returns {string} */
function gitleaksConfig(root) {
  return path.join(root, ".gitleaks.toml");
}

/** @param {string} root @returns {string | null} */
function semgrepConfig(root) {
  for (const candidate of SEMGREP_CONFIGS) {
    const file = path.join(root, candidate);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Semgrep with the repository's own rules. The registry (`--config auto`) is
 * never used: it needs the network, and which rules apply is the repository's
 * decision. An ERROR-severity finding fails; anything else warns.
 * @param {ScannerInput} input
 * @param {string} bin
 * @returns {ScannerCheck | null}
 */
function runSemgrep(input, bin) {
  const name = "Code patterns (semgrep)";
  const config = semgrepConfig(input.root);
  const workspace = input.workspace();
  if (!config || workspace.written.length === 0) return null;
  const result = runCommand(bin, ["scan", "--json", "--quiet", "--metrics=off", "--disable-version-check", "--config", config, workspace.dir], {
    cwd: workspace.dir,
    timeout: SCANNER_TIMEOUT_MS,
    env: input.env,
  });
  const parsed = parseJson(result.stdout);
  if (!parsed || !Array.isArray(parsed.results)) {
    return { name, status: STATUS.warn, summary: "semgrep is installed but did not return a readable report.", details: firstLine(result.stderr) };
  }
  const rules = path.relative(input.root, config) || config;
  if (parsed.results.length === 0) {
    return { name, status: STATUS.pass, summary: `semgrep found nothing in ${plural(workspace.written.length, "changed file")} (rules: ${rules}).` };
  }
  const severityOf = (/** @type {any} */ finding) => String(finding.extra?.severity ?? "WARNING").toUpperCase();
  const errors = parsed.results.filter((/** @type {any} */ finding) => severityOf(finding) === "ERROR").length;
  return {
    name,
    status: errors > 0 ? STATUS.fail : STATUS.warn,
    summary: `semgrep found ${plural(parsed.results.length, "finding")} in the changed content${errors > 0 ? `, ${errors} at ERROR severity` : ""} (rules: ${rules}).`,
    details: parsed.results
      .slice(0, MAX_DETAILS)
      .map(
        (/** @type {any} */ finding) =>
          `${relativeTo(workspace.dir, finding.path)}:${finding.start?.line ?? "?"} ${finding.check_id ?? "rule"} (${severityOf(finding)})`,
      ),
  };
}

/** @param {string[]} files @returns {string[]} */
function changedLockfiles(files) {
  return (files ?? []).filter((file) => LOCKFILES.has(path.posix.basename(file)));
}

/**
 * osv-scanner over the lockfiles this change touches. It reports every known
 * vulnerability in those lockfiles, not only the ones the change introduced,
 * so a finding warns and does not fail.
 * @param {ScannerInput} input
 * @param {string} bin
 * @returns {ScannerCheck | null}
 */
function runOsvScanner(input, bin) {
  const name = "Known vulnerabilities (osv-scanner)";
  const workspace = input.workspace();
  const lockfiles = changedLockfiles(workspace.written);
  if (lockfiles.length === 0) return null;
  const result = runCommand(bin, ["--format", "json", ...lockfiles.flatMap((file) => ["--lockfile", path.join(workspace.dir, file)])], {
    cwd: workspace.dir,
    timeout: SCANNER_TIMEOUT_MS,
    env: input.env,
  });
  const parsed = parseJson(result.stdout);
  if (!parsed || !Array.isArray(parsed.results)) {
    return { name, status: STATUS.warn, summary: "osv-scanner is installed but did not return a readable report.", details: firstLine(result.stderr) };
  }
  /** @type {string[]} */
  const details = [];
  let vulnerabilities = 0;
  for (const source of parsed.results) {
    for (const entry of source.packages ?? []) {
      const ids = (entry.vulnerabilities ?? []).map((/** @type {any} */ item) => item.id).filter(Boolean);
      if (ids.length === 0) continue;
      vulnerabilities += ids.length;
      details.push(`${entry.package?.name ?? "package"}@${entry.package?.version ?? "?"}: ${ids.slice(0, 5).join(", ")}`);
    }
  }
  if (vulnerabilities === 0) {
    return { name, status: STATUS.pass, summary: `osv-scanner found no known vulnerability in ${plural(lockfiles.length, "changed lockfile")}.` };
  }
  return {
    name,
    status: STATUS.warn,
    summary: `osv-scanner found ${plural(vulnerabilities, "known vulnerability").replace("vulnerabilitys", "vulnerabilities")} in ${plural(lockfiles.length, "changed lockfile")}.`,
    details: details.slice(0, MAX_DETAILS),
  };
}
