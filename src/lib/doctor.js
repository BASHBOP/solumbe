import path from "node:path";
import { commandExists, commandVersion } from "./tools.js";
import { createRenderer } from "./render/fancy.js";
import { userConfigStatus } from "./config.js";

const toolDefinitions = [
  {
    name: "node",
    command: "node",
    versionArgs: ["--version"],
    installHint: "Install Node.js 18+.",
  },
  {
    name: "git",
    command: "git",
    versionArgs: ["--version"],
    installHint: "Install git.",
  },
  {
    name: "gh",
    command: "gh",
    versionArgs: ["--version"],
    installHint: "Install the GitHub CLI (https://cli.github.com); required by pr_merge_readiness and gh-enriched pr_review.",
  },
  {
    name: "rg",
    command: "rg",
    versionArgs: ["--version"],
    installHint: "Install ripgrep for faster source searching.",
  },
  {
    name: "npx",
    command: "npx",
    versionArgs: ["--version"],
    installHint: "Install npm/npx, or install optional tools globally.",
  },
  {
    name: "opensrc",
    command: "opensrc",
    versionArgs: ["--version"],
    installHint: "Install with: npm install -g opensrc",
  },
  {
    name: "code-structure",
    command: "code-structure",
    versionArgs: ["--version"],
    installHint: "Install with: npm install -g code-structure for faster runs; structure can fall back to npx.",
  },
];

/**
 * One tool's availability status in the doctor report.
 * @typedef {object} DoctorTool
 * @property {string} name
 * @property {string} command
 * @property {boolean} available
 * @property {string | undefined} path
 * @property {string | undefined} version
 * @property {string} installHint
 *
 * @typedef {object} DoctorReport
 * @property {boolean} ok
 * @property {DoctorTool[]} tools
 * @property {import("./config.js").UserConfigStatus} [userConfig]
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {DoctorReport}
 */
export function getDoctorReport(env = process.env) {
  return {
    ok: true,
    userConfig: userConfigStatus(env),
    tools: toolDefinitions.map((tool) => {
      const exists = commandExists(tool.command);
      return {
        name: tool.name,
        command: tool.command,
        available: exists.available,
        path: exists.path,
        version: exists.available ? commandVersion(tool.command, tool.versionArgs) : undefined,
        installHint: tool.installHint,
      };
    }),
  };
}

/**
 * @param {DoctorReport} report
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 * @returns {string}
 */
export function formatDoctorReport(report, options = {}) {
  const renderer = createRenderer(options);
  /** @type {string[]} */
  const lines = [];
  lines.push(renderer.header({ text: "solumbe doctor", glyph: "📋" }, [{ text: "local runtime + optional tools", glyph: "🩺" }]));
  lines.push("");
  for (const tool of report.tools) {
    const status = tool.available ? "pass" : "warn";
    const summary = tool.available ? (tool.version ?? "available") : "not installed";
    const details = tool.available ? [] : [tool.installHint];
    lines.push(renderer.statusLine(status, tool.name, summary, details));
  }
  const config = report.userConfig;
  if (config?.source === "legacy") {
    lines.push(
      renderer.statusLine("warn", "user config", `read from the pre-rename ${config.legacyPath}`, [
        `Its settings apply until ${config.path} exists. To move it: mkdir -p "${path.dirname(config.path)}" && mv "${config.legacyPath}" "${config.path}"`,
      ]),
    );
  }
  lines.push("");
  lines.push(renderer.tip("rg, opensrc, and code-structure are optional accelerators."));
  return lines.join("\n");
}
