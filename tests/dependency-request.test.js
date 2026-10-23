import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateContextPack } from "../src/lib/context-engine.js";
import { generateConvergence } from "../src/lib/converge.js";
import { readDependencyRequest, summarizeDependencyFiles } from "../src/lib/dependency-request.js";
import { generateImpact } from "../src/lib/impact.js";

const fixtures = path.join(import.meta.dirname, "..", "evals", "fixtures");

// Dogfood misses from a dependency security sweep (2026-10-22). Each fixture
// has the shape of the repository the miss was found in.
const API_REQUEST =
  "upgrade vulnerable yarn dependencies (handlebars, tar, proxy-addr, shell-quote, basic-ftp, websocket-driver and high advisories) to patched versions";
const WEB_REQUEST = "upgrade vulnerable yarn dependencies (jspdf, swiper, tar and high advisories) to patched versions in package.json and yarn.lock";
const MOBILE_REQUEST = "upgrade vulnerable npm dependencies (shell-quote and high advisories)";

/** A committed copy of a fixture, so the index and a diff see a real repository. */
function gitCopy(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dependency-${name}-`));
  fs.cpSync(path.join(fixtures, name), root, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@t"],
    ["config", "user.name", "T"],
    ["add", "."],
    ["commit", "-q", "-m", "init"],
  ]) {
    spawnSync("git", args, { cwd: root });
  }
  return root;
}

test("a yarn advisory sweep owns the lockfile, and shell-quote and handlebars rank no source", () => {
  const root = gitCopy("dependency-advisory-api");
  const { data } = generateImpact(API_REQUEST, { path: root });
  const roles = data.classifications;
  assert.deepEqual(roles.requiredOwners, ["yarn.lock"]);
  // Every named package is transitive, so the manifest may change (a
  // resolution) but is not owed. The package-manager config is listed.
  assert.ok(roles.supportingFiles.includes("package.json"), roles.supportingFiles.join(", "));
  assert.ok(roles.supportingFiles.includes(".yarnrc.yml"), roles.supportingFiles.join(", "));
  const listed = data.topFiles.map((/** @type {any} */ file) => file.path);
  assert.ok(!listed.some((file) => file.startsWith("src/quote-templates/")), `shell-quote matched quote-templates: ${listed.join(", ")}`);
  assert.ok(!listed.some((file) => file.endsWith(".hbs")), `handlebars matched the email templates: ${listed.join(", ")}`);
  assert.equal(data.topFiles[0].path, "yarn.lock");
  assert.equal(new Set(listed).size, listed.length, `a file is listed twice: ${listed.join(", ")}`);
  assert.ok(data.concepts.includes("dependency"));
});

test("a request naming package.json and yarn.lock owns both, and 'package' and 'upgrade' rank no component", () => {
  const root = gitCopy("dependency-advisory-web");
  const { data } = generateImpact(WEB_REQUEST, { path: root });
  assert.deepEqual(data.classifications.requiredOwners, ["package.json", "yarn.lock"]);
  assert.ok(data.classifications.supportingFiles.includes(".yarnrc.yml"));
  const listed = data.topFiles.map((/** @type {any} */ file) => file.path);
  assert.ok(!listed.some((file) => file.endsWith(".tsx")), `a component ranked on 'package' or 'upgrade': ${listed.join(", ")}`);
});

test("an npm advisory on a transitive package grounds in package-lock.json and converges", () => {
  const root = gitCopy("dependency-advisory-mobile");
  const { data } = generateImpact(MOBILE_REQUEST, { path: root });
  assert.deepEqual(data.classifications.requiredOwners, ["package-lock.json"]);
  assert.ok(data.classifications.supportingFiles.includes("package.json"));
  assert.ok(!data.topFiles.some((/** @type {any} */ file) => file.path.startsWith("src/")));

  const lockfile = path.join(root, "package-lock.json");
  fs.writeFileSync(
    lockfile,
    fs.readFileSync(lockfile, "utf8").replace('"node_modules/shell-quote": { "version": "1.8.1" }', '"node_modules/shell-quote": { "version": "1.8.3" }'),
  );
  const convergence = generateConvergence(MOBILE_REQUEST, { path: root, base: "HEAD" });
  assert.notEqual(convergence.band, "inconclusive", JSON.stringify(convergence.drivers ?? {}));
  assert.equal(convergence.convergence, 100);
  assert.deepEqual(convergence.drivers.confirmedDirect, ["package-lock.json"]);

  // A commit is scored from its own tree, whose manifests are read there too.
  spawnSync("git", ["commit", "-q", "-am", "bump shell-quote"], { cwd: root });
  const committed = generateConvergence(MOBILE_REQUEST, { path: root, base: "HEAD~1", head: "HEAD" });
  assert.equal(committed.convergence, 100);
  assert.deepEqual(committed.drivers.confirmedDirect, ["package-lock.json"]);
});

test("a context pack over several repositories leads with each one's manifests and lockfiles", () => {
  const paths = ["dependency-advisory-api", "dependency-advisory-web", "dependency-advisory-mobile"].map(gitCopy);
  const { data } = generateContextPack(
    "upgrade vulnerable dependencies (shell-quote, handlebars, jspdf, swiper, tar and high advisories) to patched versions",
    {
      paths,
      limit: 8,
    },
  );
  const primary = data.primaryFiles.map((/** @type {any} */ file) => `${path.basename(file.repo.root)}:${file.path}`);
  const dependencyFiles = /(^|:)(package\.json|yarn\.lock|package-lock\.json|\.yarnrc\.yml)$/;
  assert.ok(
    primary.every((file) => dependencyFiles.test(file)),
    `expected only manifests and lockfiles, got ${primary.join(", ")}`,
  );
  for (const [index, lockfile] of /** @type {const} */ ([
    [0, "yarn.lock"],
    [1, "yarn.lock"],
    [2, "package-lock.json"],
  ])) {
    assert.ok(primary.includes(`${path.basename(paths[index])}:${lockfile}`), `missing ${lockfile} of ${paths[index]}: ${primary.join(", ")}`);
  }
  assert.equal(data.intent.action, "upgrade");
});

test("package names are read whole: scoped, hyphenated and versioned names never become scoring words", () => {
  const dependencies = [{ path: "package.json", role: /** @type {const} */ ("manifest"), ecosystem: "node", packages: ["@stream-io/node-sdk", "lint-staged"] }];
  const request = readDependencyRequest("upgrade @stream-io/node-sdk to 0.8 and pass recording_type to startRecording", dependencies);
  assert.deepEqual(request?.packages, ["@stream-io/node-sdk"]);
  assert.equal(request?.scoringQuery, "pass recording_type startRecording");
  assert.deepEqual(request?.required, ["package.json"]);

  assert.deepEqual(readDependencyRequest("bump lint-staged to 17", dependencies)?.packages, ["lint-staged"]);
  assert.deepEqual(readDependencyRequest("yarn up tar@7.5.2 and shell-quote", dependencies)?.packages, ["tar", "shell-quote"]);
});

test("pricing and release wording is not a dependency request", () => {
  const dependencies = [{ path: "package.json", role: /** @type {const} */ ("manifest"), ecosystem: "node", packages: ["react"] }];
  assert.equal(readDependencyRequest("upgrade the organiser to the pro package", dependencies), undefined);
  assert.equal(readDependencyRequest("bump the version for the release", dependencies), undefined);
  assert.equal(readDependencyRequest("update the audit log for refunds", dependencies), undefined);
  assert.ok(readDependencyRequest("npm audit fix", dependencies));
  assert.equal(readDependencyRequest("fix the vulnerability in the login form", dependencies), undefined, "a vulnerability in code is source work");
  assert.equal(readDependencyRequest("patch the XSS vulnerability in the comment form", dependencies), undefined);
  assert.equal(readDependencyRequest("update the model routing documentation to explain the advisory footer", dependencies), undefined);
  assert.equal(readDependencyRequest("upgrade the react onboarding flow", dependencies), undefined, "a declared word with no version names a feature");
  assert.ok(readDependencyRequest("patch CVE-2025-1234", dependencies));
  assert.ok(readDependencyRequest("upgrade react to 19.1", dependencies));
});

test("the package manager the request names picks its lockfile, and a workspace keeps the root lockfile", () => {
  const files = summarizeDependencyFiles(
    ["package.json", "yarn.lock", "package-lock.json", ".npmrc", "packages/app/package.json", "evals/fixtures/demo/package.json"],
    (file) =>
      file === "packages/app/package.json"
        ? JSON.stringify({ dependencies: { swiper: "^11.0.0" } })
        : file === "package.json"
          ? JSON.stringify({ dependencies: {} })
          : "",
  );
  assert.deepEqual(readDependencyRequest("upgrade yarn dependencies", files)?.required, ["package.json", "yarn.lock"]);
  const npm = readDependencyRequest("upgrade npm dependencies", files);
  assert.deepEqual(npm?.required, ["package-lock.json", "package.json"]);
  assert.deepEqual(npm?.supporting, [".npmrc"]);
  // The package a workspace declares: that manifest, and the root lockfiles.
  assert.deepEqual(readDependencyRequest("upgrade yarn dependency swiper", files)?.required, ["packages/app/package.json", "yarn.lock"]);
});

test("lockfiles list transitive packages for every common format", () => {
  const texts = /** @type {Record<string, string>} */ ({
    "yarn.lock": '"@scope/a@npm:^1.0.0", "@scope/a@npm:^1.1.0":\n  version: 1.1.0\n\nb@^2.0.0:\n  version "2.0.0"\n',
    "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/c": {}, "node_modules/c/node_modules/@d/e": {} } }),
    "pnpm-lock.yaml": "packages:\n\n  /f@1.0.0:\n    resolution: {}\n  '@g/h@2.0.0':\n    resolution: {}\n",
    "Cargo.lock": '[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    "go.sum": "golang.org/x/net v0.1.0 h1:abc=\n",
  });
  const files = summarizeDependencyFiles(Object.keys(texts), (file) => texts[file]);
  const packages = Object.fromEntries(files.map((file) => [file.path, file.packages]));
  assert.deepEqual(packages["yarn.lock"], ["@scope/a", "b"]);
  assert.deepEqual(packages["package-lock.json"], ["@d/e", "c"]);
  assert.deepEqual(packages["pnpm-lock.yaml"], ["@g/h", "f"]);
  assert.deepEqual(packages["Cargo.lock"], ["serde"]);
  assert.deepEqual(packages["go.sum"], ["golang.org/x/net"]);
});
