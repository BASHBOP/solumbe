import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkRelease } from "../src/lib/release-check.js";

function fixture(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `release-${prefix}-`));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test("checkRelease passes when no version files changed", () => {
  const root = fixture("none", { "package.json": JSON.stringify({ version: "1.0.0" }) });
  const result = checkRelease(root, ["src/index.ts"]);
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /No version metadata changes/);
});

test("checkRelease fails on non-SemVer version", () => {
  const root = fixture("bad-semver", { "package.json": JSON.stringify({ version: "not-a-version" }) });
  const result = checkRelease(root, ["package.json"]);
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /non-SemVer/);
});

test("checkRelease fails when versions disagree across files", () => {
  const root = fixture("mismatch", {
    "package.json": JSON.stringify({ version: "1.0.0" }),
    "package-lock.json": JSON.stringify({ packages: { "": { version: "1.0.1" } } }),
  });
  const result = checkRelease(root, ["package.json", "package-lock.json"]);
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /do not agree/);
});

test("checkRelease fails when changelog not updated", () => {
  const root = fixture("no-changelog", { "package.json": JSON.stringify({ version: "1.0.0" }) });
  const result = checkRelease(root, ["package.json"]);
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog/);
});

test("checkRelease passes when version + changelog update together", () => {
  const root = fixture("ok", { "package.json": JSON.stringify({ version: "1.2.3" }) });
  const result = checkRelease(root, ["package.json", "CHANGELOG.md"]);
  assert.equal(result.status, "PASS");
  assert.ok(result.details?.some((line) => line.includes("1.2.3")));
});

test("checkRelease warns when a version file cannot be read", () => {
  const root = fixture("unreadable", {});
  const result = checkRelease(root, ["package.json"]);
  assert.equal(result.status, "WARN");
});

test("checkRelease downgrades missing changelog to WARN for a private package under solo governance", () => {
  const root = fixture("private-solo", { "package.json": JSON.stringify({ version: "1.0.0", private: true }) });
  const result = checkRelease(root, ["package.json"], { governance: "solo" });
  assert.equal(result.status, "WARN");
  assert.match(result.summary, /without a changelog update \(private package, solo governance\)/);
});

test("checkRelease keeps missing changelog FAIL for a private package under team governance", () => {
  const root = fixture("private-team", { "package.json": JSON.stringify({ version: "1.0.0", private: true }) });
  const result = checkRelease(root, ["package.json"], { governance: "team" });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog/);
});

test("checkRelease keeps missing changelog FAIL for a public package under solo governance", () => {
  const root = fixture("public-solo", { "package.json": JSON.stringify({ version: "1.0.0" }) });
  const result = checkRelease(root, ["package.json"], { governance: "solo" });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog/);
});

test("checkRelease keeps version-file mismatch FAIL even for a private package under solo governance", () => {
  const root = fixture("mismatch-private-solo", {
    "package.json": JSON.stringify({ version: "1.0.0", private: true }),
    "package-lock.json": JSON.stringify({ packages: { "": { version: "1.0.1" } } }),
  });
  const result = checkRelease(root, ["package.json", "package-lock.json"], { governance: "solo" });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /do not agree/);
});

test("checkRelease passes a dependency bump that leaves the project version unchanged", () => {
  const root = fixture("dep-bump", {
    "package.json": JSON.stringify({ version: "1.3.2", devDependencies: { eslint: "10.4.1" } }),
    "package-lock.json": JSON.stringify({ version: "1.3.2", packages: { "": { version: "1.3.2" } } }),
  });
  const baseContent = (file) => {
    if (file === "package.json") return JSON.stringify({ version: "1.3.2", devDependencies: { eslint: "10.4.0" } });
    if (file === "package-lock.json") return JSON.stringify({ version: "1.3.2", packages: { "": { version: "1.3.2" } } });
    return null;
  };
  const result = checkRelease(root, ["package.json", "package-lock.json"], { baseContent });
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /project version is unchanged/);
});

test("checkRelease still fails a real version bump with no changelog even with baseContent", () => {
  const root = fixture("real-bump", { "package.json": JSON.stringify({ version: "1.3.3" }) });
  const baseContent = (file) => (file === "package.json" ? JSON.stringify({ version: "1.3.2" }) : null);
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog/);
});

test("checkRelease fails when server.json MCP manifest drifts from package.json", () => {
  const root = fixture("server-mismatch", {
    "package.json": JSON.stringify({ version: "2.1.0" }),
    "server.json": JSON.stringify({ version: "2.0.0", packages: [{ version: "2.0.0" }] }),
    "CHANGELOG.md": "# Changelog\n\n## [2.1.0]\n",
  });
  const result = checkRelease(root, ["package.json", "server.json", "CHANGELOG.md"]);
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /do not agree/);
});

test("checkRelease passes when server.json MCP manifest matches package.json", () => {
  const root = fixture("server-ok", {
    "package.json": JSON.stringify({ version: "2.1.0" }),
    "server.json": JSON.stringify({ version: "2.1.0", packages: [{ version: "2.1.0" }] }),
    "CHANGELOG.md": "# Changelog\n\n## [2.1.0]\n",
  });
  const result = checkRelease(root, ["package.json", "server.json", "CHANGELOG.md"]);
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /changelog was updated/);
});

// --- Version-field gating: only a changed `version` is a release ---

const json = (value) => JSON.stringify(value);
const baseOf = (files) => (file) => (file in files ? files[file] : null);

test("checkRelease reads the version from the change under review, not the working tree", () => {
  // The checkout holds some unrelated later version; the change under review
  // only touched dependencies. Comparing the checkout to the base called that
  // a version bump and failed it.
  const root = fixture("stale-checkout", { "package.json": json({ version: "9.9.9" }) });
  const baseContent = baseOf({ "package.json": json({ version: "1.3.2", dependencies: { a: "1.0.0" } }) });
  const headContent = baseOf({ "package.json": json({ version: "1.3.2", dependencies: { a: "1.1.0" } }) });

  const stale = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(stale.status, "FAIL", "without the head content the stale checkout is what gets compared");

  const result = checkRelease(root, ["package.json"], { baseContent, headContent });
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /project version is unchanged/);
});

test("checkRelease falls back to the working tree when the head content is unavailable", () => {
  const root = fixture("head-missing", { "package.json": json({ version: "1.3.2", dependencies: { a: "1.1.0" } }) });
  const baseContent = baseOf({ "package.json": json({ version: "1.3.2" }) });
  const result = checkRelease(root, ["package.json"], { baseContent, headContent: () => null });
  assert.equal(result.status, "PASS");
});

test("checkRelease passes an edit to a package.json that has no version field", () => {
  const root = fixture("versionless", { "package.json": json({ name: "app", private: true, dependencies: { a: "2.0.0" } }) });
  const baseContent = baseOf({ "package.json": json({ name: "app", private: true, dependencies: { a: "1.0.0" } }) });
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "PASS");
  assert.match(result.summary, /project version is unchanged/);
});

test("checkRelease does not blame a dependency edit for a version mismatch it did not introduce", () => {
  const root = fixture("preexisting-mismatch", {
    "package.json": json({ version: "1.2.0", dependencies: { a: "2.0.0" } }),
    "package-lock.json": json({ packages: { "": { version: "1.1.0" } } }),
  });
  const baseContent = baseOf({
    "package.json": json({ version: "1.2.0", dependencies: { a: "1.0.0" } }),
    "package-lock.json": json({ packages: { "": { version: "1.1.0" } } }),
  });
  const result = checkRelease(root, ["package.json", "package-lock.json"], { baseContent });
  assert.equal(result.status, "PASS");
});

test("checkRelease still fails a mismatch the change introduces", () => {
  const root = fixture("introduced-mismatch", {
    "package.json": json({ version: "1.3.0" }),
    "package-lock.json": json({ packages: { "": { version: "1.2.0" } } }),
  });
  const baseContent = baseOf({
    "package.json": json({ version: "1.2.0" }),
    "package-lock.json": json({ packages: { "": { version: "1.2.0" } } }),
  });
  const result = checkRelease(root, ["package.json", "package-lock.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /do not agree/);
});

test("checkRelease fires when only server.json's version changes", () => {
  const root = fixture("server-only", {
    "server.json": json({ version: "1.1.0", packages: [{ version: "1.1.0" }] }),
  });
  const baseContent = baseOf({ "server.json": json({ version: "1.0.0", packages: [{ version: "1.0.0" }] }) });
  const result = checkRelease(root, ["server.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog/);
});

// --- Release Please: the manual bump is the finding ---

const RELEASE_PLEASE = { "release-please-config.json": json({ packages: { ".": {} } }) };

test("checkRelease flags a manual version bump in a Release Please repository, not a missing changelog", () => {
  const root = fixture("rp-manual", { "package.json": json({ version: "1.4.0" }) });
  const baseContent = baseOf({ ...RELEASE_PLEASE, "package.json": json({ version: "1.3.0" }) });
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /bumped by hand in a Release Please repository/);
  assert.doesNotMatch(result.summary, /changelog update/);
  assert.ok(result.details.includes("package.json: 1.3.0 -> 1.4.0"));
});

test("checkRelease flags a manual bump in a Release Please repository even with a changelog edit", () => {
  const root = fixture("rp-manual-changelog", { "package.json": json({ version: "1.4.0" }) });
  const baseContent = baseOf({ ...RELEASE_PLEASE, "package.json": json({ version: "1.3.0" }) });
  const result = checkRelease(root, ["package.json", "CHANGELOG.md"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /Release Please/);
});

test("checkRelease detects Release Please from the manifest as well as the config", () => {
  const root = fixture("rp-manifest", { "package.json": json({ version: "1.4.0" }) });
  const baseContent = baseOf({ ".release-please-manifest.json": json({ ".": "1.3.0" }), "package.json": json({ version: "1.3.0" }) });
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /Release Please/);
});

test("checkRelease passes the Release Please release PR, by branch or by manifest", () => {
  const root = fixture("rp-release", { "package.json": json({ version: "1.4.0" }) });
  const baseContent = baseOf({ ...RELEASE_PLEASE, "package.json": json({ version: "1.3.0" }) });

  const byBranch = checkRelease(root, ["package.json", "CHANGELOG.md"], { baseContent, headRefName: "release-please--branches--main" });
  assert.equal(byBranch.status, "PASS");
  assert.match(byBranch.summary, /Release Please release PR/);

  const byManifest = checkRelease(root, ["package.json", "CHANGELOG.md", ".release-please-manifest.json"], { baseContent });
  assert.equal(byManifest.status, "PASS");
});

test("checkRelease leaves a dependency edit alone in a Release Please repository", () => {
  const root = fixture("rp-dependency", { "package.json": json({ version: "1.3.0", dependencies: { a: "2.0.0" } }) });
  const baseContent = baseOf({ ...RELEASE_PLEASE, "package.json": json({ version: "1.3.0", dependencies: { a: "1.0.0" } }) });
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "PASS");
});

test("checkRelease downgrades a manual bump to WARN for a private package under solo governance", () => {
  const root = fixture("rp-private-solo", { "package.json": json({ version: "1.4.0", private: true }) });
  const baseContent = baseOf({ ...RELEASE_PLEASE, "package.json": json({ version: "1.3.0", private: true }) });
  const result = checkRelease(root, ["package.json"], { baseContent, governance: "solo" });
  assert.equal(result.status, "WARN");
  assert.match(result.summary, /Release Please/);
});

test("checkRelease keeps the changelog rule for repositories that do not use Release Please", () => {
  const root = fixture("no-rp", { "package.json": json({ version: "1.4.0" }) });
  const baseContent = baseOf({ "package.json": json({ version: "1.3.0" }) });
  const result = checkRelease(root, ["package.json"], { baseContent });
  assert.equal(result.status, "FAIL");
  assert.match(result.summary, /without a changelog update/);
});
