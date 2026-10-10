#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { buildSolumbeArgs, parseInvocationContext, resolveBase, resolveRepoRoot, runSolumbe } from "./runtime.mjs";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  black: "\u001b[30m",
  white: "\u001b[97m",
  muted: "\u001b[38;2;160;174;192m",
  brand: "\u001b[48;2;255;255;1m",
  success: "\u001b[48;2;34;197;94m",
  warning: "\u001b[48;2;245;158;11m",
  danger: "\u001b[48;2;239;68;68m",
  successText: "\u001b[38;2;34;197;94m",
  warningText: "\u001b[38;2;245;158;11m",
  dangerText: "\u001b[38;2;239;68;68m",
};

const MIN_CONTENT_WIDTH = 52;
const MAX_CONTENT_WIDTH = 88;

function supportsColor() {
  return Boolean(stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function contentWidth(columns = stdout.columns) {
  const available = Number.isFinite(columns) ? columns - 8 : MAX_CONTENT_WIDTH;
  return Math.max(MIN_CONTENT_WIDTH, Math.min(MAX_CONTENT_WIDTH, available));
}

function paint(value, codes, color) {
  if (!color) return value;
  return `${codes.join("")}${value}${ANSI.reset}`;
}

function statusStyle(status) {
  if (status === "PASS") return [ANSI.success, ANSI.black, ANSI.bold];
  if (status === "FAIL") return [ANSI.danger, ANSI.white, ANSI.bold];
  return [ANSI.warning, ANSI.black, ANSI.bold];
}

function riskStyle(risk) {
  if (risk === "high" || risk === "critical") return [ANSI.dangerText, ANSI.bold];
  if (risk === "medium") return [ANSI.warningText, ANSI.bold];
  if (risk === "low") return [ANSI.successText, ANSI.bold];
  return [ANSI.muted];
}

function wrapText(value, width) {
  const words = String(value)
    .trim()
    .split(/\s+/)
    .flatMap((word) => {
      if (word.length <= width) return [word];
      const chunks = [];
      for (let index = 0; index < word.length; index += width) {
        chunks.push(word.slice(index, index + width));
      }
      return chunks;
    });
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function section(title, width, color) {
  const ruleWidth = Math.max(4, width - title.length - 3);
  return `${paint(title, [ANSI.bold], color)} ${paint("─".repeat(ruleWidth), [ANSI.muted], color)}`;
}

function tableValue(row, line, paddedLine, lineIndex, color) {
  if (!color || lineIndex !== 0) return paddedLine;
  if (row.status && line.startsWith(row.status)) {
    return `${paint(row.status, statusStyle(row.status), color)}${paddedLine.slice(row.status.length)}`;
  }
  if (row.risk && line.startsWith(row.risk)) {
    return `${paint(row.risk, riskStyle(row.risk.toLowerCase()), color)}${paddedLine.slice(row.risk.length)}`;
  }
  return paddedLine;
}

function infoTable(rows, width, color) {
  const labelWidth = 13;
  const valueWidth = Math.max(24, width - labelWidth - 7);
  const horizontal = (size) => "─".repeat(size);
  const border = {
    top: `┌${horizontal(labelWidth + 2)}┬${horizontal(valueWidth + 2)}┐`,
    middle: `├${horizontal(labelWidth + 2)}┼${horizontal(valueWidth + 2)}┤`,
    bottom: `└${horizontal(labelWidth + 2)}┴${horizontal(valueWidth + 2)}┘`,
  };
  const lines = [paint(border.top, [ANSI.muted], color)];

  rows.forEach((row, rowIndex) => {
    const wrapped = wrapText(row.value, valueWidth);
    wrapped.forEach((line, lineIndex) => {
      const label = lineIndex === 0 ? row.label.toUpperCase() : "";
      const paddedLine = line.padEnd(valueWidth);
      lines.push(
        `${paint("│", [ANSI.muted], color)} ${paint(label.padEnd(labelWidth), [ANSI.muted], color)} ${paint("│", [ANSI.muted], color)} ${tableValue(row, line, paddedLine, lineIndex, color)} ${paint("│", [ANSI.muted], color)}`,
      );
    });
    if (rowIndex < rows.length - 1) lines.push(paint(border.middle, [ANSI.muted], color));
  });

  lines.push(paint(border.bottom, [ANSI.muted], color));
  return lines;
}

function statusBadge(status, color) {
  return paint(` ${glyph(status)} `, statusStyle(status), color);
}

function keyBadge(key, color) {
  return paint(` ${key} `, [ANSI.brand, ANSI.black, ANSI.bold], color);
}

function clear() {
  if (stdout.isTTY) stdout.write("\u001b[2J\u001b[H");
}

function glyph(verdict) {
  if (verdict === "PASS") return "PASS";
  if (verdict === "FAIL") return "FAIL";
  return "WARN";
}

export function formatTrustSummary(report, repo, base, options = {}) {
  const color = options.color ?? false;
  const width = options.width ?? MAX_CONTENT_WIDTH;
  const checks = report.pass?.checks ?? [];
  // A skipped check has no evidence either way, so it is not "attention"; it is
  // listed below as not checked here.
  const attention = checks.filter((check) => check.status !== "PASS" && check.status !== "SKIPPED");
  const skipped = checks.filter((check) => check.status === "SKIPPED");
  const verdict = glyph(report.verdict);
  const risk = String(report.prReviewSummary?.riskLevel ?? "unknown").toLowerCase();
  const changedFiles = report.prReviewSummary?.changedFiles ?? 0;
  const additions = report.prReviewSummary?.additions ?? 0;
  const deletions = report.prReviewSummary?.deletions ?? 0;
  const lines = [
    `${paint(" SOLUMBE ", [ANSI.brand, ANSI.black, ANSI.bold], color)}  ${paint("TRUST STATUS", [ANSI.bold], color)}`,
    paint("Local merge evidence for AI-assisted changes", [ANSI.muted], color),
    "",
    section("OVERVIEW", width, color),
    ...infoTable(
      [
        { label: "Repository", value: repo },
        { label: "Compare with", value: base ?? "Not detected" },
      ],
      width,
      color,
    ),
    "",
    section("MERGE SIGNAL", width, color),
    ...infoTable(
      [
        { label: "Verdict", value: `${verdict} · confidence ${report.confidence ?? "?"}%`, status: verdict },
        { label: "Change", value: `${changedFiles} changed file${changedFiles === 1 ? "" : "s"} · +${additions} -${deletions}` },
        { label: "Risk", value: `${risk.toUpperCase()} RISK`, risk: risk.toUpperCase() },
      ],
      width,
      color,
    ),
  ];

  if (attention.length) {
    lines.push("", section(`NEEDS ATTENTION · ${attention.length}`, width, color));
    for (const check of attention) {
      const summaryLines = wrapText(check.summary, Math.max(24, width - 8));
      lines.push(`${statusBadge(check.status, color)}  ${paint(check.name, [ANSI.bold], color)}`);
      lines.push(...summaryLines.map((line) => `        ${paint(line, [ANSI.muted], color)}`));
    }
  }

  if (skipped.length) {
    lines.push("", section(`NOT CHECKED HERE · ${skipped.length}`, width, color));
    for (const check of skipped) {
      lines.push(`${paint(" SKIP ", [ANSI.muted], color)}  ${paint(check.name, [ANSI.bold], color)}`);
      lines.push(...wrapText(check.summary, Math.max(24, width - 8)).map((line) => `        ${paint(line, [ANSI.muted], color)}`));
    }
  }

  lines.push("", section("LOCAL EVIDENCE ONLY", width, color));
  lines.push(
    ...wrapText("Local evidence does not replace hosted CI, CODEOWNERS approval, unresolved-comment checks, or the human merge decision.", width).map((line) =>
      paint(line, [ANSI.dim], color),
    ),
  );
  return lines.join("\n");
}

export function formatActionBar(options = {}) {
  const color = options.color ?? false;
  return [
    `${keyBadge("r", color)} Refresh   ${keyBadge("c", color)} Context   ${keyBadge("i", color)} Impact`,
    `${keyBadge("g", color)} Validate staged   ${keyBadge("d", color)} Doctor   ${keyBadge("q", color)} Close`,
  ].join("\n");
}

export function formatTrustError(error, options = {}) {
  const color = options.color ?? false;
  const width = options.width ?? MAX_CONTENT_WIDTH;
  const message = error?.message ?? String(error);
  return [
    `${paint(" SOLUMBE ", [ANSI.brand, ANSI.black, ANSI.bold], color)}  ${paint("TRUST STATUS", [ANSI.bold], color)}`,
    "",
    section("REVIEW UNAVAILABLE", width, color),
    ...wrapText(message, width).map((line) => paint(line, [ANSI.dangerText], color)),
    "",
    paint("Check the repository and Solumbe installation, then refresh.", [ANSI.muted], color),
  ].join("\n");
}

function readReport(repo, base, request) {
  const args = ["review", repo, "--request", request, "--json"];
  if (base) args.push("--base", base);
  const result = runSolumbe(args, { cwd: repo, capture: true });
  if (result.error) throw result.error;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr.trim() || "Solumbe returned unreadable review data.");
  }
  if (report.ok === false) {
    throw new Error(report.error || "Solumbe could not generate a review.");
  }
  return report;
}

async function runInteractiveCommand(rl, action, repo, base) {
  let request;
  if (action === "context" || action === "impact" || action === "gate-staged") {
    request = (await rl.question("Change request: ")).trim();
    if (!request) return;
  }
  const args = buildSolumbeArgs(action, { repo, request, base });
  stdout.write("\n");
  const result = runSolumbe(args, { cwd: repo });
  if (result.error) throw result.error;
  await rl.question("\nPress Enter to return to trust status...");
}

export async function main() {
  const context = parseInvocationContext();
  const repo = resolveRepoRoot(context);
  const base = resolveBase(repo);
  const rl = createInterface({ input: stdin, output: stdout });
  let request = "Review current changes before merge";

  try {
    for (;;) {
      clear();
      const presentation = { color: supportsColor(), width: contentWidth() };
      let report;
      try {
        report = readReport(repo, base, request);
        stdout.write(`${formatTrustSummary(report, repo, base, presentation)}\n`);
      } catch (error) {
        stdout.write(`${formatTrustError(error, presentation)}\n`);
      }

      stdout.write(`\n${formatActionBar(presentation)}\n`);
      const choice = (await rl.question(`${paint("›", [ANSI.bold], presentation.color)} `)).trim().toLowerCase();
      if (choice === "q") break;
      if (choice === "r" || choice === "") continue;

      try {
        if (choice === "c") await runInteractiveCommand(rl, "context", repo, base);
        else if (choice === "i") {
          const nextRequest = (await rl.question("Change request: ")).trim();
          if (nextRequest) {
            request = nextRequest;
            const result = runSolumbe(buildSolumbeArgs("impact", { repo, request, base }), { cwd: repo });
            if (result.error) throw result.error;
            await rl.question("\nPress Enter to return to trust status...");
          }
        } else if (choice === "g") {
          await runInteractiveCommand(rl, "gate-staged", repo, base);
        } else if (choice === "d") {
          const result = runSolumbe(["doctor"], { cwd: repo });
          if (result.error) throw result.error;
          await rl.question("\nPress Enter to return to trust status...");
        }
      } catch (error) {
        stdout.write(`\nError: ${error.message ?? String(error)}\n`);
        await rl.question("Press Enter to continue...");
      }
    }
  } finally {
    rl.close();
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`Solumbe Herdr plugin: ${error.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
