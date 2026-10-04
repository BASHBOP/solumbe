import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateWorkspaceReport } from "../src/lib/workspace.js";

test("generateWorkspaceReport aggregates multiple repos", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-workspace-"));
  const web = path.join(root, "web");
  const api = path.join(root, "api");
  fs.mkdirSync(path.join(web, "app"), { recursive: true });
  fs.mkdirSync(path.join(api, "src"), { recursive: true });
  fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({ scripts: { dev: "next dev", build: "next build" } }));
  fs.writeFileSync(path.join(web, "app", "page.tsx"), "export default function Page() { return null; }\n");
  fs.writeFileSync(path.join(api, "package.json"), JSON.stringify({ main: "dist/main", scripts: { dev: "nest start --watch", test: "jest" } }));
  fs.writeFileSync(path.join(api, "src", "main.ts"), "console.log('api');\n");

  const result = generateWorkspaceReport([web, api]);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.repoCount, 2);
  assert.equal(result.data.totalFiles, 4);
  assert.match(result.markdown, /# solumbe Workspace Report/);
  assert.match(result.markdown, /web/);
  assert.match(result.markdown, /api/);
});

// Regression (dogfood): a Next app, a Nest API and a Go service were described
// as "Next frontend plus Nest/Prisma API", with an internal TODO as a note.
test("generateWorkspaceReport describes the repositories it was given", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-workspace-go-"));
  const api = path.join(root, "api");
  const svc = path.join(root, "fees");
  fs.mkdirSync(path.join(api, "src"), { recursive: true });
  fs.mkdirSync(path.join(svc, "cmd", "fees"), { recursive: true });
  fs.writeFileSync(path.join(api, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  fs.writeFileSync(path.join(api, "src", "main.ts"), "console.log('api');\n");
  fs.writeFileSync(path.join(svc, "go.mod"), "module example.com/fees\n");
  fs.writeFileSync(path.join(svc, "cmd", "fees", "main.go"), "package main\n\nfunc main() {}\n");

  const { markdown } = generateWorkspaceReport([api, svc]);
  assert.match(markdown, /Treat these 2 repositories as one product: api \(TypeScript\), fees \(Go\)\./);
  assert.doesNotMatch(markdown, /Next frontend plus Nest|Add MCP tooling around/);
  assert.match(markdown, /cmd\/fees\/main\.go/);
});
