import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_REQUESTS, buildSolumbeArgs, parseInvocationContext, requestFromContext } from "../integrations/herdr/runtime.mjs";
import { formatActionBar, formatTrustError, formatTrustSummary } from "../integrations/herdr/trust-pane.mjs";

const manifestPath = fileURLToPath(new URL("../integrations/herdr/herdr-plugin.toml", import.meta.url));

test("Herdr manifest exposes the bounded Solumbe trust workflow", () => {
  const manifest = readFileSync(manifestPath, "utf8");
  assert.match(manifest, /id = "bashbop\.solumbe"/);
  assert.match(manifest, /min_herdr_version = "0\.8\.2"/);
  for (const action of ["doctor", "context", "impact", "review", "gate-staged", "model-route"]) {
    assert.match(manifest, new RegExp(`id = "${action}"`));
  }
  assert.match(manifest, /id = "trust-status"/);
  assert.doesNotMatch(manifest, /command = \[[^\n]*(merge|push|commit)/);
});

test("invocation context is defensive and selected text becomes the request", () => {
  assert.deepEqual(parseInvocationContext("not-json"), {});
  const context = parseInvocationContext(JSON.stringify({ selected_text: "Add a safe Herdr integration" }));
  assert.equal(requestFromContext("impact", context), "Add a safe Herdr integration");
  assert.equal(requestFromContext("review", {}), DEFAULT_REQUESTS.review);
});

test("staged gate arguments bind request, base, validation, and staged tree", () => {
  const args = buildSolumbeArgs("gate-staged", {
    repo: "/tmp/repo",
    request: "ship the plugin",
    base: "origin/main",
  });
  assert.deepEqual(args, ["gate", "/tmp/repo", "--staged", "--run-validation", "--request", "ship the plugin", "--base", "origin/main"]);
});

test("model-route arguments call solumbe ax as JSON", () => {
  const args = buildSolumbeArgs("model-route", {
    repo: "/tmp/repo",
    request: "fix a typo in README",
  });
  assert.deepEqual(args, ["ax", "fix a typo in README", "--path", "/tmp/repo", "--json"]);
});

test("routeModelTier maps AX bands and risk bumps", async () => {
  const { routeModelTier, formatModelRoute } = await import("../integrations/herdr/runtime.mjs");
  assert.equal(routeModelTier(80), "cheap");
  assert.equal(routeModelTier(60), "mid");
  assert.equal(routeModelTier(30), "premium");
  assert.equal(routeModelTier(80, { containment: 10 }), "mid");
  assert.equal(routeModelTier(60, { riskBump: true }), "premium");
  assert.match(formatModelRoute("cheap", { ax: 88, request: "high AX" }), /Model route: cheap/);
});

test("trust status keeps hosted and human authority explicit", () => {
  const output = formatTrustSummary(
    {
      verdict: "WARN",
      confidence: 70,
      prReviewSummary: {
        changedFiles: 2,
        additions: 12,
        deletions: 3,
        riskLevel: "medium",
      },
      pass: {
        checks: [
          {
            status: "WARN",
            name: "Review state",
            summary: "Hosted review is not available locally.",
          },
        ],
      },
    },
    "/tmp/repo",
    "origin/main",
  );
  assert.match(output, /WARN · confidence 70%/);
  assert.match(output, /Hosted review is not available locally/);
  assert.match(output, /does not replace hosted CI/);
  assert.match(output, /human merge decision/);
});

test("trust status presents an accessible terminal hierarchy with optional brand colour", () => {
  const report = {
    verdict: "PASS",
    confidence: 96,
    prReviewSummary: {
      changedFiles: 1,
      additions: 8,
      deletions: 2,
      riskLevel: "low",
    },
    pass: { checks: [] },
  };

  const plain = formatTrustSummary(report, "/tmp/repo", "origin/main", { color: false, width: 72 });
  assert.match(plain, /OVERVIEW/);
  assert.match(plain, /MERGE SIGNAL/);
  assert.match(plain, /PASS.*confidence 96%/);
  assert.match(plain, /1 changed file/);
  assert.match(plain, /LOW RISK/);
  assert.match(plain, /┌─+┬─+┐/);
  assert.match(plain, /REPOSITORY.*│ \/tmp\/repo/);
  assert.equal(plain.includes("\u001b["), false);

  const colored = formatTrustSummary(report, "/tmp/repo", "origin/main", { color: true, width: 72 });
  assert.equal(colored.includes("\u001b[48;2;255;255;1m"), true);
  assert.equal(colored.includes("\u001b[48;2;34;197;94m"), true);
  assert.match(colored, /PASS/);

  const actions = formatActionBar({ color: false });
  assert.match(actions, /r.*Refresh.*c.*Context.*i.*Impact/);
  assert.match(actions, /g.*Validate staged.*q.*Close/);

  const error = formatTrustError(new Error("Repository not found"), { color: false, width: 72 });
  assert.match(error, /REVIEW UNAVAILABLE/);
  assert.match(error, /Repository not found/);
});

test("trust status lists a SKIPPED check as not checked here, not as needing attention", () => {
  const output = formatTrustSummary(
    {
      verdict: "PASS",
      confidence: 85,
      prReviewSummary: { changedFiles: 1, additions: 2, deletions: 1, riskLevel: "low" },
      pass: {
        checks: [
          { status: "SKIPPED", name: "Review state", summary: "Not checked locally: reviews are verified once a PR exists." },
          { status: "WARN", name: "Dependency audit", summary: "No lockfile." },
        ],
      },
    },
    "/tmp/repo",
    "origin/main",
  );
  assert.match(output, /NEEDS ATTENTION · 1/);
  assert.match(output, /NOT CHECKED HERE · 1/);
  const attention = output.slice(output.indexOf("NEEDS ATTENTION"), output.indexOf("NOT CHECKED HERE"));
  assert.match(attention, /Dependency audit/);
  assert.doesNotMatch(attention, /Review state/);
  assert.match(output.slice(output.indexOf("NOT CHECKED HERE")), /Review state/);

  const clean = formatTrustSummary(
    {
      verdict: "PASS",
      confidence: 90,
      prReviewSummary: { changedFiles: 1, additions: 2, deletions: 1, riskLevel: "low" },
      pass: { checks: [{ status: "SKIPPED", name: "Review state", summary: "Not checked locally." }] },
    },
    "/tmp/repo",
    "origin/main",
  );
  assert.doesNotMatch(clean, /NEEDS ATTENTION/);
});
