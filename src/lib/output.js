import fs from "node:fs";
import path from "node:path";
import { createRenderer } from "./render/fancy.js";

/**
 * @typedef {{ emoji?: boolean, color?: boolean, theme?: string }} TerminalOptions
 * @typedef {{ status: "verified" | "tests-pass" | "runs" | "not-verified", detail?: string }} ClosingLine
 * @typedef {{ title: string, items: string[], glyph?: string, kind?: "list" | "tree" }} SummarySection
 * @typedef {{ title: string, glyph?: string, subtitle?: string, facts?: [string, string | number][], sections?: SummarySection[], close?: ClosingLine, options?: TerminalOptions }} SummaryInput
 */

/**
 * Render a compact, human-first terminal summary in solumbe's shared shape: the
 * header box, the facts as a table, each section as a list (a file list as a
 * tree), and the closing line last. JSON and Markdown callers should continue
 * using their dedicated serializers instead of this helper.
 *
 * @param {SummaryInput} input
 * @returns {string}
 */
export function formatTerminalSummary(input) {
  const renderer = createRenderer(input.options);
  const lines = [];
  const headlines = input.subtitle ? [{ text: input.subtitle, glyph: "💬" }] : [];
  lines.push(renderer.header({ text: input.title, glyph: input.glyph }, headlines));

  if (input.facts?.length) {
    const facts = renderer.table(
      input.facts.map(([label, value]) => [label, String(value)]),
      { width: renderer.width - 2 },
    );
    lines.push("");
    lines.push(renderer.section(`${renderer.pick({ emoji: "📌 ", ascii: "" })}At a glance`, facts.split("\n")));
  }

  for (const section of input.sections ?? []) {
    lines.push("");
    const title = `${renderer.pick({ emoji: section.glyph ? `${section.glyph} ` : "", ascii: "" })}${section.title}`;
    const item = renderer.paint(renderer.glyphs.item, "dim");
    const body = !section.items.length
      ? [`${item} none`]
      : section.kind === "tree"
        ? renderer.tree(section.items).split("\n")
        : section.items.map((line) => `${item} ${line}`);
    lines.push(renderer.section(title, body));
  }

  if (input.close) {
    lines.push("");
    lines.push(renderer.close(input.close));
  }
  return lines.join("\n");
}

/**
 * The closing line for a command that wrote files: `Verified.` once every
 * file re-reads as a non-empty file, otherwise the first one that did not.
 * @param {string} root
 * @param {string[]} relativePaths
 * @returns {ClosingLine}
 */
export function verifyWrittenFiles(root, relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      if (fs.statSync(path.join(root, relativePath)).size > 0) continue;
    } catch {
      // Missing file: fall through to the closing line below.
    }
    return { status: "not-verified", detail: `${relativePath} did not re-read after writing` };
  }
  return { status: "verified" };
}

/**
 * @param {string} text
 * @returns {void}
 */
export function printText(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * @param {unknown} value
 * @returns {void}
 */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printHelp() {
  printText(`solumbe

Usage:
  solumbe --version | -v
  solumbe doctor [--json]
  solumbe repo <path> [--json]
  solumbe discover <root...> [--depth n] [--limit n] [--json]
  solumbe index <repo...> [--discover] [--catalog file] [--json]
  solumbe catalog [--catalog file] [--json]
  solumbe search <query> [--catalog file] [--limit n] [--offline] [--json]
  solumbe context <query> [--path repo] [--limit n] [--online] [--out file] [--json]
  solumbe impact <repo> <query> [--top n] [--diff-base ref] [--out file] [--json] [--mermaid]
  solumbe obsidian <repo> [--query text] [--out vault-dir] [--limit n] [--top n] [--json]
  solumbe ax <repo> <query> [--top n] [--out file] [--json]
  solumbe route <repo> <query> [--host id] [--tier-only] [--offline] [--top n] [--out file] [--json]   # recommend a model tier before spending on the task
  solumbe converge <repo> <query> --base <ref> [--head ref | --staged] [--include-untracked] [--top n] [--out file] [--json]
  solumbe declare <repo> <request> [--top n] [--out file] [--json]                            # before the edit: record the files the request is expected to touch
  solumbe amend <file...> --reason text [--path repo] [--intent file] [--json]                # add files to the declared intent, with the reason they belong
  solumbe attest [repo] --verdict file --merge sha [--prev sha] [--pr n] [--author name] [--committed iso] [--ledger file] [--json]   # append a hash-chained record of a merged commit
  solumbe attest [repo] --verify [--ledger file] [--json]                                     # recompute the chain; exits 1 if any record was altered
  solumbe calibrate <repo> [--window days] [--min-sample n] [--since date] [--max n] [--json]   # grade risk flags against this repo's own history
  solumbe calibrate <repo> --gate [--window days] [--min-sample n] [--since date] [--max commits] [--policy x] [--governance x] [--quiet] [--out file] [--json]   # replay the gate and the convergence score over history; grade verdict and band
  solumbe calibrate <repo> --follow-through [--all] [--window-min minutes] [--min-sample n] [--out file] [--json]   # from the usage log: how often a warning had cleared on the next run
  solumbe calibrate <repo> --trial [--log file] [--window days] [--min-sample n] [--out file] [--json]   # grade the shown and withheld arms of SOLUMBE_CHECK_MODE=trial
  solumbe regret <repo> [--window days] [--min-sample n] [--since date] [--max commits] [--offline] [--quiet] [--out file] [--json]   # grade route tiers against this repo's own history
  solumbe regret --rescore run.json [--out file] [--json]                                     # regrade a saved run with the current arithmetic; replays and calls nothing
  solumbe pass <repo> [--base ref] [--head ref | --staged] [--run-validation] [--policy standard|company|high-risk] [--governance team|solo] [--request text] [--min-convergence n] [--receipt hash|file] [--intent file] [--out file] [--json]
  solumbe gate [repo | --path repo] [--base ref] [--head ref | --staged] [--run-validation] [--policy standard|company|high-risk] [--governance team|solo] [--request text] [--min-convergence n] [--receipt hash|file] [--intent file] [--out file] [--json]
  solumbe pass-pr [selector] [--path repo] [--policy x] [--governance x] [--request text] [--min-convergence n] [--receipt hash|file] [--intent file] [--out file] [--json]
  solumbe review [repo | --path repo] [request] [--request text] [--base ref] [--pr selector] [--policy x] [--governance x] [--min-convergence n] [--receipt hash|file] [--intent file] [--json] [--mermaid]
  solumbe install|i [--global|--link] [--json]
  solumbe install --host all|claude-code,claude-desktop,codex,cursor,vscode,gemini,kimi [--dry-run] [--canvas url] [--json]   # connect the MCP server to agent hosts
  solumbe map <path> [--out file] [--json] [--mermaid]
  solumbe structure <path> [--pattern glob] [--out file] [--exclude file] [--json]
  solumbe deps <package> [--query text] [--limit n] [--json]
  solumbe init <path> [--tool-repo owner/repo] [--tool-ref ref] [--force] [--no-workflow] [--no-gates] [--no-precommit] [--hooks-path] [--yes] [--json]
  solumbe matrix [--json]
  solumbe mcp
  solumbe pr <path> [--number n] [--base ref] [--head ref] [--out file] [--comment] [--json]
  solumbe report <path> [--out file] [--json] [--mermaid]
  solumbe workspace <repo...> [--out file] [--json] [--mermaid]
  solumbe workspace-gate <repo...> [--base ref] [--run-validation] [--policy standard|company|high-risk] [--governance team|solo] [--request text] [--json]
  solumbe harness <path> [--out file] [--json]
  solumbe eval <path> [--query text] [--naive-cap n] [--out file] [--json]
  solumbe eval --accuracy|--harness|--gate-effectiveness [--corpus file] [--out file] [--json]
  solumbe data-access <path> [--out file] [--json] [--mermaid]
  solumbe agent-tools [--json|--markdown]
  solumbe dashboard [<repo>] [--out file] [--json] [--clear] [--no-artifacts] [--no-git]   # local usage & performance UI (HTML)
  solumbe telemetry [status|on|off|clear] [--json]                                          # opt-in local usage capture
  solumbe telemetry share [status|on|off]                                                    # separate anonymous sharing opt-in
  solumbe config [list]                           # show config with source annotations
  solumbe config get [key]                        # show one or all resolved values
  solumbe config set <key> <value> [--local]      # write to user (or local) config
  solumbe config set color true                   # enable color in user config
  solumbe config set theme high-contrast          # set theme (default|color|minimal|high-contrast)
  solumbe config set emoji true                   # opt back into emoji glyphs in user config
  solumbe config set telemetry true               # opt in to local usage capture for the dashboard
  solumbe telemetry share on                      # optionally share a minimal anonymous usage shape

Global flags (every command that prints for a terminal):
  --emoji | --no-emoji        emoji glyphs on, or ASCII glyphs off; the default is plain Unicode (ASCII under CI, NO_EMOJI=1 or TERM=dumb)
  --color | --no-color        ANSI colour on or off; the default follows the terminal, NO_COLOR and FORCE_COLOR
  --theme name                default | color | minimal | high-contrast

Examples:
  node src/cli.js doctor
  node src/cli.js repo . --json
  node src/cli.js discover ~/projects --depth 2
  node src/cli.js index ~/projects --discover
  node src/cli.js catalog
  node src/cli.js search "events controller"
  node src/cli.js context "add a new MCP tool" --path .
  node src/cli.js install
  node src/cli.js map . --json
  node src/cli.js init ../my-repo
  node src/cli.js init ../my-repo --hooks-path --yes
  node src/cli.js mcp
  node src/cli.js pr . --base origin/main --out .solumbe/pr-review.md
  node src/cli.js harness . --out .solumbe/harness.md
  node src/cli.js deps zod --query parse
  node src/cli.js report . --out .solumbe/report.md
  node src/cli.js workspace ../web ../api --out .solumbe/workspace.md
  node src/cli.js structure ../web --pattern 'app/**/*.tsx' --out .solumbe/app.html
  node src/cli.js eval . --out .solumbe/eval.md
  node src/cli.js eval --gate-effectiveness
  node src/cli.js attest . --verify
`);
}

/**
 * @param {string} targetPath
 * @param {string | NodeJS.ArrayBufferView} contents
 * @returns {{ path: string }}
 */
export function writeArtifact(targetPath, contents) {
  const absolutePath = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  return { path: absolutePath };
}
