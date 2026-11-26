import crypto from "node:crypto";
import { classifyFile } from "./classify.js";
import { isSourceFilePath } from "./generate.js";

/**
 * The indexer's capability signature answers one question for the index cache:
 * "would today's indexer have produced a different set of file records than the
 * indexer that wrote this cache?" The `cacheVersion` counter alongside it only
 * answers that when somebody remembers to bump it, and PR #175 — which taught
 * `isSourceFilePath` to admit markdown — did not. Every repository indexed
 * before it kept serving a map with no `.md` entries, so a request naming a
 * README or a skill matched nothing and the `no evidence` fail-safe forced the
 * premium tier on a one-line typo fix.
 *
 * So the signature is *derived*, not declared: we run the real eligibility and
 * classification functions over a fixed corpus of representative paths and hash
 * the answers. Admitting a new extension, dropping one, or moving a path to a
 * different kind all move the signature on their own. `cacheVersion` stays as
 * the manual escape hatch for extraction changes this corpus cannot observe —
 * richer symbols for an already-indexed file kind, say.
 *
 * Keep the corpus append-only in spirit: it is a probe set, not a test fixture,
 * and adding a path invalidates every existing cache. That is conservative in
 * the safe direction (a needless rebuild, never a silently wrong map), but it
 * is not free, so add a path only to cover a capability the corpus cannot
 * already see.
 */
const capabilityProbePaths = Object.freeze([
  // Manifest and compiler metadata: deliberately not indexable.
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".hyperframes/video-state.json",
  // Code, one path per admitted extension.
  "src/index.ts",
  "src/App.tsx",
  "src/index.js",
  "src/App.jsx",
  "src/index.mjs",
  "src/index.cjs",
  "src/index.mts",
  "src/index.cts",
  "src/main.go",
  "src/Main.cs",
  "src/main.py",
  "src/Main.java",
  "src/main.rb",
  "src/main.rs",
  // Templates, translations, configuration snapshots.
  "src/views/event.hbs",
  "src/views/event.handlebars",
  "src/i18n/en.json",
  "config/feature-flags.json",
  "config/app.yaml",
  "config/app.yml",
  "feature-flags/.snapshot",
  // Tests and snapshots.
  "src/index.test.ts",
  "src/index.spec.tsx",
  "src/__snapshots__/index.snap",
  "internal/server/server_test.go",
  "tests/helpers.ts",
  // Markdown: the file class #175 added. `changelog`, `skill` and `doc` are
  // three distinct kinds, and the non-markdown doc extensions classify as
  // `doc` but are still not admitted — the corpus records that disagreement.
  "CHANGELOG.md",
  "README.md",
  "docs/guide.md",
  "docs/guide.mdx",
  "docs/guide.markdown",
  "docs/guide.rst",
  "docs/guide.adoc",
  "skills/model-router/SKILL.md",
  "skills/model-router/reference.md",
  "codex/skills/model-router/examples.md",
  // Framework and layered-application kinds.
  "app/api/users/route.ts",
  "app/dashboard/page.tsx",
  "app/dashboard/layout.tsx",
  "src/users/users.controller.ts",
  "src/users/users.service.ts",
  "src/users/users.module.ts",
  "src/users/users.dto.ts",
  "src/users/users.schema.ts",
  "src/hooks/useUser.ts",
  "src/redux/apis/users.ts",
  "src/lib/api-client.ts",
  // Never indexable: no extension, or an asset extension.
  "Makefile",
  "src/styles.css",
  "assets/logo.png",
]);

/**
 * The capability corpus with each path's observed treatment, in probe order.
 * Exposed for tests and for `doctor`-style diagnostics, so a signature mismatch
 * can be explained rather than just reported.
 * @returns {{ path: string, indexed: boolean, kind: string | null }[]}
 */
export function codeMapCapabilityProbes() {
  return capabilityProbePaths.map((probePath) => {
    const indexed = isSourceFilePath(probePath);
    return { path: probePath, indexed, kind: indexed ? classifyFile(probePath) : null };
  });
}

/**
 * A stable, short signature of what today's indexer will and will not index,
 * and under which kind. Two indexers agreeing on the whole probe corpus produce
 * the same signature; any disagreement produces a different one.
 * @returns {string}
 */
export function codeMapCapabilitySignature() {
  const digest = crypto
    .createHash("sha256")
    .update(
      codeMapCapabilityProbes()
        .map((probe) => `${probe.path}=${probe.indexed ? probe.kind : "-"}`)
        .join("\n"),
    )
    .digest("hex");
  // `cap1` tags the probe protocol itself, so a future change to how the
  // signature is computed cannot collide with a hash produced by this one.
  return `cap1:${digest.slice(0, 16)}`;
}
