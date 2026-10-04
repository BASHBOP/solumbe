import path from "node:path";
import { generateCodeMap } from "./code-map.js";
import { getDoctorReport } from "./doctor.js";
import { formatGitSummary, inspectRepo } from "./repo.js";

const keyScriptNames = ["dev", "start", "build", "lint", "tsc:check", "check:type", "test", "test:e2e"];

/** @typedef {ReturnType<typeof inspectRepo>} RepoInspection */
/** @typedef {ReturnType<typeof generateCodeMap>} CodeMap */
/** @typedef {{ available?: boolean, clean?: boolean, changes?: number, branch?: string, commit?: string }} GitInfo */
/** @typedef {{ domain: string, frontendApiClients: number, backendControllers: number, backendServices: number }} Integration */

/**
 * @param {string[]} repoPaths
 * @returns {{ data: Record<string, any>, markdown: string }}
 */
export function generateWorkspaceReport(repoPaths) {
  const repos = repoPaths.map((repoPath) => inspectRepo(repoPath));
  const maps = repoPaths.map((repoPath) => generateCodeMap(repoPath));
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    repoCount: repos.length,
    totalFiles: repos.reduce((total, repo) => total + repo.fileCount, 0),
    languages: aggregateLanguages(repos),
    packageManagers: [...new Set(repos.flatMap((repo) => repo.packageManagers))],
    repos: repos.map((repo, index) => summarizeRepo(repo, maps[index])),
    domains: aggregateDomains(maps),
    integrations: inferIntegrations(maps),
    doctor: getDoctorReport(),
  };

  return {
    data,
    markdown: formatWorkspaceReport(data),
  };
}

/**
 * Notes drawn from the repositories in this report, not from one product's
 * stack: a Go service beside a Next app and a Nest API is named as such.
 * @param {any[]} repos
 * @returns {string[]}
 */
function productNotes(repos) {
  const stacks = repos.map((repo) => `${repo.name} (${repo.languages[0]?.language ?? "unknown"})`);
  const notes = [
    `- Treat these ${repos.length} repositories as one product: ${stacks.join(", ")}.`,
    "- Use repo-level reports for detailed file lists, and this workspace report for cross-repo orientation.",
  ];
  for (const repo of repos) {
    if (repo.git?.behind) notes.push(`- ${repo.name} is ${repo.git.behind} commit(s) behind ${repo.git.upstream}; pull before relying on this report for it.`);
  }
  return notes;
}

/**
 * @param {RepoInspection} repo
 * @param {CodeMap} codeMap
 * @returns {object}
 */
function summarizeRepo(repo, codeMap) {
  return {
    name: path.basename(repo.root),
    root: repo.root,
    fileCount: repo.fileCount,
    languages: repo.languages,
    packageManagers: repo.packageManagers,
    entrypoints: repo.entrypoints,
    importantDirectories: repo.importantDirectories,
    git: repo.git,
    scripts: pickKeyScripts(repo.scripts),
    map: codeMap.summary,
    topDomains: codeMap.domains.slice(0, 10),
  };
}

/**
 * @param {RepoInspection[]} repos
 * @returns {{ language: string, count: number }[]}
 */
function aggregateLanguages(repos) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const repo of repos) {
    for (const item of repo.languages) {
      counts.set(item.language, (counts.get(item.language) ?? 0) + item.count);
    }
  }

  return [...counts.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}

/**
 * @param {Record<string, unknown>} scripts
 * @returns {Record<string, unknown>}
 */
function pickKeyScripts(scripts) {
  return Object.fromEntries(keyScriptNames.filter((name) => scripts[name]).map((name) => [name, scripts[name]]));
}

/**
 * @param {any} data Workspace report payload from generateWorkspaceReport.
 * @returns {string}
 */
function formatWorkspaceReport(data) {
  const lines = [
    "# solumbe Workspace Report",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "## Workspace Overview",
    "",
    `- Repositories: ${data.repoCount}`,
    `- Files scanned: ${data.totalFiles}`,
    `- Languages: ${data.languages.map((/** @type {{ language: string, count: number }} */ item) => `${item.language} (${item.count})`).join(", ") || "unknown"}`,
    `- Package managers: ${data.packageManagers.join(", ") || "none detected"}`,
    "",
    "## Repositories",
    "",
    "| Repo | Files | Git | Languages | Entrypoints |",
    "|---|---:|---|---|---|",
  ];

  for (const repo of data.repos) {
    const git = formatGitSummary(repo.git);
    lines.push(
      `| ${repo.name} | ${repo.fileCount} | ${git} | ${repo.languages.map((/** @type {{ language: string, count: number }} */ item) => `${item.language} ${item.count}`).join(", ") || "unknown"} | ${repo.entrypoints.join(", ") || "none detected"} |`,
    );
  }

  lines.push("", "## Key Scripts", "");
  for (const repo of data.repos) {
    lines.push(`### ${repo.name}`, "");
    const entries = Object.entries(repo.scripts);
    if (!entries.length) {
      lines.push("- none detected", "");
      continue;
    }

    for (const [name, script] of entries) {
      lines.push(`- \`${name}\`: \`${script}\``);
    }
    lines.push("");
  }

  lines.push(
    "## Code Map Summary",
    "",
    "| Repo | Routes | Controllers | Services | Components | API Clients | Tests | Symbols |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );

  for (const repo of data.repos) {
    lines.push(
      `| ${repo.name} | ${repo.map.routes + repo.map.apiRoutes} | ${repo.map.controllers} | ${repo.map.services} | ${repo.map.components} | ${repo.map.apiClients} | ${repo.map.tests} | ${repo.map.symbols} |`,
    );
  }

  lines.push("", "## Shared Domains", "", "| Domain | Files | Repos |", "|---|---:|---|");
  for (const domain of data.domains.slice(0, 20)) {
    lines.push(`| ${domain.name} | ${domain.fileCount} | ${domain.repos.join(", ")} |`);
  }

  lines.push("", "## Likely Integration Domains", "", "| Domain | Frontend API Clients | Backend Controllers | Backend Services |", "|---|---:|---:|---:|");

  if (data.integrations.length) {
    for (const integration of data.integrations.slice(0, 30)) {
      lines.push(`| ${integration.domain} | ${integration.frontendApiClients} | ${integration.backendControllers} | ${integration.backendServices} |`);
    }
  } else {
    lines.push("| none detected | 0 | 0 | 0 |");
  }

  lines.push("", "## Product-Level Notes", "", ...productNotes(data.repos), "");

  return lines.join("\n");
}

/**
 * @param {CodeMap[]} maps
 * @returns {{ name: string, fileCount: number, repos: string[] }[]}
 */
function aggregateDomains(maps) {
  /** @type {Map<string, { name: string, fileCount: number, repos: Set<string> }>} */
  const domains = new Map();
  for (const map of maps) {
    for (const domain of map.domains) {
      const entry = domains.get(domain.name) ?? { name: domain.name, fileCount: 0, repos: new Set() };
      entry.fileCount += domain.fileCount;
      entry.repos.add(map.repo.name);
      domains.set(domain.name, entry);
    }
  }

  return [...domains.values()]
    .map((domain) => ({ name: domain.name, fileCount: domain.fileCount, repos: [...domain.repos].sort() }))
    .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name));
}

/**
 * @param {CodeMap[]} maps
 * @returns {Integration[]}
 */
function inferIntegrations(maps) {
  const frontend = maps.find((map) => map.summary.apiClients > 0 || map.summary.routes > 0);
  const backend = maps.find((map) => map.summary.controllers > 0 || map.summary.services > 0);
  if (!frontend || !backend) {
    return [];
  }

  const frontendCounts = countByDomain(frontend.files.filter((file) => file.kind === "apiClient"));
  const backendControllers = countByDomain(backend.files.filter((file) => file.kind === "controller"));
  const backendServices = countByDomain(backend.files.filter((file) => file.kind === "service"));
  const domains = new Set([...frontendCounts.keys(), ...backendControllers.keys(), ...backendServices.keys()]);

  return [...domains]
    .map((domain) => ({
      domain,
      frontendApiClients: frontendCounts.get(domain) ?? 0,
      backendControllers: backendControllers.get(domain) ?? 0,
      backendServices: backendServices.get(domain) ?? 0,
    }))
    .filter((item) => item.frontendApiClients > 0 && (item.backendControllers > 0 || item.backendServices > 0))
    .sort((a, b) => scoreIntegration(b) - scoreIntegration(a) || a.domain.localeCompare(b.domain));
}

/**
 * @param {import('./index-cache.js').CodeMapFile[]} files
 * @returns {Map<string, number>}
 */
function countByDomain(files) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const file of files) {
    counts.set(file.domain, (counts.get(file.domain) ?? 0) + 1);
  }
  return counts;
}

/**
 * @param {Integration} item
 * @returns {number}
 */
function scoreIntegration(item) {
  return Math.min(item.frontendApiClients, 1) * 10 + item.backendControllers * 2 + item.backendServices;
}

/**
 * Mermaid architecture diagram: repos with their role counts and integration edges.
 * @param {ReturnType<typeof generateWorkspaceReport>['data']} data
 * @returns {string}
 */
export function formatWorkspaceMermaid(data) {
  const lines = ["graph LR"];
  const repos = data.repos ?? [];

  for (const [ri, repo] of repos.entries()) {
    lines.push(`    subgraph R${ri}["${repo.name}"]`);
    const m = repo.map ?? {};
    if (m.apiClients > 0) lines.push(`        R${ri}_a["api-clients: ${m.apiClients}"]`);
    if (m.controllers > 0) lines.push(`        R${ri}_c["controllers: ${m.controllers}"]`);
    if (m.services > 0) lines.push(`        R${ri}_s["services: ${m.services}"]`);
    if (m.components > 0) lines.push(`        R${ri}_u["components: ${m.components}"]`);
    lines.push("    end");
  }

  // Draw integration edges between the frontend repo (has apiClients) and the backend (has controllers).
  const frontendIdx = repos.findIndex((/** @type {any} */ r) => (r.map?.apiClients ?? 0) > 0);
  const backendIdx = repos.findIndex((/** @type {any} */ r) => (r.map?.controllers ?? 0) > 0 || (r.map?.services ?? 0) > 0);
  if (frontendIdx >= 0 && backendIdx >= 0 && frontendIdx !== backendIdx) {
    for (const integration of (data.integrations ?? []).slice(0, 12)) {
      // Strip chars that would prematurely close the |"..."| edge label.
      const label = String(integration.domain)
        .replace(/[[\]{}|"]/g, " ")
        .trim();
      lines.push(`    R${frontendIdx}_a -->|"${label}"| R${backendIdx}_c`);
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
void mId; // referenced by integration edge label building if needed in future
