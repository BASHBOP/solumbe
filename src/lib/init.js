import fs from "node:fs";
import path from "node:path";
import { formatTerminalSummary } from "./output.js";
import { execFileSync } from "node:child_process";
import { generateHarness } from "./harness.js";
import { isTypeCheckScript } from "./package-scripts.js";

const defaultToolRepo = "BASHBOP/solumbe";
const defaultToolRef = "main";
const workflowPath = ".github/workflows/solumbe-ci.yml";
const hookPath = ".githooks/pre-commit";

// GitHub Actions majors the generated workflow pins. tests/init.test.js checks
// these against this repository's own .github/workflows/solumbe-ci.yml, so the
// template cannot fall behind the actions solumbe itself runs on.
/** @type {Record<string, string>} */
export const WORKFLOW_ACTION_VERSIONS = {
  "actions/checkout": "v7",
  "actions/setup-node": "v7",
  "actions/upload-artifact": "v7",
};

/**
 * @param {string} action
 * @returns {string}
 */
function uses(action) {
  return `${action}@${WORKFLOW_ACTION_VERSIONS[action]}`;
}

// Pre-commit runs the staged Solumbe gate plus fast static checks — never the
// slow (test/build/audit/smoke) gates, which belong in CI. A harness validate
// command qualifies when its npm script name is a known static check or a type
// check.
const staticPrecommitScripts = new Set(["lint", "format:check"]);

/**
 * @typedef {object} InitOptions
 * @property {boolean} [force] Overwrite existing scaffold files.
 * @property {string} [toolRepo] solumbe tool repository (owner/name).
 * @property {string} [toolRef] solumbe tool git ref.
 * @property {boolean} [noWorkflow] Skip writing the CI workflow file.
 * @property {boolean} [gates] Inject a harness-driven quality job into the workflow. Defaults to true.
 * @property {boolean} [precommit] Scaffold a dependency-free pre-commit hook. Defaults to true.
 * @property {boolean} [hooksPath] Point git core.hooksPath at .githooks (requires the pre-commit hook). Defaults to false.
 */

/**
 * @typedef {{ action: "created" | "updated" | "skipped", path: string }} ScaffoldOperation
 */

/**
 * @typedef {object} InitResult
 * @property {boolean} ok
 * @property {string} root
 * @property {boolean} force
 * @property {string} toolRepo
 * @property {string} toolRef
 * @property {boolean} gatesApplied Whether a harness-driven quality job was added to the workflow.
 * @property {"applied" | "disabled" | "none"} gatesStatus Why gates were or were not scaffolded.
 * @property {boolean} precommitApplied Whether a pre-commit hook was scaffolded.
 * @property {"applied" | "disabled" | "none"} precommitStatus Why the pre-commit hook was or was not scaffolded.
 * @property {boolean} hooksConfigured Whether git core.hooksPath was set to .githooks.
 * @property {boolean} hooksPathRequested Whether the caller asked to set core.hooksPath.
 * @property {string[]} created
 * @property {string[]} updated
 * @property {string[]} skipped
 * @property {string[]} nextSteps
 */

/**
 * @param {string} [targetPath]
 * @param {InitOptions} [options]
 * @returns {InitResult}
 */
export function initProject(targetPath = ".", options = {}) {
  const root = path.resolve(targetPath);
  if (!fs.existsSync(root)) {
    throw new Error(`target path does not exist: ${root}`);
  }

  const force = Boolean(options.force);
  const toolRepo = String(options.toolRepo ?? defaultToolRepo);
  const toolRef = String(options.toolRef ?? defaultToolRef);
  const wantGates = options.gates !== false; // default on
  const wantPrecommit = options.precommit !== false; // default on
  const wantHooksPath = Boolean(options.hooksPath); // default off — never mutate git config without consent
  /** @type {ScaffoldOperation[]} */
  const operations = [];

  // Inspect the repo once to drive both the CI gates and the pre-commit hook.
  // A harness failure (unreadable repo, parse error) must never block the core
  // scaffold, so fall back to the review-only workflow with no detected gates.
  /** @type {{ commands?: { validate?: HarnessCommand[], setup?: HarnessCommand[] }, repo?: { packageManagers?: string[] } } | null} */
  let harness = null;
  if (wantGates || wantPrecommit) {
    try {
      harness = generateHarness(root).data;
    } catch {
      harness = null;
    }
  }

  const validate = harness?.commands?.validate ?? [];
  const setup = harness?.commands?.setup ?? [];
  const packageManagers = harness?.repo?.packageManagers ?? [];

  const qualityJob = wantGates ? buildQualityJob({ root, setup, validate, packageManagers }) : "";
  const gatesApplied = qualityJob.length > 0;
  const gatesStatus = gatesApplied ? "applied" : wantGates ? "none" : "disabled";

  const precommitCommands = wantPrecommit ? selectPrecommitCommands(validate) : [];
  const precommitApplied = wantPrecommit;
  const precommitStatus = precommitApplied ? "applied" : wantPrecommit ? "none" : "disabled";

  writeScaffoldFile(root, ".solumbe/README.md", contextReadme(toolRepo, toolRef, { gatesApplied, precommitApplied }), { force, operations });

  ensureGitignoreEntry(root, ".solumbe/", operations);

  if (!options.noWorkflow) {
    writeScaffoldFile(root, workflowPath, buildWorkflow(toolRepo, toolRef, qualityJob), {
      force,
      operations,
    });
  }

  if (precommitApplied) {
    writeScaffoldFile(root, hookPath, buildPrecommitHook(precommitCommands), { force, operations, mode: 0o755 });
  }

  let hooksConfigured = false;
  if (precommitApplied && wantHooksPath) {
    hooksConfigured = setHooksPath(root);
  }

  return {
    ok: true,
    root,
    force,
    toolRepo,
    toolRef,
    gatesApplied,
    gatesStatus,
    precommitApplied,
    precommitStatus,
    hooksConfigured,
    hooksPathRequested: wantHooksPath,
    created: operations.filter((item) => item.action === "created").map((item) => item.path),
    updated: operations.filter((item) => item.action === "updated").map((item) => item.path),
    skipped: operations.filter((item) => item.action === "skipped").map((item) => item.path),
    nextSteps: buildNextSteps({ gatesApplied, precommitApplied, hooksConfigured, hooksPathRequested: wantHooksPath }),
  };
}

/**
 * @param {InitResult} result
 * @param {{ emoji?: boolean, color?: boolean, theme?: string }} [options]
 * @param {import("./output.js").ClosingLine} [close] the caller's verdict on what was written
 * @returns {string}
 */
export function formatInitSummary(result, options = {}, close) {
  return formatTerminalSummary({
    title: "solumbe init · trust harness setup",
    glyph: "🛠️",
    subtitle: result.root,
    facts: /** @type {[string, string | number][]} */ ([
      ["Gates", formatGatesSummary(result)],
      ["Pre-commit", formatPrecommitSummary(result)],
      ...(result.hooksPathRequested && !result.precommitApplied ? [["Hooks path", "skipped (no pre-commit hook was scaffolded)"]] : []),
    ]),
    sections: [
      { title: "Created", glyph: "✅", items: result.created, kind: "tree" },
      { title: "Updated", glyph: "🔄", items: result.updated, kind: "tree" },
      { title: "Skipped", glyph: "⏭️", items: result.skipped, kind: "tree" },
      { title: "Next steps", glyph: "📝", items: result.nextSteps },
    ],
    close,
    options,
  });
}

/**
 * @param {InitResult} result
 * @returns {string}
 */
function formatGatesSummary(result) {
  if (result.gatesStatus === "applied") {
    return "harness-driven quality job added to CI";
  }
  if (result.gatesStatus === "disabled") {
    return "skipped (--no-gates)";
  }
  return "none (no validation scripts detected)";
}

/**
 * @param {InitResult} result
 * @returns {string}
 */
function formatPrecommitSummary(result) {
  if (result.precommitStatus === "applied") {
    return result.hooksConfigured
      ? "hook installed and core.hooksPath set to .githooks"
      : "hook scaffolded (run `git config core.hooksPath .githooks` to enable)";
  }
  if (result.precommitStatus === "disabled") {
    return "skipped (--no-precommit)";
  }
  return "none";
}

/**
 * @param {{ gatesApplied: boolean, precommitApplied: boolean, hooksConfigured: boolean, hooksPathRequested: boolean }} status
 * @returns {string[]}
 */
function buildNextSteps({ gatesApplied, precommitApplied, hooksConfigured, hooksPathRequested }) {
  const steps = ["Review the generated workflow before opening a PR."];
  if (gatesApplied) {
    steps.push("Confirm the CI quality steps match how you run this project locally; edit the workflow if they drift.");
  }
  if (precommitApplied && !hooksConfigured) {
    steps.push("Enable the pre-commit hook: `git config core.hooksPath .githooks` (re-run `init --hooks-path` to do it automatically).");
  }
  if (hooksPathRequested && !precommitApplied) {
    steps.push("core.hooksPath was not set because no pre-commit hook was scaffolded.");
  }
  if (hooksConfigured) {
    steps.push("Pre-commit hook is active via core.hooksPath; bypass a single commit with `git commit --no-verify`.");
  }
  steps.push("If the solumbe tool repository is private, add a SOLUMBE_REPO_TOKEN secret and enable the token line in the workflow.");
  steps.push("Open or update a pull request to verify the PR comment and artifact.");
  return steps;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} contents
 * @param {{ force: boolean, operations: ScaffoldOperation[], mode?: number }} context
 * @returns {void}
 */
function writeScaffoldFile(root, relativePath, contents, { force, operations, mode }) {
  const absolutePath = path.join(root, relativePath);
  const exists = fs.existsSync(absolutePath);
  if (exists && !force) {
    operations.push({ action: "skipped", path: relativePath });
    return;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
  if (mode !== undefined) {
    fs.chmodSync(absolutePath, mode);
  }
  operations.push({ action: exists ? "updated" : "created", path: relativePath });
}

// Init intentionally creates local .solumbe artifacts (the copied tool, reports,
// and optional hooks). Keep that directory ignored; map/context caches themselves
// now live outside the inspected repository. Idempotent: skip when the entry (or
// a covering pattern) is already present, create the file if absent.
/**
 * @param {string} root
 * @param {string} entry
 * @param {ScaffoldOperation[]} operations
 * @returns {void}
 */
function ensureGitignoreEntry(root, entry, operations) {
  const relativePath = ".gitignore";
  const absolutePath = path.join(root, relativePath);
  const exists = fs.existsSync(absolutePath);
  const current = exists ? fs.readFileSync(absolutePath, "utf8") : "";

  if (gitignoreCovers(current, entry)) {
    operations.push({ action: "skipped", path: relativePath });
    return;
  }

  const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(absolutePath, `${current}${prefix}${entry}\n`);
  operations.push({ action: exists ? "updated" : "created", path: relativePath });
}

/**
 * @param {string} contents
 * @param {string} entry
 * @returns {boolean}
 */
function gitignoreCovers(contents, entry) {
  const bare = entry.replace(/\/+$/, "");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .some((line) => {
      if (line.startsWith("#")) {
        return false;
      }
      const normalized = line.replace(/^\/+/, "").replace(/\/+$/, "");
      return normalized === bare;
    });
}

/** @typedef {import('./harness.js').HarnessCommand} HarnessCommand */

/**
 * Pick the fast static checks safe to run on every commit.
 * @param {HarnessCommand[]} validate
 * @returns {HarnessCommand[]}
 */
function selectPrecommitCommands(validate) {
  return validate.filter((command) => isStaticPrecommitScript(command.script ?? ""));
}

/**
 * @param {string} script
 * @returns {boolean}
 */
function isStaticPrecommitScript(script) {
  if (staticPrecommitScripts.has(script) || isTypeCheckScript(script)) {
    return true;
  }
  // Match harness lint naming. Type checks are matched by segment, so a name
  // that only contains the letters (e.g. "prototype") is not one.
  return script.includes("lint");
}

/**
 * Set git core.hooksPath so the scaffolded .githooks directory is honored.
 * Returns false (rather than throwing) when git is unavailable or the target
 * is not a git repository, so init never fails on an optional convenience.
 * @param {string} root
 * @returns {boolean}
 */
function setHooksPath(root) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} toolRepo
 * @param {string} toolRef
 * @param {{ gatesApplied: boolean, precommitApplied: boolean }} status
 * @returns {string}
 */
function contextReadme(toolRepo, toolRef, status) {
  const assets = [
    status.gatesApplied
      ? `- \`${workflowPath}\`: runs quality gates and PR review context generation on pull requests`
      : `- \`${workflowPath}\`: runs PR review context generation on pull requests`,
    "- `.solumbe/pr-review.md`: generated by GitHub Actions and uploaded as an artifact",
  ];
  if (status.gatesApplied) {
    assets.push("- CI quality job: derived from your package scripts by `solumbe harness`");
  }
  if (status.precommitApplied) {
    assets.push(`- \`${hookPath}\`: dependency-free pre-commit hook running fast static checks (enable with \`git config core.hooksPath .githooks\`)`);
  }
  return `# solumbe

This folder is managed by solumbe.

Generated assets:

${assets.join("\n")}

Tool source:

- Repository: ${toolRepo}
- Ref: ${toolRef}

Local command:

\`\`\`bash
solumbe pr . --base origin/main --out .solumbe/pr-review.md
\`\`\`
`;
}

/**
 * Compose the workflow file: an optional harness-driven quality job followed by
 * the PR/commit review job. When no gates are detected the quality job is empty
 * and the file is identical to the review-only template.
 * @param {string} toolRepo
 * @param {string} toolRef
 * @param {string} qualityJob Rendered quality-job YAML block, or "" to omit it.
 * @returns {string}
 */
function buildWorkflow(toolRepo, toolRef, qualityJob) {
  return `name: solumbe CI

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
${qualityJob}  review:
    name: Generate PR review context
    runs-on: ubuntu-latest

    steps:
      - name: Checkout PR head
        if: github.event_name == 'pull_request'
        uses: ${uses("actions/checkout")}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - name: Checkout pushed commit
        if: github.event_name == 'push'
        uses: ${uses("actions/checkout")}
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0

      - name: Checkout solumbe
        uses: ${uses("actions/checkout")}
        with:
          repository: ${toolRepo}
          ref: ${toolRef}
          path: .solumbe/tool
          # If ${toolRepo} is private, create a secret named SOLUMBE_REPO_TOKEN
          # with read access and uncomment the next line.
          # token: \${{ secrets.SOLUMBE_REPO_TOKEN }}

      - name: Set up Node.js
        uses: ${uses("actions/setup-node")}
        with:
          node-version: 22

      - name: Install solumbe dependencies
        working-directory: .solumbe/tool
        run: npm ci

      - name: Fetch base branch
        if: github.event_name == 'pull_request'
        run: git fetch origin "+\${{ github.base_ref }}:refs/remotes/origin/\${{ github.base_ref }}" --depth=1

      - name: Generate PR review context
        if: github.event_name == 'pull_request'
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          node .solumbe/tool/src/cli.js pr . \\
            --base "origin/\${{ github.base_ref }}" \\
            --head HEAD \\
            --number "\${{ github.event.pull_request.number }}" \\
            --out .solumbe/pr-review.md \\
            --comment

      - name: Generate commit review context
        if: github.event_name == 'push'
        run: |
          BASE="\${{ github.event.before }}"
          if ! git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1; then
            if git rev-parse --verify "HEAD~1^{commit}" >/dev/null 2>&1; then
              BASE="HEAD~1"
            else
              BASE="HEAD"
            fi
          fi

          node .solumbe/tool/src/cli.js pr . \\
            --base "$BASE" \\
            --head "\${{ github.sha }}" \\
            --out .solumbe/pr-review.md

      - name: Upload PR review artifact
        uses: ${uses("actions/upload-artifact")}
        with:
          name: solumbe-pr-review
          path: .solumbe/pr-review.md
`;
}

/**
 * Render the quality job from harness setup + validate commands. Returns "" when
 * there is nothing to gate so the workflow stays review-only.
 * @param {{ root: string, setup: HarnessCommand[], validate: HarnessCommand[], packageManagers: string[] }} harness
 * @returns {string}
 */
function buildQualityJob({ root, setup, validate, packageManagers }) {
  if (!validate.length) {
    return "";
  }

  const lines = [
    "  quality:",
    "    name: Quality gates",
    "    runs-on: ubuntu-latest",
    "",
    "    steps:",
    "      - name: Checkout",
    `        uses: ${uses("actions/checkout")}`,
  ];

  for (const step of runtimeSetupSteps(packageManagers)) {
    lines.push("", ...step);
  }

  for (const command of setup) {
    lines.push("", `      - name: ${command.reason}`, `        run: ${ciSetupCommand(command.command, root)}`);
  }

  for (const command of validate) {
    lines.push("", `      - name: ${command.reason}`, `        run: ${command.command}`);
  }

  return `${lines.join("\n")}\n\n`;
}

/**
 * Toolchain setup steps (pnpm/bun action + setup-node with the matching cache).
 * @param {string[]} packageManagers
 * @returns {string[][]}
 */
function runtimeSetupSteps(packageManagers) {
  if (packageManagers.includes("pnpm")) {
    return [
      ["      - name: Set up pnpm", "        uses: pnpm/action-setup@v4"],
      ["      - name: Set up Node.js", `        uses: ${uses("actions/setup-node")}`, "        with:", "          node-version: 22", "          cache: pnpm"],
    ];
  }
  if (packageManagers.includes("yarn")) {
    return [
      ["      - name: Set up Node.js", `        uses: ${uses("actions/setup-node")}`, "        with:", "          node-version: 22", "          cache: yarn"],
    ];
  }
  if (packageManagers.includes("npm")) {
    return [
      ["      - name: Set up Node.js", `        uses: ${uses("actions/setup-node")}`, "        with:", "          node-version: 22", "          cache: npm"],
    ];
  }
  if (packageManagers.includes("bun")) {
    return [["      - name: Set up Bun", "        uses: oven-sh/setup-bun@v2"]];
  }
  return [];
}

/**
 * Map a local install command to its CI-deterministic equivalent when a
 * lockfile is present; otherwise keep the original install command.
 * @param {string} command
 * @param {string} root
 * @returns {string}
 */
function ciSetupCommand(command, root) {
  switch (command) {
    case "npm install":
      return hasNpmLockfile(root) ? "npm ci" : "npm install";
    case "pnpm install":
      return fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn install":
      return fs.existsSync(path.join(root, "yarn.lock")) ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun install":
      return hasBunLockfile(root) ? "bun install --frozen-lockfile" : "bun install";
    default:
      return command;
  }
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function hasNpmLockfile(root) {
  return ["package-lock.json", "npm-shrinkwrap.json"].some((name) => fs.existsSync(path.join(root, name)));
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function hasBunLockfile(root) {
  return ["bun.lockb", "bun.lock"].some((name) => fs.existsSync(path.join(root, name)));
}

/**
 * Render a POSIX-sh pre-commit hook that runs the staged Solumbe gate and the
 * given static-check commands. The gate is intentionally tied to the Git index
 * so the receipt describes the commit that is about to be created.
 * @param {HarnessCommand[]} commands
 * @returns {string}
 */
function buildPrecommitHook(commands) {
  const body = commands.map((command) => command.command).join("\n");
  return `#!/bin/sh
# Managed by solumbe (\`solumbe init\`). Runs the staged safety gate and fast static checks before each commit.
# Bypass a single commit with: git commit --no-verify
# Slower gates (tests, build, audit) run in CI, not here.
set -e

if ! command -v solumbe >/dev/null 2>&1; then
  echo "solumbe pre-commit: solumbe is required for the staged safety gate. Install it before committing." >&2
  exit 1
fi

echo "solumbe pre-commit: checking staged changes"
# --policy standard: a stricter policy in .solumberc.json (company, high-risk) is
# for merge time and would fail every local commit on review state alone.
if ! solumbe gate . --staged --policy standard --out .solumbe/gate.md; then
  echo "solumbe pre-commit: FAIL — commit blocked by the staged safety gate; full report in .solumbe/gate.md" >&2
  exit 1
fi

echo "solumbe pre-commit: running static checks"
${body}
`;
}
