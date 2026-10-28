import test from "node:test";
import assert from "node:assert/strict";
import { buildDependencyGraph, transitiveDependents } from "../src/lib/dependency-graph.js";

/** @param {string} filePath @param {string[]} [imports] @param {Record<string, unknown>} [extra] */
const file = (filePath, imports = [], extra = {}) => ({ path: filePath, kind: "source", imports, ...extra });

test("buildDependencyGraph labels resolved specifiers EXTRACTED and a unique bare path match INFERRED", () => {
  const files = [
    file("src/utils/format.ts"),
    file("src/api/handler.ts", ["../utils/format.js"]),
    file("src/web/page.ts", ["utils/format"]),
    file("src/web/alias.ts", ["@/utils/format"]),
  ];
  const graph = buildDependencyGraph(files);
  const importers = graph.importersByPath.get("src/utils/format.ts");
  assert.equal(importers?.get("src/api/handler.ts"), "EXTRACTED");
  assert.equal(importers?.get("src/web/alias.ts"), "EXTRACTED");
  assert.equal(importers?.get("src/web/page.ts"), "INFERRED");
  assert.equal(graph.edgeCount, 3);
  assert.equal(graph.inferredEdgeCount, 1);
});

test("buildDependencyGraph infers nothing for a declared package, a one-word specifier, or an ambiguous name", () => {
  const files = [
    file("src/lodash/get.ts"),
    file("src/path.ts"),
    file("src/a/shared/util.ts"),
    file("src/b/shared/util.ts"),
    file("src/app.ts", ["lodash/get", "path", "shared/util", "node:fs"]),
  ];
  const graph = buildDependencyGraph(files, { packages: ["lodash"] });
  assert.equal(graph.edgeCount, 0);
});

test("buildDependencyGraph links a Go import to the files of the package directory and skips vendored files and docs", () => {
  const files = [
    file("pkg/store/store.go"),
    file("pkg/store/cache.go"),
    file("cmd/api/main.go", [], { importDirs: ["pkg/store"] }),
    file("vendor/lib/x.ts", ["../../src/app.js"], { isVendor: true }),
    file("docs/app.md", ["../src/app.ts"], { kind: "doc" }),
    file("src/app.ts"),
  ];
  const graph = buildDependencyGraph(files);
  assert.equal(graph.importersByPath.get("pkg/store/store.go")?.get("cmd/api/main.go"), "EXTRACTED");
  assert.equal(graph.importersByPath.get("pkg/store/cache.go")?.get("cmd/api/main.go"), "EXTRACTED");
  assert.equal(graph.importersByPath.has("src/app.ts"), false);
});

test("transitiveDependents walks importers by depth and keeps a path INFERRED once any hop is", () => {
  const files = [
    file("src/core.ts"),
    file("src/service.ts", ["./core.js"]),
    file("src/guessed.ts", ["src/core"]),
    file("src/controller.ts", ["./service.js"]),
    file("src/route.ts", ["./guessed.js", "./controller.js"]),
    file("tests/core.test.ts", ["../src/core.js"], { kind: "test" }),
  ];
  const graph = buildDependencyGraph(files);
  const result = transitiveDependents(graph, ["src/core.ts"], files);
  assert.deepEqual(
    result.files.map((entry) => [entry.path, entry.depth, entry.provenance, entry.via]),
    [
      ["src/service.ts", 1, "EXTRACTED", "src/core.ts"],
      ["tests/core.test.ts", 1, "EXTRACTED", "src/core.ts"],
      ["src/guessed.ts", 1, "INFERRED", "src/core.ts"],
      ["src/controller.ts", 2, "EXTRACTED", "src/service.ts"],
      ["src/route.ts", 2, "INFERRED", "src/guessed.ts"],
    ],
  );
  assert.equal(result.files[1].kind, "test");
  assert.equal(result.truncated, false);
});

test("transitiveDependents prefers an all-EXTRACTED path at the same depth, and honours maxDepth and limit", () => {
  const files = [file("src/core.ts"), file("src/a.ts", ["./core.js"]), file("src/b.ts", ["src/core"]), file("src/top.ts", ["./b.js", "./a.js"])];
  const graph = buildDependencyGraph(files);
  const top = transitiveDependents(graph, ["src/core.ts"], files).files.find((entry) => entry.path === "src/top.ts");
  assert.deepEqual([top?.provenance, top?.via], ["EXTRACTED", "src/a.ts"]);

  assert.deepEqual(
    transitiveDependents(graph, ["src/core.ts"], files, { maxDepth: 1 }).files.map((entry) => entry.path),
    ["src/a.ts", "src/b.ts"],
  );
  const limited = transitiveDependents(graph, ["src/core.ts"], files, { limit: 1 });
  assert.deepEqual([limited.files.length, limited.truncated], [1, true]);
});

test("transitiveDependents never reports a starting file as its own dependent", () => {
  const files = [file("src/a.ts", ["./b.js"]), file("src/b.ts", ["./a.js"])];
  const graph = buildDependencyGraph(files);
  assert.deepEqual(transitiveDependents(graph, ["src/a.ts", "src/b.ts"], files).files, []);
});
