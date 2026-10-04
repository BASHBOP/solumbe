#!/usr/bin/env node
// Regenerate tests/fixtures/formatters-golden.json: every terminal formatter's
// output, in each renderer mode, for data built from the eval fixtures.
//
//   node tests/golden/generate-formatters.mjs
//
// Run it only when a formatter's output is meant to change, and review the
// fixture diff in the same PR. The data is stored beside the output, so the
// test re-renders the very same input; regenerating on another machine can
// shift the token estimates (they count the pre-normalised JSON) and nothing else.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverRepositories, indexRepositories, listCatalog, searchCatalog } from "../../src/lib/catalog.js";
import { generateContextPack } from "../../src/lib/context-engine.js";
import { generateImpact } from "../../src/lib/impact.js";
import { initProject } from "../../src/lib/init.js";
import { getInstallPlan } from "../../src/lib/install.js";
import { generateRoute } from "../../src/lib/model-route.js";
import { evaluateLocal } from "../../src/lib/pass-local.js";
import { generateReport } from "../../src/lib/report.js";
import { generateReview } from "../../src/lib/review.js";
import { MODES, render } from "./formatters.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const fixturesRoot = path.join(repoRoot, "evals", "fixtures");
const target = path.join(repoRoot, "tests", "fixtures", "formatters-golden.json");
const FIXED_DATE = "2000-01-01T00:00:00Z";
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TASK = "add Stripe refunds to the payment webhook";

// A fixed workspace path keeps the index-cache key, and so the data, stable.
const WORK = path.join(os.tmpdir(), "solumbe-formatters-golden");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "home"), { recursive: true });

const skip = (name) => name === ".git" || name === "node_modules" || name === ".solumbe";
function copyContents(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip(ent.name)) continue;
    fs.cpSync(path.join(source, ent.name), path.join(destination, ent.name), { recursive: true });
  }
}
function copyFixture(name) {
  const destination = path.join(WORK, "fixtures", name);
  copyContents(path.join(fixturesRoot, name), destination);
  return destination;
}

const gitEnv = {
  ...process.env,
  HOME: path.join(WORK, "home"),
  GIT_CONFIG_GLOBAL: path.join(WORK, "home", ".gitconfig"),
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
};
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
}

// gate-node/base plus one change set, committed on top, the way the gate
// effectiveness eval builds its cases (minus the allow-secret markers).
// `files` join the baseline, so they are not part of the change.
function gateRepo(changeSet, { name = `gate-node-${changeSet}`, files = {} } = {}) {
  const dir = path.join(WORK, "git", name);
  const source = path.join(fixturesRoot, "gate-node");
  copyContents(path.join(source, "base"), dir);
  for (const [relative, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, relative), content);
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "golden@solumbe.local"]);
  git(dir, ["config", "user.name", "solumbe golden"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "-m", "baseline"]);
  copyContents(path.join(source, "changes", changeSet), dir);
  stripAllowMarkers(dir);
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "--quiet", "-m", `change: ${changeSet}`]);
  return dir;
}
function stripAllowMarkers(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      stripAllowMarkers(full);
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    if (!text.includes("solumbe:allow-secret")) continue;
    fs.writeFileSync(
      full,
      text
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "// solumbe:allow-secret")
        .map((line) => line.replace(/\s*(?:\/\/|#)\s*solumbe:allow-secret\s*$/, ""))
        .join("\n"),
    );
  }
}

const shopApi = copyFixture("shop-api");
const sampleApi = copyFixture("sample-api");
const initTarget = copyFixture("harness-node");
const gateWarn = gateRepo("scope-drift");
const gateFail = gateRepo("secret-content");
// A repository whose .solumberc.json names shop-api as its companion, for the
// companion repository leads in impact and review.
const gateCompanion = gateRepo("scope-drift", {
  name: "gate-node-companion",
  files: { ".solumberc.json": JSON.stringify({ companions: ["../../fixtures/shop-api"] }) },
});
const catalog = path.join(WORK, "home", "catalog.json");

// ---------------------------------------------------------------------------
// Normalisation: machine paths and clocks never reach the fixture.

const realpath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const replacements = [];
for (const [value, token] of [
  [WORK, "<work>"],
  [repoRoot, "<root>"],
  [os.tmpdir(), "<tmpdir>"],
  [os.homedir(), "<home>"],
]) {
  for (const variant of new Set([realpath(value), value])) replacements.push([variant, token]);
}
replacements.sort((a, b) => b[0].length - a[0].length);

function normaliseString(text) {
  let out = text;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})/g, FIXED_TIMESTAMP)
    .replace(/\b\d+:\d+:\d{10,}:[0-9a-f]{6,}\b/g, "1:1:1:00000000");
}
function normalise(value) {
  if (typeof value === "string") return normaliseString(value);
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "cacheHit" || key === "hit") out[key] = true;
      else if (key === "source" && (entry === "generated" || entry === "cache")) out[key] = "cache";
      else out[key] = normalise(entry);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Hand-made data for the formatters that need GitHub or the machine.

const doctorTools = [
  { name: "node", command: "node", available: true, path: "/usr/local/bin/node", version: "v22.12.0", installHint: "Install Node.js 18+." },
  { name: "git", command: "git", available: true, path: "/usr/bin/git", version: "git version 2.39.1", installHint: "Install git." },
  {
    name: "gh",
    command: "gh",
    available: false,
    path: undefined,
    version: undefined,
    installHint: "Install the GitHub CLI (https://cli.github.com); required by pr_merge_readiness and gh-enriched pr_review.",
  },
  {
    name: "rg",
    command: "rg",
    available: true,
    path: "/opt/homebrew/bin/rg",
    version: "ripgrep 14.1.1",
    installHint: "Install ripgrep for faster source searching.",
  },
  {
    name: "npx",
    command: "npx",
    available: true,
    path: "/usr/local/bin/npx",
    version: "10.9.0",
    installHint: "Install npm/npx, or install optional tools globally.",
  },
  { name: "opensrc", command: "opensrc", available: false, path: undefined, version: undefined, installHint: "Install with: npm install -g opensrc" },
  {
    name: "code-structure",
    command: "code-structure",
    available: true,
    path: "/usr/local/bin/code-structure",
    version: "Version: 2.3.0",
    installHint: "Install with: npm install -g code-structure for faster runs; structure can fall back to npx.",
  },
];

const passPrChecks = (overrides) => [
  { name: "PR state", status: "PASS", summary: "Open and mergeable." },
  { name: "PR snapshot", status: "PASS", summary: "Base and head commits are pinned." },
  { name: "Changed files", status: "PASS", summary: "2 changed files found.", details: ["src/payment/refund.service.ts", "src/payment/stripe.webhook.ts"] },
  { name: "Secret safety", status: "PASS", summary: "No secret file paths and no credential values found in the changed content." },
  { name: "Risk review", status: "WARN", summary: "Risk-sensitive paths changed.", details: ["src/payment/stripe.webhook.ts (money flow)"] },
  { name: "Release discipline", status: "PASS", summary: "No version metadata changes found." },
  { name: "Review decision", status: "WARN", summary: "No approving review yet." },
  { name: "CODEOWNERS", status: "PASS", summary: "No CODEOWNERS file; nothing to enforce." },
  { name: "Unresolved conversations", status: "PASS", summary: "No unresolved review threads." },
  { name: "Branch protection", status: "WARN", summary: "Branch protection could not be read (404); the gate cannot confirm required checks." },
  { name: "Status checks", status: "PASS", summary: "All 3 checks passed." },
  { name: "Policy profile", status: "PASS", summary: "Standard policy profile active." },
  ...(overrides ?? []),
];

const passPrOpen = {
  ok: true,
  generatedAt: FIXED_TIMESTAMP,
  passPrEngineVersion: 2,
  verdict: "WARN",
  repo: { root: "<work>/git/shop-api", name: "shop-api" },
  base: "GitHub PR",
  pr: {
    number: 42,
    title: "Add Stripe refunds to the payment webhook",
    url: "https://github.com/example/shop-api/pull/42",
    baseRefName: "main",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    headSha: "89abcdef0123456789abcdef0123456789abcdef",
    state: "OPEN",
    mergedAt: "",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "",
  },
  policy: "standard",
  governance: "team",
  request: "",
  contextEvidence: ['solumbe impact . "review this change" --json', "solumbe pr . --number 42 --out .solumbe/pr-review.md"],
  changedFiles: ["src/payment/refund.service.ts", "src/payment/stripe.webhook.ts"],
  checks: passPrChecks(),
};

const passPrMerged = {
  ...passPrOpen,
  verdict: "FAIL",
  pr: { ...passPrOpen.pr, number: 43, title: "Rotate the webhook signing secret", state: "MERGED", mergedAt: FIXED_TIMESTAMP, reviewDecision: "APPROVED" },
  checks: passPrChecks().map((check) =>
    check.name === "Secret safety"
      ? {
          ...check,
          status: "FAIL",
          summary: "A credential value was found in the changed content.",
          details: ["src/payment/stripe.webhook.ts:12 looks like a Stripe secret key"],
        }
      : check,
  ),
};

const summary = {
  title: "solumbe repo · repository overview",
  glyph: "📦",
  subtitle: "<work>/fixtures/shop-api",
  facts: [
    ["Files scanned", 4],
    ["Primary languages", "TypeScript (4), JSON (1)"],
    ["Package managers", "npm"],
    ["Entrypoints", "none detected"],
  ],
  sections: [
    { title: "Scripts", items: ["test: node --test", "lint: eslint ."], glyph: "⚙️" },
    { title: "Important directories", items: ["src/payment", "src/orders"], glyph: "📁" },
    { title: "Empty section", items: [], glyph: "📭" },
  ],
};

// ---------------------------------------------------------------------------
// Build every case, then render it under every mode.

const cases = [];
async function add(name, formatter, build) {
  const data = normalise(await build());
  const outputs = {};
  for (const [mode, options] of Object.entries(MODES)) outputs[mode] = render(formatter, data, options);
  cases.push({ name, formatter, data, outputs });
  process.stderr.write(`${name}\n`);
}

await add("context", "context", () => generateContextPack(TASK, { path: shopApi }).data);
await add("impact", "impact", () => generateImpact(TASK, { path: shopApi }).data);
await add("impact-companions", "impact", () => generateImpact(TASK, { path: gateCompanion, companions: true }).data);
await add("pass-warn", "pass", () => evaluateLocal(gateWarn, { base: "HEAD~1", policy: "standard", governance: "team" }));
await add("pass-fail", "pass", () => evaluateLocal(gateFail, { base: "HEAD~1", policy: "standard", governance: "team" }));
await add("pass-pr-open", "pass-pr", () => passPrOpen);
await add("pass-pr-merged", "pass-pr", () => passPrMerged);
await add(
  "review-warn",
  "review",
  async () => (await generateReview(gateWarn, { request: "add a reporting export", base: "HEAD~1", policy: "standard", governance: "team" })).data,
);
await add(
  "review-fail",
  "review",
  async () => (await generateReview(gateFail, { request: "rotate the webhook secret", base: "HEAD~1", policy: "standard", governance: "team" })).data,
);
await add(
  "review-companions",
  "review",
  async () => (await generateReview(gateCompanion, { request: TASK, base: "HEAD~1", policy: "standard", governance: "team" })).data,
);
await add("route", "route", () => generateRoute(TASK, { path: shopApi, offline: true }));
await add("doctor", "doctor", () => ({ ok: false, tools: doctorTools }));
await add("report", "report", () => {
  const data = generateReport(shopApi).data;
  return { ...data, generatedAt: FIXED_TIMESTAMP, doctor: { ...data.doctor, ok: false, tools: doctorTools } };
});
await add("summary", "summary", () => summary);
await add("discover", "discover", () => discoverRepositories([path.join(WORK, "fixtures")], { depth: 2 }));
await add("index", "index", () => indexRepositories([shopApi, sampleApi], { catalog }));
await add("catalog", "catalog", () => listCatalog({ catalog }));
await add("search", "search", () => searchCatalog("payment webhook", { catalog, offline: true }));
await add("init", "init", () => initProject(initTarget));
await add("install", "install", () => ({ ...getInstallPlan(), installed: true, binaryPath: "/usr/local/bin/solumbe" }));

const out = {
  generatedFrom: "tests/golden/generate-formatters.mjs",
  note: "Each case stores the formatter input and its output per renderer mode; tests/formatters-golden.test.js re-renders the input and fails on any byte that differs. First recorded before the glyph migration (phase 2, which left it byte-identical); regenerated in phase 3 for the box width fix (O13) and the shared summary taking the table, tree and closing-line shape.",
  modes: MODES,
  cases,
};
fs.writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
fs.rmSync(WORK, { recursive: true, force: true });
process.stderr.write(`${cases.length} cases x ${Object.keys(MODES).length} modes -> ${path.relative(repoRoot, target)}\n`);
