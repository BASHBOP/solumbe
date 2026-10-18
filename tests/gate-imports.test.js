import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "The gate never consults a model" is the first guarantee on the How It
// Works page and the argument of docs/07-deterministic-verification. It has
// to stay true structurally, not by convention: the modules that compute a
// verdict must not be able to reach the model client at all. This test walks
// the static import graph from each verdict-producing module and fails the
// moment any path leads to a module that talks to a model.
//
// `model_route` and `context_pack { online: true }` are the only callers of
// the model client by design, and neither is in this set.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libDir = path.join(repoRoot, "src", "lib");

/** Modules that produce or feed a PASS / WARN / FAIL verdict or a receipt. */
const GATE_MODULES = ["pass-local.js", "pass-pr.js", "pr-review.js", "converge.js", "review.js", "impact.js"];

/** Modules that call, wrap or read a model. */
const MODEL_MODULES = ["jev.js", "claude-read.js", "model-route.js", "context-read.js", "read-eval.js"];

/**
 * Static, transitive, relative imports of a module: `import … from "./x.js"`
 * and `import("./x.js")`. Package imports are not followed; the guarantee is
 * about solumbe's own code.
 * @param {string} entry absolute path
 * @returns {Set<string>} absolute paths, entry included
 */
function importClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*import[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
      stack.push(path.resolve(path.dirname(file), match[1]));
    }
    for (const match of source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      stack.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  return seen;
}

test("the model modules this test guards against still exist, so the guard is not vacuous", () => {
  for (const name of MODEL_MODULES) {
    assert.ok(fs.existsSync(path.join(libDir, name)), `${name} moved or was renamed; update MODEL_MODULES so the gate guard keeps meaning something`);
  }
  const jev = fs.readFileSync(path.join(libDir, "jev.js"), "utf8");
  assert.match(jev, /TYPESAFE_API_KEY|fetch\(/, "jev.js should be the module that talks to the model");
});

for (const name of GATE_MODULES) {
  test(`${name} reaches no model client through its import graph`, () => {
    const closure = importClosure(path.join(libDir, name));
    const reached = MODEL_MODULES.filter((model) => closure.has(path.join(libDir, model)));
    assert.deepEqual(
      reached,
      [],
      `${name} imports ${reached.join(", ")} (directly or transitively). A verdict must be computable without a model; ` +
        `if a gate needs a model's output, pass it in as data rather than importing the client.`,
    );
  });
}

test("the How It Works page still states the guarantee this test enforces", () => {
  const html = fs.readFileSync(path.join(repoRoot, "docs", "assets", "solumbe-how-it-works.html"), "utf8");
  assert.match(html, /The gate never consults a model/);
});
