import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCodeMap } from "./code-map.js";
import { isTypeCheckScript, selectScripts } from "./package-scripts.js";
import { formatGitSummary, inspectRepo } from "./repo.js";
import { classifyPath, RISK_SCORE_WEIGHTS } from "./risk-paths.js";
import { runCommand } from "./tools.js";
import { estimateTokens, estimateTokenSections } from "./tokens.js";

/**
 * @typedef {import('./index-cache.js').CodeMapFile} CodeMapFile
 * @typedef {import('./index-cache.js').CodeMapHttpMethod} CodeMapHttpMethod
 * @typedef {import('./index-cache.js').CodeMapSymbol} CodeMapSymbol
 */

/**
 * Options accepted by {@link generatePrReview}. All fields are optional and
 * sourced from CLI flags / MCP tool args, so values are loosely typed.
 * @typedef {object} PrReviewOptions
 * @property {string|number} [number] - Explicit PR number to load via gh.
 * @property {string|number} [pr] - Alias for `number`.
 * @property {boolean} [github] - Force loading PR metadata from GitHub.
 * @property {boolean} [comment] - Post/update the PR review comment.
 * @property {string} [base] - Base ref override for the diff.
 * @property {string} [head] - Head ref override for the diff.
 */

/**
 * A single changed-file row after enrichment from the code map and diff stats.
 * @typedef {object} EnrichedFile
 * @property {string} path
 * @property {string} [previousPath]
 * @property {string} status
 * @property {string} statusName
 * @property {number} additions
 * @property {number} deletions
 * @property {string} kind
 * @property {string} domain
 * @property {string|null} [route]
 * @property {string|null} [controllerBasePath]
 * @property {CodeMapHttpMethod[]} httpMethods
 * @property {string[]} imports
 * @property {string[]} exports
 * @property {CodeMapSymbol[]} symbols
 * @property {string[]} [riskFlags]
 */

/**
 * Parsed git name-status entry before code-map enrichment.
 * @typedef {object} DiffFileEntry
 * @property {string} status
 * @property {string} [score]
 * @property {string} [previousPath]
 * @property {string} path
 */

/**
 * Per-file numstat record keyed by normalized path.
 * @typedef {object} NumstatEntry
 * @property {number} additions
 * @property {number} deletions
 */

/**
 * Result of {@link getDiff}.
 * @typedef {object} DiffResult
 * @property {string} mode
 * @property {DiffFileEntry[]} files
 * @property {Map<string, NumstatEntry>} numstat
 * @property {number} insertions
 * @property {number} deletions
 * @property {string} shortstat
 * @property {string} [fallbackReason]
 */

/**
 * PR metadata loaded from the GitHub CLI (or a stub when not requested).
 * @typedef {object} PrMetadata
 * @property {boolean} requested
 * @property {boolean} available
 * @property {string} [source]
 * @property {string|number} [number]
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [state]
 * @property {string} [url]
 * @property {string} [author]
 * @property {string} [baseRefName]
 * @property {string} [headRefName]
 * @property {string} [error]
 * @property {any[]} [files]
 * @property {any[]} comments
 * @property {any[]} reviews
 * @property {any[]} reviewComments
 */

/**
 * Normalized review/comment item.
 * @typedef {object} ReviewCommentItem
 * @property {string} type
 * @property {string} [author]
 * @property {string} [path]
 * @property {number} [line]
 * @property {string} [state]
 * @property {string} body
 * @property {string} [url]
 */

/**
 * @typedef {object} ReviewComments
 * @property {number} count
 * @property {ReviewCommentItem[]} items
 */

/**
 * @typedef {object} RiskSummary
 * @property {string} level
 * @property {number} score
 * @property {string[]} flags
 */

/**
 * @typedef {object} RouteTarget
 * @property {string} file
 * @property {string} [method]
 * @property {string} route
 */

/**
 * @typedef {object} SymbolTarget
 * @property {string} file
 * @property {string[]} symbols
 */

/**
 * @typedef {object} ReviewTargets
 * @property {RouteTarget[]} routes
 * @property {SymbolTarget[]} symbols
 * @property {string[]} configFiles
 * @property {string[]} testFiles
 */

/**
 * @typedef {object} TestHint
 * @property {string} [script]
 * @property {string} command
 * @property {string} reason
 */

/**
 * Outcome of attempting to post the PR review comment.
 * @typedef {object} CommentResult
 * @property {boolean} ok
 * @property {string} [action]
 * @property {string|number} [id]
 * @property {string} [url]
 * @property {string} [error]
 */

/**
 * The full PR-review data payload returned by {@link generatePrReview}.
 * @typedef {object} PrReviewData
 * @property {boolean} ok
 * @property {string} generatedAt
 * @property {{ root: string, name: string, git: any, packageManagers: string[] }} repo
 * @property {PrMetadata} pr
 * @property {{ base: string, head: string, mode: string, changedFileCount: number, insertions: number, deletions: number, shortstat: string, fallbackReason?: string }} comparison
 * @property {EnrichedFile[]} changedFiles
 * @property {ReturnType<typeof summarizeDomains>} domains
 * @property {ReviewComments} reviewComments
 * @property {RiskSummary} risk
 * @property {ReviewTargets} reviewTargets
 * @property {TestHint[]} testHints
 * @property {ReturnType<typeof estimateTokenSections> & { fullJson?: number, markdown?: number }} [tokenEstimate]
 * @property {CommentResult} [comment]
 */

const ghPrFields = ["number", "title", "body", "state", "url", "author", "baseRefName", "headRefName", "comments", "reviews", "files"].join(",");

const statusNames = {
  A: "added",
  C: "copied",
  D: "deleted",
  M: "modified",
  R: "renamed",
  T: "type-changed",
  U: "unmerged",
  X: "unknown",
};

const preferredScripts = ["lint", "typecheck", "type-check", "check:type", "tsc", "tsc:check", "test", "test:unit", "test:e2e", "build"];
const prCommentMarker = "<!-- solumbe-pr-review -->";

/**
 * @param {string} [repoPath]
 * @param {PrReviewOptions} [options]
 * @returns {{ data: PrReviewData, markdown: string }}
 */
export function generatePrReview(repoPath = ".", options = {}) {
  const repo = inspectRepo(repoPath);
  if (!repo.git.available) {
    throw new Error(`PR review requires a git repository: ${repo.root}`);
  }

  const root = repo.git.root ?? repo.root;
  const pr = loadPrMetadata(root, options);
  const base = resolveBaseRef(root, options, pr);
  const head = String(options.head ?? pr.headRefName ?? "HEAD");
  const diff = getDiff(root, base, head);
  const codeMap = generateCodeMap(root);
  const changedFiles = enrichChangedFiles(diff.files, diff.numstat, codeMap);
  const domains = summarizeDomains(changedFiles);
  const reviewComments = normalizeReviewComments(pr);
  const risk = inferRisk(changedFiles, diff, reviewComments);
  const testHints = inferTestHints(repo, changedFiles, risk);
  const reviewTargets = inferReviewTargets(changedFiles);

  /** @type {PrReviewData} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    repo: {
      root,
      name: path.basename(root),
      git: repo.git,
      packageManagers: repo.packageManagers,
      // The full package.json scripts map is intentionally omitted from the
      // payload: `testHints` already extracts the relevant commands, and
      // embedding every script bloated every PR-review result. Internal test
      // inference still reads scripts from the live `repo` object below.
    },
    pr,
    comparison: {
      base,
      head,
      mode: diff.mode,
      changedFileCount: changedFiles.length,
      insertions: diff.insertions,
      deletions: diff.deletions,
      shortstat: diff.shortstat,
      fallbackReason: diff.fallbackReason,
    },
    changedFiles,
    domains,
    reviewComments,
    risk,
    reviewTargets,
    testHints,
  };

  /** @type {ReturnType<typeof estimateTokenSections> & { fullJson?: number, markdown?: number }} */
  const tokenEstimate = {
    ...estimateTokenSections([
      { name: "comparison", value: data.comparison },
      { name: "changedFiles", value: data.changedFiles },
      { name: "reviewTargets", value: data.reviewTargets },
      { name: "reviewComments", value: data.reviewComments },
    ]),
  };
  data.tokenEstimate = tokenEstimate;
  tokenEstimate.fullJson = estimateTokens(data);

  if (options.comment) {
    data.comment = tryPostPrReviewComment(root, data);
  }

  let markdown = formatPrReviewMarkdown(data);
  tokenEstimate.markdown = estimateTokens(markdown);
  markdown = formatPrReviewMarkdown(data);
  tokenEstimate.markdown = estimateTokens(markdown);

  return {
    data,
    markdown,
  };
}

/**
 * @param {PrReviewData} data
 * @returns {string}
 */
export function formatPrReviewMarkdown(data) {
  const lines = [
    "# PR Review Context",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    "## Overview",
    "",
    `- Repo: ${data.repo.name}`,
    `- Root: ${data.repo.root}`,
    `- Git: ${formatGitSummary(data.repo.git)}`,
    `- Comparison: ${data.comparison.base}...${data.comparison.head}`,
    `- Changed files: ${data.comparison.changedFileCount}`,
    `- Diff: ${data.comparison.shortstat || `${data.comparison.insertions} insertion(s), ${data.comparison.deletions} deletion(s)`}`,
    `- Risk: ${data.risk.level} (${data.risk.score})`,
    `- Estimated JSON tokens: ${/** @type {NonNullable<typeof data.tokenEstimate>} */ (data.tokenEstimate).fullJson}`,
    `- Estimated Markdown tokens: ${/** @type {NonNullable<typeof data.tokenEstimate>} */ (data.tokenEstimate).markdown ?? "pending"}`,
  ];

  if (data.comparison.fallbackReason) {
    lines.push(`- Diff fallback: ${data.comparison.fallbackReason}`);
  }

  if (data.pr.available) {
    lines.push(`- PR: #${data.pr.number} ${data.pr.title || ""}`.trim());
    if (data.pr.url) {
      lines.push(`- URL: ${data.pr.url}`);
    }
  } else if (data.pr.requested) {
    lines.push(`- PR metadata: unavailable (${data.pr.error})`);
  }

  lines.push("", "## Risk Flags", "");
  if (data.risk.flags.length) {
    for (const flag of data.risk.flags) {
      lines.push(`- ${flag}`);
    }
  } else {
    lines.push("- none detected");
  }

  lines.push("", "## Review Targets", "");
  if (data.reviewTargets.routes.length) {
    lines.push("Routes:");
    for (const route of data.reviewTargets.routes.slice(0, 20)) {
      lines.push(`- ${route.method ? `${route.method} ` : ""}${route.route}: ${route.file}`);
    }
  }
  if (data.reviewTargets.symbols.length) {
    lines.push("Symbols:");
    for (const item of data.reviewTargets.symbols.slice(0, 30)) {
      lines.push(`- ${item.file}: ${item.symbols.join(", ")}`);
    }
  }
  if (!data.reviewTargets.routes.length && !data.reviewTargets.symbols.length) {
    lines.push("- none detected");
  }

  lines.push("", "## Changed Domains", "");
  if (data.domains.length) {
    lines.push("| Domain | Files | +/- | Kinds |", "|---|---:|---:|---|");
    for (const domain of data.domains.slice(0, 20)) {
      lines.push(
        `| ${domain.name} | ${domain.fileCount} | +${domain.additions} / -${domain.deletions} | ${domain.kinds.map((item) => `${item.kind} ${item.count}`).join(", ")} |`,
      );
    }
  } else {
    lines.push("- none detected");
  }

  lines.push("", "## Changed Files", "");
  if (data.changedFiles.length) {
    lines.push("| File | Status | Kind | Domain | +/- | Notes |", "|---|---|---|---|---:|---|");
    for (const file of data.changedFiles.slice(0, 80)) {
      lines.push(
        `| ${formatFileCell(file)} | ${file.statusName} | ${file.kind} | ${file.domain} | +${file.additions} / -${file.deletions} | ${/** @type {string[]} */ (file.riskFlags).join("; ") || ""} |`,
      );
    }
  } else {
    lines.push("- no changed files detected");
  }

  lines.push("", "## PR Comments", "");
  if (data.reviewComments.items.length) {
    for (const comment of data.reviewComments.items.slice(0, 30)) {
      const location = comment.path ? ` (${comment.path}${comment.line ? `:${comment.line}` : ""})` : "";
      lines.push(`- ${comment.author || "unknown"}${location}: ${comment.body}`);
    }
  } else {
    lines.push(data.pr.requested ? "- no comments returned by GitHub CLI" : "- not loaded; pass `--number <pr>` to enrich from GitHub");
  }

  lines.push("", "## Suggested Verification", "");
  if (!data.changedFiles.length) {
    lines.push("- no verification needed; no changed files detected");
  } else if (data.testHints.length) {
    for (const hint of data.testHints) {
      lines.push(`- \`${hint.command}\`: ${hint.reason}`);
    }
  } else {
    lines.push("- no obvious package scripts detected");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * @param {PrReviewData} data
 * @returns {string}
 */
export function formatPrCommentMarkdown(data) {
  const lines = [
    prCommentMarker,
    "## solumbe PR Review",
    "",
    `**Risk:** ${data.risk.level} (${data.risk.score})`,
    `**Changed files:** ${data.comparison.changedFileCount}`,
    `**Diff:** ${data.comparison.shortstat || `${data.comparison.insertions} insertion(s), ${data.comparison.deletions} deletion(s)`}`,
    "",
  ];

  lines.push("### Risk Flags", "");
  if (data.risk.flags.length) {
    for (const flag of data.risk.flags) {
      lines.push(`- ${flag}`);
    }
  } else {
    lines.push("- none detected");
  }

  lines.push("", "### Changed Domains", "");
  if (data.domains.length) {
    lines.push("| Domain | Files | +/- | Kinds |", "|---|---:|---:|---|");
    for (const domain of data.domains.slice(0, 10)) {
      lines.push(
        `| ${domain.name} | ${domain.fileCount} | +${domain.additions} / -${domain.deletions} | ${domain.kinds.map((item) => `${item.kind} ${item.count}`).join(", ")} |`,
      );
    }
  } else {
    lines.push("- none detected");
  }

  const riskyFiles = data.changedFiles.filter((file) => /** @type {string[]} */ (file.riskFlags).length).slice(0, 15);
  lines.push("", "### Risky Files", "");
  if (riskyFiles.length) {
    for (const file of riskyFiles) {
      lines.push(`- \`${formatFileCell(file)}\`: ${/** @type {string[]} */ (file.riskFlags).join(", ")}`);
    }
  } else {
    lines.push("- none detected");
  }

  lines.push("", "### Suggested Verification", "");
  if (!data.changedFiles.length) {
    lines.push("- no verification needed; no changed files detected");
  } else if (data.testHints.length) {
    for (const hint of data.testHints) {
      lines.push(`- \`${hint.command}\`: ${hint.reason}`);
    }
  } else {
    lines.push("- no obvious package scripts detected");
  }

  lines.push("", "_Full Markdown report is uploaded as the `solumbe-pr-review` workflow artifact when run in GitHub Actions._", "");
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {PrReviewOptions} options
 * @returns {PrMetadata}
 */
function loadPrMetadata(root, options) {
  const number = options.number ?? options.pr;
  const shouldLoad = Boolean(number ?? options.github ?? options.comment);
  if (!shouldLoad) {
    return {
      requested: false,
      available: false,
      comments: [],
      reviews: [],
      reviewComments: [],
    };
  }

  const args = ["pr", "view"];
  if (number) {
    args.push(String(number));
  }
  args.push("--json", ghPrFields);

  const result = runCommand("gh", args, { cwd: root, timeout: 30000 });
  if (!result.ok) {
    return {
      requested: true,
      available: false,
      number,
      error: cleanCommandError(result, "gh pr view failed"),
      comments: [],
      reviews: [],
      reviewComments: [],
    };
  }

  try {
    const raw = JSON.parse(result.stdout);
    const prNumber = raw.number ?? number;
    return {
      requested: true,
      available: true,
      source: "gh",
      number: prNumber,
      title: raw.title,
      body: raw.body,
      state: raw.state,
      url: raw.url,
      author: raw.author?.login ?? raw.author?.name,
      baseRefName: raw.baseRefName,
      headRefName: raw.headRefName,
      files: Array.isArray(raw.files) ? raw.files : [],
      comments: Array.isArray(raw.comments) ? raw.comments : [],
      reviews: Array.isArray(raw.reviews) ? raw.reviews : [],
      reviewComments: prNumber ? loadGhReviewComments(root, prNumber) : [],
    };
  } catch (error) {
    return {
      requested: true,
      available: false,
      number,
      error: `failed to parse gh output: ${/** @type {Error} */ (error).message}`,
      comments: [],
      reviews: [],
      reviewComments: [],
    };
  }
}

/**
 * @param {string} root
 * @param {PrReviewData} data
 * @returns {CommentResult}
 */
function tryPostPrReviewComment(root, data) {
  try {
    return postPrReviewComment(root, data);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * @param {string} root
 * @param {PrReviewData} data
 * @returns {CommentResult}
 */
function postPrReviewComment(root, data) {
  const number = data.pr.number;
  if (!number) {
    throw new Error(data.pr.error ? `could not resolve PR number: ${data.pr.error}` : "could not resolve PR number");
  }

  const repoResult = runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: root, timeout: 20000 });
  if (!repoResult.ok) {
    throw new Error(cleanCommandError(repoResult, "gh repo view failed"));
  }

  const nameWithOwner = JSON.parse(repoResult.stdout).nameWithOwner;
  if (!nameWithOwner) {
    throw new Error("gh repo view did not return nameWithOwner");
  }

  const body = formatPrCommentMarkdown(data);
  const existing = findExistingPrComment(root, nameWithOwner, number);
  const payloadPath = writeCommentPayload(body);
  try {
    if (existing) {
      const update = runCommand("gh", ["api", `repos/${nameWithOwner}/issues/comments/${existing.id}`, "--method", "PATCH", "--input", payloadPath], {
        cwd: root,
        timeout: 30000,
      });
      if (!update.ok) {
        throw new Error(cleanCommandError(update, "gh api comment update failed"));
      }
      const parsed = JSON.parse(update.stdout || "{}");
      return {
        ok: true,
        action: "updated",
        id: parsed.id ?? existing.id,
        url: parsed.html_url ?? existing.html_url,
      };
    }

    const create = runCommand("gh", ["api", `repos/${nameWithOwner}/issues/${number}/comments`, "--method", "POST", "--input", payloadPath], {
      cwd: root,
      timeout: 30000,
    });
    if (!create.ok) {
      throw new Error(cleanCommandError(create, "gh api comment create failed"));
    }
    const parsed = JSON.parse(create.stdout || "{}");
    return {
      ok: true,
      action: "created",
      id: parsed.id,
      url: parsed.html_url,
    };
  } finally {
    safeUnlink(payloadPath);
  }
}

/**
 * @param {string} root
 * @param {string} nameWithOwner
 * @param {string|number} number
 * @returns {{ id: string|number, html_url?: string } | undefined}
 */
function findExistingPrComment(root, nameWithOwner, number) {
  const comments = runCommand("gh", ["api", `repos/${nameWithOwner}/issues/${number}/comments?per_page=100`], {
    cwd: root,
    timeout: 30000,
  });
  if (!comments.ok || !comments.stdout.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(comments.stdout).find((/** @type {any} */ comment) => {
      const body = String(comment.body ?? "");
      return body.includes(prCommentMarker);
    });
  } catch {
    return undefined;
  }
}

/**
 * @param {string} body
 * @returns {string}
 */
function writeCommentPayload(body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "solumbe-comment-"));
  const payloadPath = path.join(directory, "body.json");
  fs.writeFileSync(payloadPath, JSON.stringify({ body }));
  return payloadPath;
}

/** @param {string} filePath */
function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // Best effort cleanup for a temp file.
  }
}

/**
 * @param {string} root
 * @param {string|number} number
 * @returns {any[]}
 */
function loadGhReviewComments(root, number) {
  const repo = runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: root, timeout: 20000 });
  if (!repo.ok) {
    return [];
  }

  try {
    const nameWithOwner = JSON.parse(repo.stdout).nameWithOwner;
    if (!nameWithOwner) {
      return [];
    }

    const comments = runCommand("gh", ["api", `repos/${nameWithOwner}/pulls/${number}/comments`, "--paginate"], {
      cwd: root,
      timeout: 30000,
    });
    if (!comments.ok || !comments.stdout.trim()) {
      return [];
    }
    return JSON.parse(comments.stdout);
  } catch {
    return [];
  }
}

/**
 * @param {string} root
 * @param {PrReviewOptions} options
 * @param {PrMetadata} pr
 * @returns {string}
 */
function resolveBaseRef(root, options, pr) {
  const candidates = [options.base, pr.baseRefName, upstreamRef(root), "origin/main", "main", "origin/master", "master", "HEAD~1"].filter(Boolean).map(String);

  for (const candidate of candidates) {
    if (refExists(root, candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not resolve a base ref. Pass --base <ref>.");
}

/**
 * @param {string} root
 * @returns {string | undefined}
 */
function upstreamRef(root) {
  const result = runCommand("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: root,
    timeout: 5000,
  });
  return result.ok ? result.stdout.trim() : undefined;
}

/**
 * @param {string} root
 * @param {string} ref
 * @returns {boolean}
 */
function refExists(root, ref) {
  return runCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, timeout: 5000 }).ok;
}

/**
 * @param {string} root
 * @param {string} base
 * @param {string} head
 * @returns {DiffResult}
 */
function getDiff(root, base, head) {
  const comparison = `${base}...${head}`;
  const nameStatus = runCommand("git", ["diff", "--name-status", "--find-renames", comparison], { cwd: root });
  const numstat = runCommand("git", ["diff", "--numstat", "--find-renames", comparison], { cwd: root });
  const shortstat = runCommand("git", ["diff", "--shortstat", comparison], { cwd: root });

  if (nameStatus.ok) {
    const files = parseNameStatus(nameStatus.stdout);
    if (files.length || head !== "HEAD") {
      const stats = parseNumstat(numstat.stdout);
      return {
        mode: "merge-base",
        files,
        numstat: stats.files,
        insertions: stats.insertions,
        deletions: stats.deletions,
        shortstat: shortstat.stdout.trim(),
      };
    }
  }

  const fallback = runCommand("git", ["diff", "--name-status", "--find-renames", "HEAD"], { cwd: root });
  if (!fallback.ok) {
    throw new Error(cleanCommandError(nameStatus, "git diff failed"));
  }

  const fallbackNumstat = runCommand("git", ["diff", "--numstat", "--find-renames", "HEAD"], { cwd: root });
  const fallbackShortstat = runCommand("git", ["diff", "--shortstat", "HEAD"], { cwd: root });
  const stats = parseNumstat(fallbackNumstat.stdout);
  const fallbackFiles = includeUntrackedFiles(root, parseNameStatus(fallback.stdout), stats.files);
  const insertions = sumStats(stats.files, "additions");
  const deletions = sumStats(stats.files, "deletions");
  if (!fallbackFiles.length) {
    return {
      mode: "merge-base",
      files: [],
      numstat: new Map(),
      insertions: 0,
      deletions: 0,
      shortstat: shortstat.stdout.trim(),
    };
  }

  return {
    mode: "working-tree",
    files: fallbackFiles,
    numstat: stats.files,
    insertions,
    deletions,
    shortstat: formatShortstat(fallbackFiles.length, insertions, deletions, fallbackShortstat.stdout.trim()),
    fallbackReason: `no committed diff found for ${comparison}; used working tree diff from HEAD`,
  };
}

/**
 * @param {string} root
 * @param {DiffFileEntry[]} files
 * @param {Map<string, NumstatEntry>} stats
 * @returns {DiffFileEntry[]}
 */
function includeUntrackedFiles(root, files, stats) {
  const result = [...files];
  const seen = new Set(result.map((file) => file.path));
  const untracked = runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, timeout: 5000 });
  if (!untracked.ok) {
    return result;
  }

  for (const filePath of untracked.stdout.trim().split("\n").filter(Boolean)) {
    if (seen.has(filePath)) {
      continue;
    }
    result.push({ status: "A", path: filePath });
    stats.set(filePath, { additions: countFileLines(path.join(root, filePath)), deletions: 0 });
  }
  return result;
}

/**
 * @param {string} filePath
 * @returns {number}
 */
function countFileLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (!text) {
      return 0;
    }
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * @param {Map<string, NumstatEntry>} stats
 * @param {'additions' | 'deletions'} key
 * @returns {number}
 */
function sumStats(stats, key) {
  let total = 0;
  for (const item of stats.values()) {
    total += item[key] ?? 0;
  }
  return total;
}

/**
 * @param {number} fileCount
 * @param {number} insertions
 * @param {number} deletions
 * @param {string} fallback
 * @returns {string}
 */
function formatShortstat(fileCount, insertions, deletions, fallback) {
  if (!fileCount) {
    return fallback;
  }
  return `${fileCount} file(s) changed, ${insertions} insertion(s), ${deletions} deletion(s)`;
}

/**
 * @param {string} output
 * @returns {DiffFileEntry[]}
 */
function parseNameStatus(output) {
  const entries = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((/** @type {string} */ line) => {
      const parts = line.split("\t");
      const rawStatus = parts[0] ?? "";
      const status = rawStatus[0] ?? "X";
      if (status === "R" || status === "C") {
        return {
          status,
          score: rawStatus.slice(1) || undefined,
          previousPath: parts[1],
          path: parts[2],
        };
      }
      return {
        status,
        path: parts[1],
      };
    })
    .filter((file) => file.path);
  // The filter above guarantees `path` is set; cast since the predicate is not
  // a TS type guard.
  return /** @type {DiffFileEntry[]} */ (entries);
}

/**
 * @param {string} output
 * @returns {{ files: Map<string, NumstatEntry>, insertions: number, deletions: number }}
 */
function parseNumstat(output) {
  /** @type {Map<string, NumstatEntry>} */
  const files = new Map();
  let insertions = 0;
  let deletions = 0;

  for (const line of output.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const additions = parseStatNumber(parts[0]);
    const removals = parseStatNumber(parts[1]);
    const filePath = parts.slice(2).join("\t");
    const normalizedPath = normalizeNumstatPath(filePath);
    insertions += additions;
    deletions += removals;
    files.set(normalizedPath, { additions, deletions: removals });
  }

  return { files, insertions, deletions };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function normalizeNumstatPath(filePath) {
  const renameMatch = filePath.match(/^(.*) => (.*)$/);
  if (!renameMatch) {
    return filePath;
  }

  const before = renameMatch[1].replace(/^{/, "");
  const after = renameMatch[2].replace(/}$/, "");
  const sharedPrefix = before.slice(0, before.lastIndexOf("/") + 1);
  return `${sharedPrefix}${after}`;
}

/**
 * @param {string | undefined} value
 * @returns {number}
 */
function parseStatNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {DiffFileEntry[]} files
 * @param {Map<string, NumstatEntry>} numstat
 * @param {ReturnType<typeof generateCodeMap>} codeMap
 * @returns {EnrichedFile[]}
 */
function enrichChangedFiles(files, numstat, codeMap) {
  const byPath = new Map(codeMap.files.map((file) => [file.path, file]));
  return files.map((file) => {
    const codeInfo = file.previousPath ? (byPath.get(file.path) ?? byPath.get(file.previousPath)) : byPath.get(file.path);
    const stats = numstat.get(file.path) ?? (file.previousPath ? numstat.get(file.previousPath) : undefined) ?? { additions: 0, deletions: 0 };
    /** @type {EnrichedFile} */
    const enriched = {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      statusName: /** @type {Record<string, string>} */ (statusNames)[file.status] ?? file.status,
      additions: stats.additions,
      deletions: stats.deletions,
      kind: codeInfo?.kind ?? inferBasicKind(file.path),
      domain: codeInfo?.domain ?? inferBasicDomain(file.path),
      route: codeInfo?.route,
      controllerBasePath: codeInfo?.controllerBasePath,
      httpMethods: codeInfo?.httpMethods ?? [],
      imports: codeInfo?.imports?.slice(0, 20) ?? [],
      exports: codeInfo?.exports?.slice(0, 20) ?? [],
      symbols: codeInfo?.symbols?.slice(0, 20) ?? [],
    };
    enriched.riskFlags = inferFileRiskFlags(enriched);
    return enriched;
  });
}

/**
 * @param {string} file
 * @returns {string}
 */
function inferBasicKind(file) {
  const base = path.basename(file);
  const extension = path.extname(file).toLowerCase();
  if (isTestFilePath(file)) return "test";
  if (file.includes("/app/api/") && base === "route.ts") return "apiRoute";
  if (base === "page.tsx" || base === "page.ts" || base === "layout.tsx" || base === "layout.ts") return "route";
  if (base.endsWith(".controller.ts")) return "controller";
  if (base.endsWith(".service.ts")) return "service";
  if (base.endsWith(".module.ts")) return "module";
  if (base.endsWith(".dto.ts")) return "dto";
  if (base.endsWith(".schema.ts") || file.includes("/schemas/") || extension === ".prisma") return "schema";
  if (extension === ".sql") return "migration";
  if (base.startsWith("use") && /\.(ts|tsx)$/.test(base)) return "hook";
  if (file.startsWith("redux/apis/") || file.startsWith("services/") || base.includes("api-client")) return "apiClient";
  if (/^[A-Z]/.test(base) && /\.(tsx|jsx)$/.test(base)) return "component";
  if (["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].includes(base)) return "dependency";
  if ([".toml", ".yml", ".yaml"].includes(extension) || base.includes("config") || file.startsWith(".codex/")) return "config";
  return "source";
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isTestFilePath(file) {
  const normalized = file.replaceAll("\\", "/");
  return /(^|\/)(__tests__|test|tests)(\/|$)/.test(normalized) || /\.(spec|test)\.[jt]sx?$/.test(normalized) || /(^|\/)[^/]+_test\.go$/.test(normalized);
}

/**
 * @param {string} file
 * @returns {string}
 */
function inferBasicDomain(file) {
  const parts = file.split("/");
  const interestingRoots = new Set(["app", "src", "components", "lib", "utils", "redux", "services", "schemas", "hooks", "types"]);
  if (interestingRoots.has(parts[0]) && parts[1]) {
    return cleanDomain(parts[1]);
  }
  return cleanDomain(parts[0] ?? "root");
}

/**
 * @param {string} value
 * @returns {string}
 */
function cleanDomain(value) {
  return (
    value
      .replace(/\.[cm]?[jt]sx?$/, "")
      .replace(/-api$/, "")
      .replace(/-apis$/, "")
      .replace(/-service$/, "")
      .replace(/[()[\]]/g, "")
      .replace(/^\.+$/, "root") || "root"
  );
}

// Risk classification is delegated to the shared classifier in risk-paths.js
// so PR review and the merge gates agree on the same diff. This also removes
// the old raw-substring regexes here, which produced false positives such as
// `tokens.js` → auth/security (via the bare substring "token").
/**
 * @param {EnrichedFile} file
 * @returns {string[]}
 */
function inferFileRiskFlags(file) {
  return classifyPath(file.path, {
    kind: file.kind,
    additions: file.additions,
    deletions: file.deletions,
  });
}

/**
 * @param {EnrichedFile[]} files
 * @returns {{ name: string, fileCount: number, additions: number, deletions: number, kinds: { kind: string, count: number }[] }[]}
 */
function summarizeDomains(files) {
  /** @type {Map<string, { name: string, fileCount: number, additions: number, deletions: number, kinds: Map<string, number> }>} */
  const domains = new Map();
  for (const file of files) {
    const domain = domains.get(file.domain) ?? {
      name: file.domain,
      fileCount: 0,
      additions: 0,
      deletions: 0,
      kinds: new Map(),
    };
    domain.fileCount += 1;
    domain.additions += file.additions;
    domain.deletions += file.deletions;
    domain.kinds.set(file.kind, (domain.kinds.get(file.kind) ?? 0) + 1);
    domains.set(file.domain, domain);
  }

  return [...domains.values()]
    .map((domain) => ({
      name: domain.name,
      fileCount: domain.fileCount,
      additions: domain.additions,
      deletions: domain.deletions,
      kinds: [...domain.kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    }))
    .sort((a, b) => b.fileCount - a.fileCount || b.additions + b.deletions - (a.additions + a.deletions) || a.name.localeCompare(b.name));
}

/**
 * @param {PrMetadata} pr
 * @returns {ReviewComments}
 */
function normalizeReviewComments(pr) {
  /** @type {ReviewCommentItem[]} */
  const items = [];
  for (const comment of pr.reviewComments ?? []) {
    items.push({
      type: "review_comment",
      author: comment.user?.login,
      path: comment.path,
      line: comment.line ?? comment.original_line,
      body: compactText(comment.body),
      url: comment.html_url,
    });
  }

  for (const comment of pr.comments ?? []) {
    items.push({
      type: "comment",
      author: comment.author?.login ?? comment.author?.name,
      body: compactText(comment.body),
      url: comment.url,
    });
  }

  for (const review of pr.reviews ?? []) {
    if (!review.body) {
      continue;
    }
    items.push({
      type: "review",
      author: review.author?.login ?? review.author?.name,
      state: review.state,
      body: compactText(review.body),
      url: review.url,
    });
  }

  return {
    count: items.length,
    items,
  };
}

/**
 * @param {EnrichedFile[]} files
 * @param {DiffResult} diff
 * @param {ReviewComments} comments
 * @returns {RiskSummary}
 */
function inferRisk(files, diff, comments) {
  /** @type {Set<string>} */
  const flags = new Set();
  let score = 0;
  const nonTestFiles = files.filter((file) => file.kind !== "test");
  const behaviorFiles = nonTestFiles.filter((file) => !["config", "dependency"].includes(file.kind));
  const testFiles = files.filter((file) => file.kind === "test");

  // Risk flags come from non-test files only. `tests/checkout.spec.ts` is a
  // test for a payment flow, not a payment flow: scoring it as `money flow`
  // told a reviewer to "verify idempotency, webhook behavior and refunds" for
  // a diff that touched one spec file. The shared classifier says the same —
  // `isGateRiskPath` exists precisely so a checkout spec does not trip the
  // money-flow gate — but that filter sat on the gate path while this scoring
  // path collected flags from every file. Test files still count for the
  // `no test files changed` rule and the tests-present credit below.
  for (const file of nonTestFiles) {
    for (const flag of /** @type {string[]} */ (file.riskFlags)) {
      flags.add(flag);
    }
  }

  // Per-flag weights live in risk-paths.js so `solumbe calibrate` can report a
  // measured lift beside the weight the flag actually carries. `dependency`
  // weighs zero there: across two corpora it lifts 0.53x and 1.05x — no
  // consistent signal in either direction — and the +2 it used to carry as
  // `configuration` inverted the band ordering, making `medium` changes less
  // likely to be repaired than `low` at every window from 7 to 90 days.
  // Ordering is monotonic on all three corpora measured since. See
  // docs/17-calibration-thesis.
  for (const [flag, weight] of Object.entries(RISK_SCORE_WEIGHTS)) {
    if (flags.has(flag)) score += weight;
  }

  if (diff.insertions + diff.deletions >= 800) {
    flags.add("large PR");
    score += 2;
  }
  if (behaviorFiles.length > 0 && testFiles.length === 0) {
    flags.add("no test files changed");
    score += 2;
  }
  if (comments.count > 0) {
    flags.add("has PR discussion to resolve");
    score += Math.min(comments.count, 3);
  }
  if (testFiles.length > 0) {
    score = Math.max(0, score - 1);
  }

  return {
    level: score >= 9 ? "high" : score >= 4 ? "medium" : "low",
    score,
    flags: [...flags].sort(),
  };
}

/**
 * @param {ReturnType<typeof inspectRepo>} repo
 * @param {EnrichedFile[]} files
 * @param {RiskSummary} risk
 * @returns {TestHint[]}
 */
function inferTestHints(repo, files, risk) {
  if (!files.length) {
    return [];
  }

  /** @type {Record<string, string>} */
  const scripts = repo.scripts ?? {};
  const runner = packageRunner(repo.packageManagers);
  /** @type {TestHint[]} */
  const hints = [];

  for (const name of selectScripts(scripts, preferredScripts)) {
    const reason = reasonForScript(name, files, risk);
    if (!reason) {
      continue;
    }
    hints.push({
      script: name,
      command: commandForScript(runner, name),
      reason,
    });
  }

  if (repo.packageManagers?.includes("go") && files.some((file) => file.path.endsWith(".go"))) {
    hints.push({
      command: "go test ./...",
      reason: "verify Go packages touched by the diff",
    });
  }

  return uniqueBy(hints, (hint) => hint.command).slice(0, 6);
}

/**
 * @param {EnrichedFile[]} files
 * @returns {ReviewTargets}
 */
function inferReviewTargets(files) {
  return {
    routes: files.flatMap(routeTargetsForFile).slice(0, 100),
    symbols: files
      .filter((file) => file.symbols.length)
      .map((file) => ({
        file: file.path,
        symbols: file.symbols.slice(0, 12).map((symbol) => `${symbol.type} ${symbol.name}`),
      }))
      .slice(0, 100),
    configFiles: files.filter((file) => file.kind === "config" || /** @type {string[]} */ (file.riskFlags).includes("configuration")).map((file) => file.path),
    testFiles: files.filter((file) => file.kind === "test").map((file) => file.path),
  };
}

/**
 * @param {EnrichedFile} file
 * @returns {RouteTarget[]}
 */
function routeTargetsForFile(file) {
  if (file.route) {
    return [{ file: file.path, route: file.route }];
  }
  if (!file.httpMethods.length) {
    return [];
  }
  return file.httpMethods.map((method) => ({
    file: file.path,
    method: method.method,
    route: combineRoute(file.controllerBasePath, method.path),
  }));
}

/**
 * @param {string} name
 * @param {EnrichedFile[]} files
 * @param {RiskSummary} risk
 * @returns {string | undefined}
 */
function reasonForScript(name, files, risk) {
  const changedKinds = new Set(files.map((file) => file.kind));
  const hasTypedSource = files.some((file) => /\.[cm]?[jt]sx?$/.test(file.path));
  const hasRuntimeSource =
    hasTypedSource ||
    files.some((file) => ["route", "apiRoute", "controller", "service", "module", "component", "hook", "apiClient", "dto", "schema"].includes(file.kind));
  if (isTypeCheckScript(name)) return hasTypedSource ? "TypeScript contracts changed" : undefined;
  if (name.includes("lint")) return hasRuntimeSource ? "changed source files should pass style/static checks" : undefined;
  if (name === "build")
    return hasRuntimeSource && (changedKinds.has("route") || changedKinds.has("component") || risk.level !== "low")
      ? "build catches integration and bundling issues"
      : undefined;
  if (name.includes("e2e"))
    return risk.flags.some((flag) => ["request surface", "money flow", "auth/security"].includes(flag)) ? "request/user-flow surface changed" : undefined;
  if (name.includes("test")) return hasRuntimeSource ? "verify behavior around changed domains" : undefined;
  return undefined;
}

/**
 * @param {string[]} [packageManagers]
 * @returns {string}
 */
function packageRunner(packageManagers = []) {
  if (packageManagers.includes("pnpm")) return "pnpm";
  if (packageManagers.includes("yarn")) return "yarn";
  if (packageManagers.includes("bun")) return "bun";
  return "npm";
}

/**
 * @param {string} runner
 * @param {string} script
 * @returns {string}
 */
function commandForScript(runner, script) {
  if (runner === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  return `${runner} ${script}`;
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown} keyFn
 * @returns {T[]}
 */
function uniqueBy(items, keyFn) {
  const seen = new Set();
  /** @type {T[]} */
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * @param {string | null | undefined} basePath
 * @param {string | null | undefined} methodPath
 * @returns {string}
 */
function combineRoute(basePath, methodPath) {
  const base = normalizeRoutePart(basePath);
  const child = normalizeRoutePart(methodPath);
  return `/${[base, child].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRoutePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^:$/, "");
}

/**
 * @param {EnrichedFile} file
 * @returns {string}
 */
function formatFileCell(file) {
  if (file.previousPath) {
    return `${file.previousPath} -> ${file.path}`;
  }
  return file.path;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function compactText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * @param {import('./tools.js').RunResult} result
 * @param {string} fallback
 * @returns {string}
 */
function cleanCommandError(result, fallback) {
  const message = `${result.stderr || result.stdout || result.error?.message || fallback}`.trim();
  return message.split("\n")[0] || fallback;
}
