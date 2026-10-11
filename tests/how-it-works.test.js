import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentTools } from "../src/lib/agent-tools.js";
import { tools } from "../src/lib/mcp.js";
import { SUPPORTING_COMMANDS } from "../scripts/how-it-works/content.js";

// The How It Works page is linked from the docs home page as *the* visual
// explanation of solumbe. It was hand-maintained and drifted for eighteen
// releases: it advertised a `repo_catalog` tool that no longer exists and
// never gained `agent_experience` or `convergence_score`. It is now generated
// from the same tool catalog the MCP server is derived from, and these tests
// fail the moment the committed file stops matching what ships.
//
// `npm run docs:diagram:check` additionally proves the whole file is
// byte-identical to a fresh render; these tests isolate the properties that
// actually misled readers, each with a message that says how to fix it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramPath = path.join(repoRoot, "docs", "assets", "solumbe-how-it-works.html");
const packageVersion = String(JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version);

/** Tool names carried by the page's card titles. */
function diagramToolNames(html) {
  return [...html.matchAll(/data-title="([a-z_]+)"/g)].map((match) => match[1]).sort();
}

/** CLI commands the page stands for, from tool cards and surfaces alike. */
function diagramCommands(html) {
  return new Set([...html.matchAll(/data-command="([a-z-]+)"/g)].map((match) => match[1]));
}

/** Command words from the Usage block of `solumbe help --all`, `install|i` split. */
function helpCommands() {
  const help = execFileSync(process.execPath, [path.join(repoRoot, "src", "cli.js"), "help", "--all"], { encoding: "utf8" });
  const usage = help.split(/\n(?=Examples:)/)[0];
  const commands = new Set();
  for (const match of usage.matchAll(/^\s+solumbe (\S+)/gm)) {
    for (const word of match[1].split("|")) {
      if (!word.startsWith("-")) commands.add(word);
    }
  }
  return commands;
}

test("the How It Works page covers exactly the shipped MCP tool catalog", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  const catalog = getAgentTools()
    .tools.map((tool) => tool.name)
    .sort();
  const onDiagram = diagramToolNames(html);

  const missing = catalog.filter((name) => !onDiagram.includes(name));
  const stale = onDiagram.filter((name) => !catalog.includes(name));

  assert.deepEqual(missing, [], `tools missing from the page — run \`npm run docs:diagram\``);
  assert.deepEqual(stale, [], `tools on the page that no longer exist — run \`npm run docs:diagram\``);
  assert.equal(onDiagram.length, catalog.length);
});

test("every MCP tool has a one-sentence summary, and the page shows that sentence", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  for (const tool of tools) {
    assert.ok(tool.summary && tool.summary.trim().length > 0, `${tool.name} has no summary in src/lib/mcp.js; the page has nothing to say about it`);
    assert.ok(tool.summary.length <= 320, `${tool.name} summary is ${tool.summary.length} characters; keep it to one or two sentences`);
    const card = html.match(new RegExp(`data-title="${tool.name}"[^>]*data-desc="([^"]*)"`));
    assert.ok(card, `${tool.name} card must carry a description`);
    const escaped = tool.summary.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    assert.ok(card[1].startsWith(escaped), `${tool.name} card text does not start with its summary — run \`npm run docs:diagram\``);
  }
});

test("the page names every tool in its MCP surface description", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  const catalog = getAgentTools().tools.map((tool) => tool.name);

  const mcpNode = html.match(/data-id="mcp"[^>]*data-desc="([^"]*)"/);
  assert.ok(mcpNode, "the MCP entry node must carry a description");
  const description = mcpNode[1];

  assert.match(description, new RegExp(`exposing ${catalog.length} tools`), "the advertised tool count must match the catalog");
  for (const name of catalog) {
    assert.ok(description.includes(name), `${name} must be listed in the MCP surface description`);
  }
});

test("every command in `solumbe help` is a card on the page or an explained supporting command", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  const onPage = diagramCommands(html);
  const inHelp = helpCommands();
  const supporting = new Set(Object.keys(SUPPORTING_COMMANDS));

  assert.ok(inHelp.size >= 30, `expected the Usage block to list the CLI, parsed only ${inHelp.size} commands`);

  const unaccounted = [...inHelp].filter((command) => !onPage.has(command) && !supporting.has(command)).sort();
  assert.deepEqual(
    unaccounted,
    [],
    `new CLI command(s) with no place on the How It Works page: ${unaccounted.join(", ")}. ` +
      `Add a card in scripts/how-it-works/content.js, or add the command to SUPPORTING_COMMANDS with the reason it is not a stage of the loop.`,
  );

  const gone = [...supporting].filter((command) => !inHelp.has(command)).sort();
  assert.deepEqual(gone, [], `SUPPORTING_COMMANDS names commands the CLI no longer has: ${gone.join(", ")}`);

  const both = [...supporting].filter((command) => onPage.has(command)).sort();
  assert.deepEqual(both, [], `these commands are both a card and a supporting command; pick one: ${both.join(", ")}`);

  const dangling = [...onPage].filter((command) => !inHelp.has(command)).sort();
  assert.deepEqual(dangling, [], `the page stands for commands the CLI no longer has: ${dangling.join(", ")}`);

  for (const [command, reason] of Object.entries(SUPPORTING_COMMANDS)) {
    assert.ok(reason.trim().length > 0, `SUPPORTING_COMMANDS.${command} needs a reason`);
  }
});

test("the page shows the stages after the gate", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  const cliCards = [...html.matchAll(/data-kind="cli"[^>]*data-command="([a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(cliCards.includes("attest"), "the page must show the post-merge attestation stage");
  assert.ok(cliCards.includes("calibrate") && cliCards.includes("regret"), "the page must show the history-graded stage");
});

test("the page carries the package version, so a release re-renders it", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  assert.match(
    html,
    new RegExp(`<meta name="solumbe:version" content="${packageVersion.replace(/\./g, "\\.")}"`),
    `the page was rendered for a different version — \`npm version\` regenerates it; otherwise run \`npm run docs:diagram\``,
  );
});

test("the page is marked generated so it is not hand-edited back into drift", () => {
  const html = fs.readFileSync(diagramPath, "utf8");
  assert.match(html, /Generated by scripts\/generate-how-it-works\.mjs/);
  assert.match(html, /npm run docs:diagram/);
});
