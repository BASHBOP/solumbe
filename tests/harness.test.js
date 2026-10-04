import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateHarness } from "../src/lib/harness.js";

test("generateHarness returns commands, focus areas, and token estimates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-harness-"));
  fs.mkdirSync(path.join(root, "src", "events"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "events-api",
      scripts: {
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "node --test",
        dev: "node src/main.ts",
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, "src", "events", "events.controller.ts"),
    [
      "import { Controller, Get } from '@nestjs/common';",
      "@Controller('events')",
      "export class EventsController {",
      "  @Get(':id')",
      "  findOne() {}",
      "}",
      "",
    ].join("\n"),
  );

  const result = generateHarness(root);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.repo.name, "events-api");
  assert.ok(result.data.commands.setup.some((command) => command.command === "npm install"));
  assert.ok(result.data.commands.validate.some((command) => command.command === "npm test"));
  assert.ok(result.data.commands.runtime.some((command) => command.command === "npm run dev"));
  assert.ok(result.data.focusAreas.includes("backend request controllers"));
  assert.ok(result.data.tokenEstimate.fullJson > 0);
  assert.match(result.markdown, /# solumbe Harness: events-api/);
  assert.match(result.markdown, /## Token Budget/);
});

test("generateHarness lists a type check named with a tsc segment", () => {
  for (const name of ["tsc:check", "tsc", "check:tsc", "tsc-check"]) {
    const root = packageFixture({ lint: "eslint .", [name]: "tsc --noEmit", test: "jest" });
    const result = generateHarness(root);

    assert.deepEqual(
      result.data.commands.validate.map((command) => [command.script, command.command, command.reason]),
      [
        ["lint", "npm run lint", "static checks"],
        [name, `npm run ${name}`, "type contract checks"],
        ["test", "npm test", "behavior verification"],
      ],
    );
    assert.ok(result.markdown.includes(`- \`npm run ${name}\`: type contract checks`));
  }
});

test("generateHarness lists no script that only contains the letters of a type check", () => {
  const root = packageFixture({
    lint: "eslint .",
    "tsconfig:sync": "node scripts/sync-tsconfig.js",
    prototype: "node prototype.js",
    "types:generate": "openapi-typescript api.yaml -o src/api.d.ts",
    "tsc:watch": "tsc --noEmit --watch",
    "tsc:build": "tsc -p tsconfig.build.json",
  });

  assert.deepEqual(
    generateHarness(root).data.commands.validate.map((command) => command.script),
    ["lint"],
  );
});

test("generateHarness lists the type checks it already listed, in the same order, and no more", () => {
  const root = packageFixture({
    tsc: "tsc --noEmit",
    "tsc:check": "tsc --noEmit",
    "check:type": "tsc --noEmit",
    "version:check": "node scripts/check-version.js",
    typecheck: "tsc --noEmit",
  });

  assert.deepEqual(
    generateHarness(root).data.commands.validate.map((command) => command.script),
    ["typecheck", "version:check", "check:type", "tsc"],
  );
});

test("generateHarness lists the type check and the headless end-to-end run of a yarn web app", () => {
  const root = packageFixture(
    {
      dev: "next dev --turbopack",
      build: "next build",
      "build:prep": "yarn lint && yarn tsc:check",
      lint: "eslint . --ext .js,.jsx,.ts,.tsx",
      "lint:fix": "eslint . --ext .js,.jsx,.ts,.tsx --fix",
      "tsc:check": "tsc --noEmit",
      test: "jest",
      "test:watch": "jest --watch",
      "test:e2e": "playwright test --headed",
      "test:e2e:headless": "playwright test --reporter=line",
      "test:e2e:ui": "playwright test --ui",
    },
    { "yarn.lock": "" },
  );

  assert.deepEqual(
    generateHarness(root).data.commands.validate.map((command) => [command.command, command.reason]),
    [
      ["yarn lint", "static checks"],
      ["yarn tsc:check", "type contract checks"],
      ["yarn test", "behavior verification"],
      ["yarn test:e2e:headless", "behavior verification"],
      ["yarn build", "integration and bundling verification"],
    ],
  );
});

test("generateHarness keeps the end-to-end script of a package with no headless sibling", () => {
  const root = packageFixture({ test: "jest", "test:e2e": "playwright test" });

  assert.deepEqual(
    generateHarness(root).data.commands.validate.map((command) => command.command),
    ["npm test", "npm run test:e2e"],
  );
});

/**
 * @param {Record<string, string>} scripts
 * @param {Record<string, string>} [files]
 * @returns {string}
 */
function packageFixture(scripts, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-harness-scripts-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "scripts-fixture", scripts }));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

// Regression (dogfood, bashbop-go): a Go module with tests and a CI workflow
// reported "No validation scripts detected" and no entrypoints.
test("generateHarness gives a Go module its toolchain validation and cmd entrypoints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-go-"));
  const files = {
    "go.mod": "module example.com/fees\n\ngo 1.22\n",
    "cmd/fees/main.go": "package main\n\nfunc main() {}\n",
    "internal/fees/fees.go": "package fees\n\nfunc Calculate() int { return 1 }\n",
    "internal/fees/fees_test.go": 'package fees\n\nimport "testing"\n\nfunc TestCalculate(t *testing.T) {}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }

  const { data } = generateHarness(root);
  const validate = data.commands.validate.map((entry) => entry.command);
  assert.ok(validate.includes("go vet ./..."), validate.join(", "));
  assert.ok(validate.includes("go test ./..."), validate.join(", "));
  assert.ok(data.repo.entrypoints.includes("cmd/fees/main.go"), JSON.stringify(data.repo.entrypoints));
});
