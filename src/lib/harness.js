import fs from "node:fs";
import path from "node:path";
import { generateCodeMap } from "./code-map.js";
import { isTypeCheckScript, selectScripts } from "./package-scripts.js";
import { formatGitSummary, inspectRepo } from "./repo.js";
import { estimateTokens, estimateTokenSections } from "./tokens.js";

const validationScripts = [
  "ci",
  "quality",
  "lint",
  "format:check",
  "typecheck",
  "version:check",
  "type-check",
  "check:type",
  "tsc",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
  "test:coverage",
  "audit",
  "smoke",
  "build",
];

const runtimeScripts = ["dev", "start", "preview"];

/** @typedef {ReturnType<typeof generateCodeMap>} CodeMap */
/** @typedef {ReturnType<typeof inspectRepo>} RepoInspection */

/**
 * One suggested command with a human-readable reason.
 * @typedef {object} HarnessCommand
 * @property {string} command
 * @property {string} reason
 * @property {string} [script]
 */

/**
 * The grouped command set inferred for a repository.
 * @typedef {object} HarnessCommands
 * @property {HarnessCommand[]} setup
 * @property {HarnessCommand[]} validate
 * @property {HarnessCommand[]} runtime
 * @property {HarnessCommand[]} context
 */

/**
 * @typedef {object} HarnessOptions
 * @property {number} [maxSymbols] Per-file symbol cap forwarded to generateCodeMap.
 */

/**
 * @param {string} [repoPath]
 * @param {HarnessOptions} [options]
 * @returns {{ data: Record<string, any>, markdown: string }}
 */
export function generateHarness(repoPath = ".", options = {}) {
  const repo = inspectRepo(repoPath);
  const map = generateCodeMap(repo.root, { maxSymbols: options.maxSymbols });
  const commands = inferCommands(repo);
  const context = summarizeContext(map);
  /** @type {Record<string, any> & { tokenEstimate?: Record<string, any> }} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    harnessVersion: 1,
    repo: {
      root: repo.root,
      name: repo.package?.name ?? path.basename(repo.root),
      package: repo.package,
      packageManagers: repo.packageManagers,
      git: repo.git,
      entrypoints: repo.entrypoints,
    },
    commands,
    context,
    focusAreas: inferFocusAreas(map, commands),
  };

  data.tokenEstimate = {
    ...estimateTokenSections([
      { name: "repo", value: data.repo },
      { name: "commands", value: data.commands },
      { name: "context", value: data.context },
      { name: "focusAreas", value: data.focusAreas },
    ]),
  };
  data.tokenEstimate.fullJson = estimateTokens(data);

  let markdown = formatHarnessMarkdown(data);
  data.tokenEstimate.markdown = estimateTokens(markdown);
  markdown = formatHarnessMarkdown(data);

  return { data, markdown };
}

/**
 * @param {any} data Harness payload from generateHarness.
 * @returns {string}
 */
export function formatHarnessMarkdown(data) {
  const lines = [
    `# solumbe Harness: ${data.repo.name}`,
    "",
    `Generated: ${data.generatedAt}`,
    `Harness version: ${data.harnessVersion}`,
    "",
    "## Token Budget",
    "",
    `- Estimated JSON tokens: ${data.tokenEstimate.fullJson}`,
    `- Estimated Markdown tokens: ${data.tokenEstimate.markdown ?? "pending"}`,
    `- Method: ${data.tokenEstimate.method}`,
    "",
    "## Repo",
    "",
    `- Root: ${data.repo.root}`,
    `- Git: ${formatGitSummary(data.repo.git)}`,
    `- Package managers: ${data.repo.packageManagers.join(", ") || "none detected"}`,
    `- Entrypoints: ${data.repo.entrypoints.join(", ") || "none detected"}`,
    "",
    "## Setup",
    "",
    ...formatCommands(data.commands.setup, "No setup command detected."),
    "",
    "## Validation",
    "",
    ...formatCommands(data.commands.validate, "No validation scripts detected."),
    "",
    "## Runtime",
    "",
    ...formatCommands(data.commands.runtime, "No runtime scripts detected."),
    "",
    "## Context Commands",
    "",
    ...formatCommands(data.commands.context, "No context commands generated."),
    "",
    "## Focus Areas",
    "",
    ...(data.focusAreas.length ? data.focusAreas.map((/** @type {string} */ item) => `- ${item}`) : ["- none detected"]),
    "",
    "## Top Domains",
    "",
    ...(data.context.domains.length
      ? data.context.domains.map((/** @type {import('./index-cache.js').CodeMapDomain} */ domain) => `- ${domain.name}: ${domain.fileCount} file(s)`)
      : ["- none detected"]),
    "",
  ];
  return lines.join("\n");
}

/**
 * @param {RepoInspection} repo
 * @returns {HarnessCommands}
 */
function inferCommands(repo) {
  const runner = packageRunner(repo.packageManagers);
  return {
    setup: inferSetupCommands(repo),
    validate: [...inferScriptCommands(repo.scripts, runner, validationScripts), ...inferToolchainValidation(repo.root)],
    runtime: inferScriptCommands(repo.scripts, runner, runtimeScripts),
    context: [
      {
        command: "solumbe repo . --json",
        reason: "inspect repository facts",
      },
      {
        command: "solumbe map . --json",
        reason: "generate agent-readable code map",
      },
      {
        command: "solumbe harness . --json",
        reason: "refresh harness commands and token estimates",
      },
    ],
  };
}

/**
 * Validation a toolchain provides without a scripts file: a Go module is
 * built, vetted, tested and format-checked by `go` itself.
 * @param {string} root
 * @returns {HarnessCommand[]}
 */
function inferToolchainValidation(root) {
  if (!fs.existsSync(path.join(root, "go.mod"))) return [];
  return [
    { command: 'test -z "$(gofmt -l .)"', reason: "Go formatting check" },
    { command: "go vet ./...", reason: "Go static checks" },
    { command: "go build ./...", reason: "Go compile check" },
    { command: "go test ./...", reason: "Go behavior verification" },
  ];
}

/**
 * @param {RepoInspection} repo
 * @returns {HarnessCommand[]}
 */
function inferSetupCommands(repo) {
  /** @type {HarnessCommand[]} */
  const commands = [];
  const root = repo.root;
  if (repo.packageManagers.includes("pnpm")) commands.push({ command: "pnpm install", reason: "install Node dependencies" });
  else if (repo.packageManagers.includes("yarn")) commands.push({ command: "yarn install", reason: "install Node dependencies" });
  else if (repo.packageManagers.includes("bun")) commands.push({ command: "bun install", reason: "install Node dependencies" });
  else if (repo.packageManagers.includes("npm")) commands.push({ command: "npm install", reason: "install Node dependencies" });

  if (fs.existsSync(path.join(root, "requirements.txt"))) commands.push({ command: "pip install -r requirements.txt", reason: "install Python dependencies" });
  if (fs.existsSync(path.join(root, "go.mod"))) commands.push({ command: "go mod download", reason: "download Go modules" });
  if (fs.existsSync(path.join(root, "Cargo.toml"))) commands.push({ command: "cargo fetch", reason: "fetch Rust crates" });
  if (fs.existsSync(path.join(root, "Gemfile"))) commands.push({ command: "bundle install", reason: "install Ruby gems" });
  return commands;
}

/**
 * @param {Record<string, unknown>} scripts
 * @param {string} runner
 * @param {string[]} names
 * @returns {HarnessCommand[]}
 */
function inferScriptCommands(scripts = {}, runner, names) {
  return selectScripts(scripts, names).map((name) => ({
    script: name,
    command: commandForScript(runner, name),
    reason: scriptReason(name),
  }));
}

/**
 * @param {CodeMap} map
 * @returns {object}
 */
function summarizeContext(map) {
  return {
    sourceFileCount: map.repo.sourceFileCount,
    symbols: map.summary.symbols,
    summary: map.summary,
    domains: map.domains.slice(0, 12),
    notableFiles: map.files
      .filter((file) => ["route", "apiRoute", "controller", "service", "module", "apiClient"].includes(file.kind))
      .slice(0, 40)
      .map((file) => ({
        path: file.path,
        kind: file.kind,
        domain: file.domain,
        route: file.route,
        controllerBasePath: file.controllerBasePath,
      })),
  };
}

/**
 * @param {CodeMap} map
 * @param {HarnessCommands} commands
 * @returns {string[]}
 */
function inferFocusAreas(map, commands) {
  /** @type {string[]} */
  const areas = [];
  if (map.summary.routes || map.summary.apiRoutes) areas.push("frontend/application routes");
  if (map.summary.controllers) areas.push("backend request controllers");
  if (map.summary.apiClients) areas.push("frontend/backend API contracts");
  if (map.summary.schemas || map.summary.dtos) areas.push("data schemas and DTO contracts");
  if (commands.validate.length) areas.push("validation scripts are available for agent/CI execution");
  if (!commands.validate.length) areas.push("add at least one validation script for the harness to run");
  return areas;
}

/**
 * @param {string[]} [packageManagers]
 * @returns {string}
 */
function packageRunner(packageManagers = []) {
  if (packageManagers.includes("pnpm")) return "pnpm";
  if (packageManagers.includes("yarn")) return "yarn";
  if (packageManagers.includes("bun")) return "bun";
  return "npm";
}

/**
 * @param {string} runner
 * @param {string} script
 * @returns {string}
 */
function commandForScript(runner, script) {
  if (runner === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (runner === "bun") {
    return `bun run ${script}`;
  }
  return `${runner} ${script}`;
}

/**
 * @param {string} name
 * @returns {string}
 */
function scriptReason(name) {
  if (name === "ci" || name === "quality") return "full quality gate";
  if (name === "audit") return "production dependency security audit";
  if (name === "smoke") return "smoke verification";
  if (isTypeCheckScript(name)) return "type contract checks";
  if (name.includes("lint")) return "static checks";
  if (name.includes("coverage")) return "coverage threshold verification";
  if (name.includes("test")) return "behavior verification";
  if (name === "build") return "integration and bundling verification";
  if (name === "dev") return "local development server";
  if (name === "start") return "application start command";
  if (name === "preview") return "preview built application";
  return "project script";
}

/**
 * @param {HarnessCommand[]} commands
 * @param {string} fallback
 * @returns {string[]}
 */
function formatCommands(commands, fallback) {
  if (!commands.length) {
    return [`- ${fallback}`];
  }
  return commands.map((item) => `- \`${item.command}\`: ${item.reason}`);
}
