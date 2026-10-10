import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCachedCodeMap, getCodeMapCachePath, resetIndexCacheMemo } from "../src/lib/index-cache.js";
import { codeMapCapabilitySignature } from "../src/lib/code-map/capabilities.js";

function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cached-repo" }));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;\n");
  return root;
}

const cachePathFor = (root) => getCodeMapCachePath(root);

test("getCachedCodeMap writes and reuses an index outside the inspected repository", () => {
  const root = makeRepo("solumbe-index-");

  const first = getCachedCodeMap(root);
  const second = getCachedCodeMap(root);

  assert.equal(first.cache.hit, false);
  assert.equal(second.cache.hit, true);
  assert.equal(second.repo.name, "cached-repo");
  assert.ok(fs.existsSync(cachePathFor(root)));
  assert.equal(first.cache.path, cachePathFor(root));
  assert.ok(!fs.existsSync(path.join(root, ".solumbe")), "mapping a repository must not create a working-tree artifact");
});

test("regenerates when a file changes (fingerprint staleness)", () => {
  const root = makeRepo("solumbe-index-stale-");

  const first = getCachedCodeMap(root);
  assert.equal(first.cache.hit, false);

  // Change file content (and length, so the fingerprint moves regardless of
  // mtime resolution). A new fingerprint means a new memo key, so this also
  // exercises the disk path rather than the in-process memo.
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;\nexport const extra = 42;\n");

  const second = getCachedCodeMap(root);
  assert.equal(second.cache.hit, false, "a changed file invalidates the cached index");
  assert.notEqual(first.cache.fingerprint, second.cache.fingerprint, "fingerprint reflects the file change");

  // Re-reading without changes is a hit again.
  const third = getCachedCodeMap(root);
  assert.equal(third.cache.hit, true);
});

test("regenerates (without throwing) when the cache file is corrupted JSON", () => {
  const root = makeRepo("solumbe-index-corrupt-");
  const cachePath = cachePathFor(root);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, "{ this is not: valid json ]]]");

  // Fresh process for this root -> no memo entry -> reads disk, sees garbage.
  let result;
  assert.doesNotThrow(() => {
    result = getCachedCodeMap(root);
  });
  assert.equal(result.cache.hit, false, "garbage JSON is treated as a miss and regenerated");
  assert.equal(result.repo.name, "cached-repo");

  // The corrupted file is replaced with a valid one.
  const onDisk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(onDisk.version, 12);
  assert.ok(onDisk.map);
});

test("a stale cacheVersion on disk is ignored on the first read of a repo", () => {
  const root = makeRepo("solumbe-index-version-fresh-");
  const cachePath = cachePathFor(root);

  // Write a structurally valid cache with an old version BEFORE any call for
  // this root, so there is no memo entry and the disk read is authoritative.
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ version: 1, generatedAt: "2020-01-01T00:00:00.000Z", fingerprint: "stale", map: { ok: true, poisoned: true } }, null, 2),
  );

  const result = getCachedCodeMap(root);
  assert.equal(result.cache.hit, false, "old cacheVersion is not trusted");
  assert.ok(!("poisoned" in result), "the stale map is not served");
  assert.equal(result.repo.name, "cached-repo");
});

test("writes the cache atomically and leaves no temp files behind", () => {
  const root = makeRepo("solumbe-index-atomic-");
  const result = getCachedCodeMap(root);
  assert.equal(result.cache.hit, false);

  const dir = path.dirname(cachePathFor(root));
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ["index.json"], "only the final index.json remains; no partial/temp file is visible");

  // The single file present is complete, valid JSON (never a half-written index).
  const parsed = JSON.parse(fs.readFileSync(cachePathFor(root), "utf8"));
  assert.equal(parsed.version, 12);
  assert.ok(parsed.map.ok);
});

test("write failures do not throw and the call still returns a map", () => {
  const root = makeRepo("solumbe-index-writefail-");
  // Make the external cache directory a file so mkdir/write underneath fails.
  fs.mkdirSync(path.dirname(path.dirname(cachePathFor(root))), { recursive: true });
  fs.writeFileSync(path.dirname(cachePathFor(root)), "not a directory");

  let result;
  assert.doesNotThrow(() => {
    result = getCachedCodeMap(root);
  });
  assert.equal(result.cache.hit, false);
  assert.equal(result.repo.name, "cached-repo", "a failed cache write still returns a freshly generated map");
  assert.ok(!fs.existsSync(path.join(root, ".solumbe")), "a failed cache write must not fall back to the repository");
});

test("repeated calls are served from the in-process memo without re-reading disk", () => {
  const root = makeRepo("solumbe-index-memo-");

  const first = getCachedCodeMap(root);
  assert.equal(first.cache.hit, false);
  assert.equal(first.cache.source, "generated");

  // Delete the on-disk cache entirely. If the second call still returns a hit,
  // it can only have come from the in-process memo (disk would be a miss).
  fs.rmSync(cachePathFor(root), { force: true });
  assert.ok(!fs.existsSync(cachePathFor(root)), "disk cache removed");

  const second = getCachedCodeMap(root);
  assert.equal(second.cache.hit, true, "served despite no disk cache");
  assert.equal(second.cache.source, "memo", "the hit came from the in-process memo");
  // The memo did not rewrite the disk file (it short-circuits before writeCache).
  assert.ok(!fs.existsSync(cachePathFor(root)), "memo hit does not touch disk");
});

test("memo returns equivalent repo data across calls", () => {
  const root = makeRepo("solumbe-index-memo-eq-");
  const first = getCachedCodeMap(root);
  const second = getCachedCodeMap(root);
  assert.equal(second.cache.source, "memo");
  assert.equal(first.repo.name, second.repo.name);
  assert.deepEqual(first.summary, second.summary, "memoized summary is identical");
  assert.deepEqual(first.files, second.files, "memoized files are identical");
});

// Poison the on-disk index for `root` while keeping every other acceptance
// check satisfied — current version, the repository's real (unchanged)
// fingerprint, the right root. Only the capability signature differs, so a
// miss here can have no other cause.
function poisonIndexWithCapabilities(root, capabilities) {
  const fresh = getCachedCodeMap(root);
  const record = {
    version: 12,
    generatedAt: "2026-09-07T04:38:45.098Z",
    fingerprint: fresh.cache.fingerprint,
    map: { ok: true, repo: { root }, poisoned: true },
  };
  if (capabilities !== undefined) record.capabilities = capabilities;
  fs.writeFileSync(cachePathFor(root), JSON.stringify(record, null, 2));
  resetIndexCacheMemo();
  return fresh;
}

test("an index written by an indexer with different capabilities is rebuilt", () => {
  const root = makeRepo("solumbe-index-capability-");
  poisonIndexWithCapabilities(root, "cap1:0000000000000000");

  const result = getCachedCodeMap(root);
  assert.equal(result.cache.hit, false, "a foreign capability signature is not trusted");
  assert.ok(!("poisoned" in result), "the stale map is not served");
  assert.equal(result.repo.name, "cached-repo");
  assert.equal(result.cache.capabilities, codeMapCapabilitySignature(), "the served map reports today's capabilities");
});

test("an index written before capabilities were recorded is rebuilt", () => {
  const root = makeRepo("solumbe-index-capability-absent-");
  // Exactly what every index written before this field existed looks like:
  // right version, right fingerprint, no capability signature at all.
  poisonIndexWithCapabilities(root, undefined);

  const result = getCachedCodeMap(root);
  assert.equal(result.cache.hit, false, "a cache with no capability signature is not trusted");
  assert.ok(!("poisoned" in result), "the stale map is not served");
  assert.equal(result.repo.name, "cached-repo");
});

test("a matching capability signature is still a hit", () => {
  // The guard must reject stale indexers without rejecting good ones: the
  // same repository under the same indexer stays a disk hit across processes.
  const root = makeRepo("solumbe-index-capability-match-");
  const first = getCachedCodeMap(root);
  assert.equal(first.cache.hit, false);

  resetIndexCacheMemo();
  const second = getCachedCodeMap(root);
  assert.equal(second.cache.hit, true, "an unchanged repo and indexer is served from disk");
  assert.equal(second.cache.source, "disk");
});

test("the written index records the capability signature", () => {
  const root = makeRepo("solumbe-index-capability-write-");
  const result = getCachedCodeMap(root);
  assert.equal(result.cache.hit, false);
  assert.equal(result.cache.capabilities, codeMapCapabilitySignature());

  const onDisk = JSON.parse(fs.readFileSync(cachePathFor(root), "utf8"));
  assert.equal(onDisk.capabilities, codeMapCapabilitySignature(), "the signature is persisted for the next process to check");
});

// The regression this mechanism exists for. PR #175 taught the indexer to
// admit markdown but did not bump cacheVersion, so an untouched repository —
// identical fingerprint, current version — kept serving a map with no .md
// records. Every README/skill/doc request then matched nothing, the `no
// evidence` fail-safe fired, and a one-line typo fix routed to premium.
test("a pre-markdown index is rebuilt even though version and fingerprint still match", () => {
  const root = makeRepo("solumbe-index-premarkdown-");
  fs.writeFileSync(path.join(root, "README.md"), "# cached-repo\n\nA README with a typo.\n");

  const fresh = getCachedCodeMap(root);
  assert.ok(
    fresh.files.some((file) => file.path === "README.md"),
    "today's indexer records markdown",
  );

  // Rewrite the index exactly as the older indexer would have left it: same
  // version, same (still-valid) fingerprint, markdown records absent, and the
  // capability signature of an indexer that did not admit markdown.
  const cachePath = cachePathFor(root);
  fs.writeFileSync(
    cachePath,
    JSON.stringify(
      {
        version: 12,
        generatedAt: "2026-09-07T04:38:45.098Z",
        fingerprint: fresh.cache.fingerprint,
        capabilities: "cap1:premarkdownindexer",
        map: { ...fresh, cache: undefined, files: fresh.files.filter((file) => !file.path.endsWith(".md")) },
      },
      null,
      2,
    ),
  );
  resetIndexCacheMemo();

  const served = getCachedCodeMap(root);
  assert.equal(served.cache.hit, false, "the pre-markdown index is treated as stale");
  assert.ok(
    served.files.some((file) => file.path === "README.md"),
    "the rebuilt index contains the markdown the old indexer could not see",
  );
});

// Without the capability check, the same setup is served verbatim — this pins
// the failure mode so a future refactor cannot quietly reintroduce it.
test("fingerprint alone cannot detect an indexer change", () => {
  const root = makeRepo("solumbe-index-fingerprint-blind-");
  fs.writeFileSync(path.join(root, "README.md"), "# cached-repo\n");

  const first = getCachedCodeMap(root);
  resetIndexCacheMemo();
  const second = getCachedCodeMap(root);

  assert.equal(second.cache.hit, true, "an untouched repository is a hit");
  assert.equal(first.cache.fingerprint, second.cache.fingerprint, "the fingerprint is blind to everything but the files themselves");
});
