import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAstFacts } from "../src/lib/code-map/ast.js";
import { generateContextPack } from "../src/lib/context-engine.js";
import { generateImpact } from "../src/lib/impact.js";

// A tool registry in the shape of solumbe's own MCP server: a table names each
// tool as a string, and a switch dispatches it to the module that does the work.
const registrySource = [
  'import { generateConvergence } from "./converge.js";',
  'import { generateContextPack } from "./context-engine.js";',
  "",
  "export const tools = [",
  '  { name: "convergence_score", title: "Convergence Score" },',
  '  { name: "context_pack", title: "Context Pack" },',
  "];",
  "",
  "export function callTool(name, args) {",
  "  switch (name) {",
  '    case "convergence_score":',
  "      return generateConvergence(requiredQuery(args));",
  '    case "context_pack":',
  "      return generateContextPack(requiredQuery(args));",
  "    default:",
  "      throw new Error(name);",
  "  }",
  "}",
  "",
  "function requiredQuery(args) {",
  "  return String(args.query);",
  "}",
  "",
].join("\n");

function makeRegistryRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-registered-"));
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  };
  write("package.json", JSON.stringify({ name: "registry-fixture" }));
  write("src/lib/mcp.js", registrySource);
  write("src/lib/converge.js", "export function generateConvergence(query) {\n  const coverage = query.length;\n  return { coverage };\n}\n");
  write("src/lib/context-engine.js", "export function generateContextPack(query) {\n  return { query };\n}\n");
  // Decoys that share words with the request but implement nothing it names.
  write("src/lib/score-bands.js", "export function scoreBandFor(score) {\n  return score > 80 ? 'aligned' : 'partial';\n}\n");
  write("src/lib/drift-report.js", "export function formatDriftReport(files) {\n  return files.join(', ');\n}\n");
  return root;
}

test("extractAstFacts records a registry's string names with the functions they call", () => {
  const facts = extractAstFacts("src/lib/mcp.js", registrySource);
  const registered = facts.symbols.filter((symbol) => symbol.type === "registered");

  assert.deepEqual(
    registered.map(({ name, terms }) => ({ name, terms })),
    [
      { name: "convergence_score", terms: ["generateConvergence", "requiredQuery"] },
      { name: "context_pack", terms: ["generateContextPack", "requiredQuery"] },
    ],
  );
  // A display name is prose, not a name code refers to.
  assert.ok(!facts.symbols.some((symbol) => symbol.name === "Convergence Score"));
});

test("generateContextPack pins the module that implements a tool the request names", () => {
  const root = makeRegistryRepo();
  try {
    const pack = generateContextPack("fix convergence_score so a renamed test still counts and the drift report stays short", { path: root });
    const [first] = pack.data.primaryFiles;

    assert.equal(first.path, "src/lib/converge.js");
    assert.ok(first.reasons.includes("implements convergence_score, registered in src/lib/mcp.js"), first.reasons.join("; "));
    assert.ok(
      [...pack.data.primaryFiles, ...pack.data.relatedFiles].some((file) => file.path === "src/lib/mcp.js"),
      "the registry that names the tool stays in the pack",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generateImpact ranks a named tool's implementation as a required owner", () => {
  const root = makeRegistryRepo();
  try {
    const result = generateImpact("fix convergence_score so a renamed test still counts and the drift report stays short", { path: root });
    const [first] = result.data.topFiles;

    assert.equal(first.path, "src/lib/converge.js");
    assert.equal(first.role, "required");
    assert.ok(
      first.reasons.some((reason) => reason.startsWith("implements `convergence_score`")),
      first.reasons.join("; "),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fixture's registry does not pin its own modules in the repository around it", () => {
  const root = makeRegistryRepo();
  try {
    const fixture = path.join(root, "evals", "fixtures", "copy");
    fs.mkdirSync(path.join(fixture, "src", "lib"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "src", "lib", "mcp.js"), registrySource);
    fs.writeFileSync(path.join(fixture, "src", "lib", "converge.js"), "export function generateConvergence(query) {\n  return query;\n}\n");

    const pack = generateContextPack("fix convergence_score so a renamed test still counts", { path: root });
    const pinned = pack.data.primaryFiles.filter((file) => file.reasons.some((reason) => reason.startsWith("implements")));
    assert.deepEqual(
      pinned.map((file) => file.path),
      ["src/lib/converge.js"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a branch's shared helper does not count as the tool's implementation", () => {
  const root = makeRegistryRepo();
  try {
    fs.writeFileSync(
      path.join(root, "src", "lib", "mcp.js"),
      registrySource
        .replace(
          'import { generateContextPack } from "./context-engine.js";',
          'import { generateContextPack } from "./context-engine.js";\nimport { contextRepoPaths } from "./config.js";',
        )
        .replace("return generateContextPack(requiredQuery(args));", "return generateContextPack(requiredQuery(args), contextRepoPaths(args));"),
    );
    fs.writeFileSync(path.join(root, "src", "lib", "config.js"), "export function contextRepoPaths(args) {\n  return [args.path];\n}\n");

    const pack = generateContextPack("fix context_pack for repeated words", { path: root });
    const pinned = pack.data.primaryFiles.filter((file) => file.reasons.some((reason) => reason.startsWith("implements")));
    assert.deepEqual(
      pinned.map((file) => file.path),
      ["src/lib/context-engine.js"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
