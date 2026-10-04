import { getDoctorReport } from "./doctor.js";
import { getToolMatrix } from "./matrix.js";
import { createRenderer } from "./render/fancy.js";
import { formatGitSummary, inspectRepo } from "./repo.js";
import { estimateTokens, estimateTokenSections } from "./tokens.js";

/** @typedef {import('./doctor.js').DoctorTool} DoctorTool */

/**
 * Git info surfaced in the report (subset of the inspectRepo git shape).
 * @typedef {Object} GitInfo
 * @property {boolean} available
 * @property {boolean} [clean]
 * @property {number} [changes]
 * @property {string} [branch]
 * @property {string} [commit]
 */

/**
 * The repo overview the report consumes (subset of inspectRepo output).
 * @typedef {Object} RepoInfo
 * @property {string} root
 * @property {number} fileCount
 * @property {GitInfo} git
 * @property {{ language: string, count: number }[]} languages
 * @property {string[]} packageManagers
 * @property {string[]} entrypoints
 */

/**
 * One row of the tool-fit matrix.
 * @typedef {Object} MatrixTool
 * @property {string} name
 * @property {string} role
 * @property {string} pilotUse
 * @property {string} notes
 */

/**
 * One token-estimate breakdown section.
 * @typedef {{ name: string, tokens: number }} TokenSection
 */

/**
 * Aggregate token estimate attached to the report data.
 * @typedef {Object} TokenEstimate
 * @property {number} [fullJson]
 * @property {number} [markdown]
 * @property {TokenSection[]} [sections]
 */

/**
 * The full report data object built by {@link generateReport}. `tokenEstimate`
 * is populated after the base object is created, so it is optional on the type
 * but always present by the time the report is returned.
 * @typedef {Object} ReportData
 * @property {boolean} ok
 * @property {string} generatedAt
 * @property {RepoInfo} repo
 * @property {{ ok: boolean, tools: DoctorTool[] }} doctor
 * @property {{ ok: boolean, tools: MatrixTool[] }} matrix
 * @property {TokenEstimate} tokenEstimate
 */

/**
 * @param {string} [repoPath]
 * @returns {{ data: ReportData, markdown: string, terminal: string }}
 */
export function generateReport(repoPath = ".") {
  // tokenEstimate is filled in immediately below; cast through unknown so the
  // literal satisfies the required-property type without restructuring the
  // assignment order (inspectRepo returns a wider shape than ReportData.repo).
  const data = /** @type {ReportData} */ (
    /** @type {unknown} */ ({
      ok: true,
      generatedAt: new Date().toISOString(),
      repo: inspectRepo(repoPath),
      doctor: getDoctorReport(),
      matrix: getToolMatrix(),
    })
  );

  data.tokenEstimate = {
    ...estimateTokenSections([
      { name: "repo", value: data.repo },
      { name: "doctor", value: data.doctor },
      { name: "matrix", value: data.matrix },
    ]),
  };
  data.tokenEstimate.fullJson = estimateTokens(data);

  let markdown = formatReportMarkdown(data);
  data.tokenEstimate.markdown = estimateTokens(markdown);
  markdown = formatReportMarkdown(data);
  data.tokenEstimate.markdown = estimateTokens(markdown);

  return {
    data,
    markdown,
    terminal: formatReportTerminal(data),
  };
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function formatReportMarkdown(data) {
  const repo = data.repo;
  const missing = data.doctor.tools.filter((tool) => !tool.available);
  const present = data.doctor.tools.filter((tool) => tool.available);

  return [
    "# solumbe Report",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "## Repo Overview",
    "",
    `- Root: ${repo.root}`,
    `- Files scanned: ${repo.fileCount}`,
    `- Git: ${formatGitSummary(repo.git)}`,
    `- Languages: ${repo.languages.map((item) => `${item.language} (${item.count})`).join(", ") || "unknown"}`,
    `- Package managers: ${repo.packageManagers.join(", ") || "none detected"}`,
    `- Entrypoints: ${repo.entrypoints.join(", ") || "none detected"}`,
    `- Estimated JSON tokens: ${data.tokenEstimate.fullJson}`,
    `- Estimated Markdown tokens: ${data.tokenEstimate.markdown}`,
    "",
    "## Available Tools",
    "",
    ...(present.length ? present.map((tool) => `- ${tool.name}${tool.version ? `: ${tool.version}` : ""}`) : ["- none"]),
    "",
    "## Missing Optional Tools",
    "",
    ...(missing.length ? missing.map((tool) => `- ${tool.name}: ${tool.installHint}`) : ["- none"]),
    "",
    "## Tool Fit",
    "",
    "| Tool | Role | Pilot Use | Notes |",
    "|---|---|---|---|",
    ...data.matrix.tools.map((tool) => `| ${tool.name} | ${tool.role} | ${tool.pilotUse} | ${tool.notes} |`),
    "",
    "## Recommended Next Steps",
    "",
    "- Use this wrapper to standardize repo inspection and dependency lookup.",
    "- Install `opensrc` first if dependency-source inspection is important.",
    "- Install `code-structure` only for TypeScript structure HTML generation.",
    "- Add Daytona after execution isolation becomes a real workflow requirement.",
    "- Add MCP/Harnss integration after CLI JSON output has stabilized.",
    "",
  ].join("\n");
}

/**
 * @typedef {{ width: number, renderer: ReturnType<typeof createRenderer> }} Layout
 */

/**
 * The report has no glyphs of its own yet, so the renderer changes nothing it
 * prints today; it is created here, from the same preferences every other
 * command honours, so `--no-emoji`, `--color` and `--theme` reach the report
 * and its blocks can use it when they take solumbe's shared shape.
 * @param {ReportData} data
 * @param {{ columns?: number, emoji?: boolean, color?: boolean, theme?: string }} [options]
 * @returns {string}
 */
export function formatReportTerminal(data, options = {}) {
  /** @type {Layout} */
  const layout = { width: normalizeColumns(options.columns), renderer: createRenderer({ emoji: options.emoji, color: options.color, theme: options.theme }) };
  const repo = data.repo;
  const missing = data.doctor.tools.filter((tool) => !tool.available);
  const present = data.doctor.tools.filter((tool) => tool.available);
  const lines = [
    "solumbe Field Report",
    "=".repeat("solumbe Field Report".length),
    `Generated: ${data.generatedAt}`,
    ...formatLabeledParagraph("Status", formatStatusLine(data), layout),
  ];

  addSection(lines, "At a Glance");
  lines.push(
    ...formatKeyValues(
      [
        ["Root", repo.root],
        ["Files scanned", String(repo.fileCount)],
        ["Git", formatGitSummary(repo.git)],
        ["Languages", repo.languages.map((item) => `${item.language} (${item.count})`).join(", ") || "unknown"],
        ["Package managers", repo.packageManagers.join(", ") || "none detected"],
        ["Entrypoints", repo.entrypoints.join(", ") || "none detected"],
      ],
      layout,
    ),
  );

  addSection(lines, "Ready Tools");
  lines.push(...formatToolRows(present, { ...layout, fallback: "none" }));

  addSection(lines, "Optional Gaps");
  lines.push(...formatToolRows(missing, { ...layout, fallback: "none", includeHint: true }));

  addSection(lines, "Best Fits");
  if (data.matrix.tools.length) {
    data.matrix.tools.forEach((tool, index) => {
      if (index > 0) {
        lines.push("");
      }
      lines.push(`  ${tool.name}`);
      lines.push(
        ...formatKeyValues(
          [
            ["Role", tool.role],
            ["Pilot", tool.pilotUse],
            ["Notes", tool.notes],
          ],
          { ...layout, indent: "    " },
        ),
      );
    });
  } else {
    lines.push("  none");
  }

  addSection(lines, "Next Moves");
  lines.push(
    ...formatNumberedList(
      [
        "Use this wrapper to standardize repo inspection and dependency lookup.",
        "Install `opensrc` first if dependency-source inspection is important.",
        "Install `code-structure` only for TypeScript structure HTML generation.",
        "Add Daytona after execution isolation becomes a real workflow requirement.",
        "Add MCP/Harnss integration after CLI JSON output has stabilized.",
      ],
      layout,
    ),
  );

  addSection(lines, "Token Use");
  lines.push(...formatTokenSummary(data, layout));

  return lines.join("\n");
}

/**
 * @param {ReportData} data
 * @returns {string}
 */
function formatStatusLine(data) {
  const repo = data.repo;
  const missing = data.doctor.tools.filter((tool) => !tool.available);
  const present = data.doctor.tools.filter((tool) => tool.available);
  const gitState = repo.git.available ? (repo.git.clean ? "clean git tree" : `${repo.git.changes} uncommitted change(s)`) : "git unavailable";
  const optionalGaps = missing.length ? `${missing.length} optional gap(s)` : "no optional gaps";
  return `${gitState}; ${repo.fileCount} files scanned; ${present.length} tools ready; ${optionalGaps}.`;
}

/**
 * @param {string[]} lines
 * @param {string} title
 * @returns {void}
 */
function addSection(lines, title) {
  lines.push("", title, "-".repeat(title.length));
}

/**
 * @param {[string, string | number | null | undefined][]} rows
 * @param {{ width: number, indent?: string }} options
 * @returns {string[]}
 */
function formatKeyValues(rows, { width, indent = "  " }) {
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valuePrefix = `${indent}${" ".repeat(labelWidth)}  `;
  const valueWidth = Math.max(20, width - valuePrefix.length);

  return rows.flatMap(([label, rawValue]) => {
    const wrapped = wrapText(String(rawValue ?? ""), valueWidth);
    const first = `${indent}${label.padEnd(labelWidth)}  ${wrapped[0] ?? ""}`;
    return [first, ...wrapped.slice(1).map((line) => `${valuePrefix}${line}`)];
  });
}

/**
 * @param {DoctorTool[]} tools
 * @param {{ width: number, fallback: string, includeHint?: boolean }} options
 * @returns {string[]}
 */
function formatToolRows(tools, { width, fallback, includeHint = false }) {
  if (!tools.length) {
    return [`  ${fallback}`];
  }

  const nameWidth = Math.max(...tools.map((tool) => tool.name.length));
  const valuePrefix = `  ${" ".repeat(nameWidth)}  `;
  const valueWidth = Math.max(20, width - valuePrefix.length);

  return tools.flatMap((tool) => {
    const detail = includeHint ? tool.installHint || "install hint unavailable" : tool.version || "available";
    const wrapped = wrapText(detail, valueWidth);
    return [`  ${tool.name.padEnd(nameWidth)}  ${wrapped[0] ?? ""}`, ...wrapped.slice(1).map((line) => `${valuePrefix}${line}`)];
  });
}

/**
 * @param {ReportData} data
 * @param {{ width: number }} options
 * @returns {string[]}
 */
function formatTokenSummary(data, { width }) {
  const sections = data.tokenEstimate.sections ?? [];
  const lines = [
    ...formatKeyValues(
      [
        ["Full JSON", `${data.tokenEstimate.fullJson} estimated tokens`],
        ["Markdown", `${data.tokenEstimate.markdown} estimated tokens`],
      ],
      { width },
    ),
  ];

  if (sections.length) {
    lines.push("");
    lines.push("  Breakdown");
    lines.push(
      ...formatKeyValues(
        sections.map((section) => [titleCase(section.name), `${section.tokens} estimated tokens`]),
        { width, indent: "    " },
      ),
    );
  }

  return lines;
}

/**
 * @param {string} label
 * @param {string} value
 * @param {{ width: number, indent?: string }} options
 * @returns {string[]}
 */
function formatLabeledParagraph(label, value, { width, indent = "" }) {
  const prefix = `${indent}${label}: `;
  const continuationPrefix = `${indent}${" ".repeat(label.length + 2)}`;
  const wrapped = wrapText(value, Math.max(20, width - prefix.length));
  return [`${prefix}${wrapped[0] ?? ""}`, ...wrapped.slice(1).map((line) => `${continuationPrefix}${line}`)];
}

/**
 * @param {string[]} items
 * @param {{ width: number }} options
 * @returns {string[]}
 */
function formatNumberedList(items, { width }) {
  const markerWidth = `${items.length}. `.length;
  return items.flatMap((item, index) => {
    const marker = `${index + 1}. `.padStart(markerWidth);
    const prefix = `  ${marker}`;
    const continuationPrefix = `  ${" ".repeat(markerWidth)}`;
    const wrapped = wrapText(item, Math.max(20, width - prefix.length));
    return [`${prefix}${wrapped[0] ?? ""}`, ...wrapped.slice(1).map((line) => `${continuationPrefix}${line}`)];
  });
}

/**
 * @param {string} value
 * @param {number} width
 * @returns {string[]}
 */
function wrapText(value, width) {
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return [""];
  }

  /** @type {string[]} */
  const lines = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (!current && word.length > width) {
      lines.push(...chunkWord(word, width));
      continue;
    }

    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = "";
    }

    if (word.length > width) {
      lines.push(...chunkWord(word, width));
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

/**
 * @param {string} word
 * @param {number} width
 * @returns {string[]}
 */
function chunkWord(word, width) {
  /** @type {string[]} */
  const chunks = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}

/**
 * @param {number | undefined} columns
 * @returns {number}
 */
function normalizeColumns(columns) {
  const value = Number(columns);
  if (!Number.isFinite(value) || value < 40) {
    return 100;
  }
  return Math.min(140, Math.floor(value));
}

/**
 * @param {string} value
 * @returns {string}
 */
function titleCase(value) {
  return String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Mermaid pie chart of language distribution for the repo.
 * @param {ReportData} data
 * @returns {string}
 */
export function formatReportMermaid(data) {
  const langs = (data.repo?.languages ?? []).slice(0, 10);
  // The pie title runs to end-of-line, so strip quotes/newlines that would
  // break it or inject a second title line.
  const repoName = ((data.repo?.root ? data.repo.root.split("/").pop() : undefined) ?? "repo").replace(/["\r\n]/g, " ").trim() || "repo";
  if (!langs.length) {
    return [`pie title No language data — ${repoName}`, `    "unknown" : 1`].join("\n");
  }
  const lines = [`pie title Languages — ${repoName}`];
  for (const { language, count } of langs) {
    lines.push(`    "${language}" : ${count}`);
  }
  return lines.join("\n");
}
