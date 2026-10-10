// GitHub PR merge-readiness gate ported from
// pullpass/internal/githubpr/evaluate.go. Drives `gh` through a small Runner
// abstraction so tests can swap in canned responses.

/// <reference types="node" />

import path from "node:path";
import * as codeowners from "./codeowners.js";
import { defaultGhRunner } from "./gh.js";
import { convergenceCheck, gitRoot, gitShowContent, migrationCheck, scopeContractCheck, secretCheck } from "./pass-local.js";
import { aggregateVerdict, normalizeGovernance, normalizeProfile, policyCheck, STATUS } from "./policy.js";
import { checkRelease } from "./release-check.js";
import { matchRiskPaths } from "./risk-paths.js";
import { estimateTokens } from "./tokens.js";
import { runCommand } from "./tools.js";

/** @typedef {import('./pass-local.js').Check} Check */
/** @typedef {import('./pass-local.js').Verdict} Verdict */

/**
 * Minimal Runner interface for the `gh` CLI. `run` returns stdout (string)
 * and throws on failure (the thrown Error may carry stderr/stdout).
 * Mirrors the runner returned by `defaultGhRunner()` in gh.js.
 * @typedef {{ run: (cwd: string | undefined, args: string[]) => string }} Runner
 */

/**
 * `gh pr view` review entry (subset of fields used here).
 * @typedef {{ author?: { login?: string }, state?: string }} PrReview
 */

/**
 * One entry from `statusCheckRollup` plus optionally-enriched annotations.
 * gh only returns the fields requested, so all are optional.
 * @typedef {Object} StatusCheck
 * @property {string} [name]
 * @property {string} [context]
 * @property {string} [workflowName]
 * @property {string} [conclusion]
 * @property {string} [status]
 * @property {string} [state]
 * @property {string} [detailsUrl]
 * @property {{ message?: string }[]} [annotations]
 */

/**
 * A GraphQL review thread node (subset).
 * @typedef {Object} ReviewThread
 * @property {boolean} [isResolved]
 * @property {string} [path]
 * @property {number} [line]
 * @property {number} [startLine]
 * @property {{ nodes?: { author?: { login?: string }, url?: string }[] }} [comments]
 */

/**
 * Loosely-typed `gh api .../protection` response (subset of fields used here).
 * @typedef {Object} BranchProtectionPayload
 * @property {{ required_approving_review_count?: number, require_code_owner_reviews?: boolean }} [required_pull_request_reviews]
 * @property {{ contexts?: unknown[], checks?: unknown[] }} [required_status_checks]
 * @property {{ enabled?: boolean }} [required_conversation_resolution]
 * @property {{ enabled?: boolean }} [allow_force_pushes]
 * @property {{ enabled?: boolean }} [allow_deletions]
 */

/**
 * A CODEOWNERS team owner descriptor as produced by codeowners.teamOwners.
 * @typedef {{ org: string, slug: string, owner: string }} TeamOwner
 */

/**
 * Loosely-typed `gh pr view --json ...` response. Fields are optional because
 * gh only returns the JSON fields requested and they may be absent.
 * @typedef {Object} PR
 * @property {number} [number]
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [baseRefName]
 * @property {string} [baseRefOid]
 * @property {string} [headRefName]
 * @property {string} [headRefOid]
 * @property {number} [changedFiles]
 * @property {string} [state] OPEN, CLOSED or MERGED
 * @property {string | null} [mergedAt]
 * @property {boolean} [isDraft]
 * @property {string} [mergeStateStatus]
 * @property {string} [mergeable]
 * @property {string} [reviewDecision]
 * @property {{ path: string }[]} [files]
 * @property {any[]} [reviews]
 * @property {any[]} [statusCheckRollup]
 */

const passPrEngineVersion = 2;
const PR_BASE_LABEL = "GitHub PR";

/**
 * @param {string} repoPath
 * @param {string} selector
 * @param {{ policy?: unknown, governance?: unknown, runner?: Runner, request?: string, minConvergence?: number | string, receipt?: string, intent?: unknown }} [options]
 */
export async function evaluatePR(repoPath, selector, options = {}) {
  const profile = normalizeProfile(options.policy);
  const governance = normalizeGovernance(options.governance);
  const runner = options.runner ?? defaultGhRunner();

  const root = gitRoot(repoPath);
  const pr = viewPR(root, selector, runner);
  pr.statusCheckRollup = enrichStatusCheckAnnotations(root, pr.statusCheckRollup ?? [], runner);

  const files = (pr.files ?? []).map((entry) => entry.path).filter((/** @type {string} */ p) => p && p.trim());
  const subject = pullRequestSubject(pr);
  const filesComplete = Number.isInteger(pr.changedFiles) && pr.changedFiles === files.length;
  const subjectError = !subject
    ? "GitHub did not return valid immutable base and head commit IDs for this pull request."
    : !filesComplete
      ? `GitHub reported ${pr.changedFiles ?? "an unknown number of"} changed files but returned ${files.length}; an exact receipt requires the complete file set.`
      : "";

  // Content-aware secret scanning needs the PR head blobs. They are present
  // whenever the head commit has been fetched locally; when it has not, the
  // reader returns null and the check degrades to its path-only half rather
  // than reporting a clean scan it did not perform.
  /** @param {string} file */
  const prHeadContent = (file) => (subject?.headSha ? gitShowContent(root, String(subject.headSha), file) : null);

  const checks = [
    prStateCheck(pr),
    pullRequestSnapshotCheck(subject, filesComplete, subjectError),
    changedFilesCheck(files),
    secretCheck(files, prHeadContent),
    riskCheck(files),
    ...migrationCheck(files, prHeadContent),
    checkRelease(root, files, {
      baseContent: prBaseContent(root, pr.baseRefOid, pr.baseRefName),
      // The PR's own head blobs, when fetched; the checkout is read otherwise.
      headContent: prHeadContent,
      governance,
      headRefName: pr.headRefName,
    }),
    reviewDecisionCheck(pr.reviewDecision, governance),
    codeownersCheckPR(root, files, pr.reviews ?? [], runner, governance),
    unresolvedConversationsCheck(root, pr.number, runner),
    branchProtectionCheck(root, pr.baseRefName, runner),
    statusChecksCheck(pr.statusCheckRollup ?? []),
  ];
  const exactDiff = { subject, subjectError, diffFiles: files, expectedHead: subject?.headSha, requireClean: true };
  const convergenceBase = subject?.baseSha ?? localBaseRef(root, pr.baseRefName);
  const contract = scopeContractCheck(root, convergenceBase, options.request, options.intent, exactDiff);
  if (contract) checks.push(contract.check);
  const convergence = convergenceCheck(root, convergenceBase, options.request ?? contract?.request, options.minConvergence, options.receipt, {
    ...exactDiff,
    declared: contract?.declared,
  });
  if (convergence) checks.push(convergence);
  checks.push(policyCheck({ profile, governance, files, checks, remote: true }));

  /** @type {Record<string, unknown> & { tokenEstimate?: { fullJson: number } }} */
  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    passPrEngineVersion,
    verdict: aggregateVerdict(checks),
    repo: { root, name: path.basename(root) },
    base: PR_BASE_LABEL,
    pr: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      baseRefName: pr.baseRefName,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      state: pr.state ?? "",
      mergedAt: pr.mergedAt ?? "",
      isDraft: Boolean(pr.isDraft),
      mergeStateStatus: pr.mergeStateStatus ?? "",
      mergeable: pr.mergeable ?? "",
      reviewDecision: pr.reviewDecision ?? "",
    },
    policy: profile,
    governance,
    request: options.request ?? "",
    contextEvidence: contextEvidence(pr, options.request),
    changedFiles: files,
    checks,
  };
  if (subject) data.subject = subject;
  if (contract?.check.contract) data.contract = contract.check.contract;
  if (convergence?.receipt) {
    data.convergence = convergence.convergence;
    data.band = convergence.band;
    data.receipt = convergence.receipt;
  }
  data.tokenEstimate = { fullJson: estimateTokens(data) };
  return data;
}

/**
 * Resolve a locally available ref for the PR base so convergence can compare
 * the checked-out diff with the same branch the PR targets.
 * @param {string} root
 * @param {string | undefined} baseRefName
 * @returns {string | null}
 */
function localBaseRef(root, baseRefName) {
  const candidates = [];
  if (baseRefName) candidates.push(`origin/${baseRefName}`, baseRefName);
  candidates.push("origin/main", "main", "HEAD");
  for (const candidate of candidates) {
    const result = runCommand("git", ["rev-parse", "--verify", candidate], { cwd: root });
    if (result.ok) return candidate;
  }
  return null;
}

// Resolve version-file content at the PR base for release-discipline scoping.
// Tries the remote-tracking ref first, then the local branch; null when the
// base isn't fetched locally, in which case release discipline stays strict.
/**
 * @param {string} root
 * @param {string | undefined} baseRefOid
 * @param {string | undefined} baseRefName
 * @returns {((file: string) => string | null) | undefined}
 */
function prBaseContent(root, baseRefOid, baseRefName) {
  if (!baseRefOid && !baseRefName) return undefined;
  const fallbackRefs = baseRefName ? [`origin/${baseRefName}`, baseRefName] : [];
  return (/** @type {string} */ file) => {
    if (baseRefOid) return gitShowContent(root, baseRefOid, file);
    for (const ref of fallbackRefs) {
      const content = gitShowContent(root, ref, file);
      if (content != null) return content;
    }
    return null;
  };
}

/**
 * @param {string} root
 * @param {string} selector
 * @param {Runner} runner
 * @returns {PR}
 */
function viewPR(root, selector, runner) {
  const args = ["pr", "view"];
  if (selector && String(selector).trim()) args.push(String(selector));
  args.push(
    "--json",
    "number,title,url,state,mergedAt,baseRefName,baseRefOid,headRefName,headRefOid,changedFiles,isDraft,mergeStateStatus,mergeable,reviewDecision,files,reviews,statusCheckRollup",
  );
  const out = runner.run(root, args);
  try {
    return JSON.parse(out);
  } catch (/** @type {any} */ error) {
    throw new Error(`parse gh pr view response: ${error.message ?? String(error)}`, { cause: error });
  }
}

/**
 * @param {PR} pr
 * @returns {{ kind: string, repository: string, number: number, baseSha: string, headSha: string } | null}
 */
function pullRequestSubject(pr) {
  const baseSha = String(pr.baseRefOid ?? "").trim();
  const headSha = String(pr.headRefOid ?? "").trim();
  if (!isObjectId(baseSha) || !isObjectId(headSha)) return null;
  const repository = repositoryFromUrl(pr.url);
  const number = Number(pr.number);
  if (!repository || !Number.isSafeInteger(number) || number <= 0) return null;
  return { kind: "github-pr", repository, number, baseSha, headSha };
}

/**
 * @param {{ kind: string, repository: string, number: number, baseSha: string, headSha: string } | null} subject
 * @param {boolean} filesComplete
 * @param {string} error
 * @returns {Check}
 */
function pullRequestSnapshotCheck(subject, filesComplete, error) {
  if (!subject || !filesComplete) return { name: "PR snapshot", status: STATUS.warn, summary: error };
  return {
    name: "PR snapshot",
    status: STATUS.pass,
    summary: "GitHub returned exact base/head commits and the complete changed-file set.",
    details: [`Base: ${subject.baseSha}`, `Head: ${subject.headSha}`],
  };
}

/** @param {string} value @returns {boolean} */
function isObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
}

/** @param {string | undefined} value @returns {string} */
function repositoryFromUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.hostname.toLowerCase() !== "github.com") return "";
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
  } catch {
    return "";
  }
}

/**
 * @param {string} root
 * @param {Runner} runner
 * @returns {string}
 */
function nameWithOwner(root, runner) {
  const out = runner.run(root, ["repo", "view", "--json", "nameWithOwner"]);
  try {
    const parsed = JSON.parse(out);
    const value = String(parsed?.nameWithOwner ?? "").trim();
    if (!value) throw new Error("gh repo view returned empty nameWithOwner");
    return value;
  } catch (/** @type {any} */ error) {
    throw new Error(`parse gh repo view response: ${error.message ?? String(error)}`, { cause: error });
  }
}

/**
 * @param {string[]} files
 * @returns {Check}
 */
function changedFilesCheck(files) {
  if (files.length === 0) return { name: "Changed files", status: STATUS.warn, summary: "No changed files reported for this PR." };
  return {
    name: "Changed files",
    status: STATUS.pass,
    summary: `${files.length} changed file${files.length === 1 ? "" : "s"} reported.`,
    details: files.slice(0, 20),
  };
}

/**
 * @param {string[]} files
 * @returns {Check}
 */
function riskCheck(files) {
  // Gate mode: ignore test files and documentation. A `checkout.spec.ts` test
  // or a `git-checkout-guide.md` doc is risk-adjacent for ranking purposes but
  // must not, on its own, force an explicit-review warning at merge time.
  const matches = matchRiskPaths(files, { gate: true });
  if (matches.length > 0) {
    return {
      name: "Risk review",
      status: STATUS.warn,
      summary: "Risk-sensitive files changed; maintainer review should be explicit.",
      details: matches.slice(0, 20),
    };
  }
  return { name: "Risk review", status: STATUS.pass, summary: "No obvious risk-sensitive file paths changed." };
}

/**
 * @param {PR} pr
 * @returns {Check}
 */
function prStateCheck(pr) {
  const details = [`#${pr.number ?? 0} ${pr.title ?? ""}`.trim()];
  if (pr.url) details.push(pr.url);

  // A merged or closed PR is settled, so read its state before mergeability:
  // GitHub reports a merged PR's mergeability as UNKNOWN and keeps a closed
  // PR's last value, which the branches below would read as still pending.
  // A merged PR still gets the review evidence checks, because they describe
  // what merged and post-merge attestation records them.
  const state = String(pr.state ?? "").toUpperCase();
  if (state === "MERGED") {
    if (pr.mergedAt) details.push(`Merged at ${pr.mergedAt}`);
    details.push("The other checks describe the merged change; they no longer gate it.");
    return { name: "PR state", status: STATUS.pass, summary: "PR is already merged; there is nothing left to gate.", details };
  }
  if (state === "CLOSED") {
    return { name: "PR state", status: STATUS.fail, summary: "PR is closed without merging and cannot merge unless it is reopened.", details };
  }
  if (pr.isDraft) {
    return { name: "PR state", status: STATUS.fail, summary: "PR is a draft and should not merge.", details };
  }
  const mergeable = String(pr.mergeable ?? "").toUpperCase();
  const mergeState = String(pr.mergeStateStatus ?? "").toUpperCase();
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") {
    return { name: "PR state", status: STATUS.fail, summary: "PR has merge conflicts.", details };
  }
  if (mergeable === "UNKNOWN" || mergeState === "UNKNOWN" || mergeState === "") {
    return { name: "PR state", status: STATUS.warn, summary: "GitHub mergeability is not settled yet.", details };
  }
  if (mergeState === "BLOCKED" || mergeState === "UNSTABLE") {
    return { name: "PR state", status: STATUS.warn, summary: "GitHub reports the PR is not clean to merge yet.", details: [...details, mergeState] };
  }
  return { name: "PR state", status: STATUS.pass, summary: "PR is not draft and has no reported merge conflicts.", details };
}

/**
 * @param {string | undefined} decision
 * @param {string} governance
 * @returns {Check}
 */
function reviewDecisionCheck(decision, governance) {
  switch (
    String(decision ?? "")
      .trim()
      .toUpperCase()
  ) {
    case "APPROVED":
      return { name: "Review decision", status: STATUS.pass, summary: "GitHub reports the PR is approved." };
    case "CHANGES_REQUESTED":
      return { name: "Review decision", status: STATUS.fail, summary: "GitHub reports requested changes." };
    case "REVIEW_REQUIRED":
      if (governance === "solo") {
        return {
          name: "Review decision",
          status: STATUS.warn,
          summary: "Solo-maintainer owner decision is required; no separate GitHub approval is recorded.",
          details: ["Record the owner/admin merge decision before merging.", "Use team governance when a separate reviewer is required."],
        };
      }
      return { name: "Review decision", status: STATUS.fail, summary: "A required human review is still missing." };
    case "":
      // GitHub returns no decision when the base branch requires no review:
      // there is nothing to read, which is not evidence against the change.
      return {
        name: "Review decision",
        status: STATUS.skipped,
        summary: "Not checked: GitHub did not return a review decision; verify required reviewers manually.",
      };
    default:
      return { name: "Review decision", status: STATUS.warn, summary: `Unrecognized review decision: ${decision}` };
  }
}

/**
 * @param {string} root
 * @param {string[]} files
 * @param {PrReview[]} reviews
 * @param {Runner} runner
 * @param {string} governance
 * @returns {Check}
 */
function codeownersCheckPR(root, files, reviews, runner, governance) {
  const loaded = codeowners.load(root);
  if (!loaded.ok) {
    if (loaded.missing) {
      return { name: "CODEOWNERS", status: STATUS.warn, summary: "No CODEOWNERS file found; ownership checks are unavailable." };
    }
    const loadError = /** @type {{ message?: string } | undefined} */ (loaded.error);
    return { name: "CODEOWNERS", status: STATUS.skipped, summary: `Not checked: could not read CODEOWNERS: ${loadError?.message ?? "unknown error"}` };
  }
  const ruleset = loaded.ruleset;
  if (ruleset.rules.length === 0) {
    return { name: "CODEOWNERS", status: STATUS.warn, summary: "CODEOWNERS exists but contains no usable owner rules.", details: [ruleset.path] };
  }

  const owned = codeowners.ownedFiles(ruleset, files);
  if (owned.length === 0) {
    return { name: "CODEOWNERS", status: STATUS.pass, summary: "No changed files matched CODEOWNERS.", details: [ruleset.path] };
  }

  const approved = approvedReviewers(reviews);
  const missing = [];
  const manual = [];

  for (const entry of owned) {
    const direct = codeowners.directUserOwners(entry.owners);
    if (direct.some((user) => approved.has(user.toLowerCase()))) continue;

    const detail = `${entry.path} -> ${entry.owners.join(", ")}`;
    const teams = codeowners.teamOwners(entry.owners);
    let teamApproved = false;
    const teamErrors = [];
    for (const team of teams) {
      try {
        if (teamHasApprovedReviewer(root, team, approved, runner)) {
          teamApproved = true;
          break;
        }
      } catch (/** @type {any} */ error) {
        teamErrors.push(`${detail} (${team.owner}: ${error.message ?? String(error)})`);
      }
    }
    if (teamApproved) continue;

    if (teamErrors.length > 0 || codeowners.hasExternalOwner(entry.owners)) {
      manual.push(detail, ...teamErrors);
      continue;
    }
    if (teams.length > 0) {
      missing.push(detail);
      continue;
    }
    if (codeowners.hasTeamOrExternalOwner(entry.owners)) {
      manual.push(detail);
      continue;
    }
    missing.push(detail);
  }

  if (missing.length > 0) {
    if (governance === "solo") {
      return {
        name: "CODEOWNERS",
        status: STATUS.warn,
        summary: "CODEOWNERS approval is missing; solo-maintainer mode requires an explicit owner/admin merge decision.",
        details: [...missing, "Use team governance when CODEOWNERS approval must come from a separate reviewer."],
      };
    }
    return { name: "CODEOWNERS", status: STATUS.fail, summary: "CODEOWNERS approval is missing for one or more changed files.", details: missing };
  }
  if (manual.length > 0) {
    return { name: "CODEOWNERS", status: STATUS.skipped, summary: "Not checked: some CODEOWNERS could not be verified automatically.", details: manual };
  }
  return { name: "CODEOWNERS", status: STATUS.pass, summary: "Changed files have verified CODEOWNERS approval.", details: [ruleset.path] };
}

/**
 * @param {PrReview[]} reviews
 * @returns {Set<string>}
 */
function approvedReviewers(reviews) {
  /** @type {Set<string>} */
  const approved = new Set();
  for (const review of reviews ?? []) {
    const login = String(review?.author?.login ?? "")
      .trim()
      .toLowerCase();
    if (!login) continue;
    const state = String(review?.state ?? "")
      .trim()
      .toUpperCase();
    if (state === "APPROVED") approved.add(login);
    else if (state === "CHANGES_REQUESTED" || state === "DISMISSED") approved.delete(login);
  }
  return approved;
}

/**
 * @param {string} root
 * @param {TeamOwner} team
 * @param {Set<string>} approved
 * @param {Runner} runner
 * @returns {boolean}
 */
function teamHasApprovedReviewer(root, team, approved, runner) {
  for (const login of [...approved].sort()) {
    if (teamMembership(root, team, login, runner)) return true;
  }
  return false;
}

/**
 * @param {string} root
 * @param {TeamOwner} team
 * @param {string} login
 * @param {Runner} runner
 * @returns {boolean}
 */
function teamMembership(root, team, login, runner) {
  const endpoint = `orgs/${encodeURIComponent(team.org)}/teams/${encodeURIComponent(team.slug)}/memberships/${encodeURIComponent(login)}`;
  let out;
  try {
    out = runner.run(root, ["api", endpoint]);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  try {
    const parsed = JSON.parse(out);
    return (
      String(parsed?.state ?? "")
        .trim()
        .toLowerCase() === "active"
    );
  } catch (/** @type {any} */ error) {
    throw new Error(`parse gh team membership response: ${error.message ?? String(error)}`, { cause: error });
  }
}

/**
 * @param {string} root
 * @param {number | undefined} prNumber
 * @param {Runner} runner
 * @returns {Check}
 */
function unresolvedConversationsCheck(root, prNumber, runner) {
  if (!prNumber) {
    return { name: "Review conversations", status: STATUS.warn, summary: "PR number is unavailable; review conversations could not be inspected." };
  }
  let threads;
  try {
    threads = reviewThreads(root, prNumber, runner);
  } catch (/** @type {any} */ error) {
    return { name: "Review conversations", status: STATUS.warn, summary: `Could not inspect review conversations: ${error.message ?? String(error)}` };
  }
  const unresolved = threads.filter((thread) => !thread.isResolved).map(threadDetail);
  if (unresolved.length > 0) {
    return { name: "Review conversations", status: STATUS.fail, summary: "Unresolved PR review conversations remain.", details: unresolved };
  }
  return { name: "Review conversations", status: STATUS.pass, summary: "No unresolved PR review conversations found." };
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          isResolved
          path
          line
          startLine
          comments(first: 1) {
            nodes {
              author { login }
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

/**
 * @param {string} root
 * @param {number} prNumber
 * @param {Runner} runner
 * @returns {ReviewThread[]}
 */
function reviewThreads(root, prNumber, runner) {
  const name = nameWithOwner(root, runner);
  const slash = name.indexOf("/");
  if (slash <= 0) throw new Error(`invalid nameWithOwner: ${name}`);
  const owner = name.slice(0, slash);
  const repo = name.slice(slash + 1);

  /** @type {ReviewThread[]} */
  const threads = [];
  let cursor = "";
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${repo}`, "-F", `number=${prNumber}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const out = runner.run(root, args);
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (/** @type {any} */ error) {
      throw new Error(`parse gh review threads response: ${error.message ?? String(error)}`, { cause: error });
    }
    const page = parsed?.data?.repository?.pullRequest?.reviewThreads ?? { nodes: [], pageInfo: { hasNextPage: false } };
    threads.push(...(page.nodes ?? []));
    if (!page.pageInfo?.hasNextPage) break;
    if (!page.pageInfo.endCursor) throw new Error("reviewThreads has next page but no endCursor");
    cursor = page.pageInfo.endCursor;
  }
  return threads;
}

/**
 * @param {ReviewThread} thread
 * @returns {string}
 */
function threadDetail(thread) {
  let location = thread.path ?? "";
  let line = thread.line ?? 0;
  if (!line) line = thread.startLine ?? 0;
  if (line > 0) location += `:${line}`;
  const first = thread.comments?.nodes?.[0];
  if (!first) return location;
  const author = String(first.author?.login ?? "").trim();
  if (author) location += ` by @${author}`;
  if (first.url) location += ` ${first.url}`;
  return location;
}

/**
 * @param {string | undefined} branch
 * @param {string} root
 * @param {Runner} runner
 * @returns {Check}
 */
function branchProtectionCheck(root, branch, runner) {
  const trimmed = String(branch ?? "").trim();
  if (!trimmed) {
    return {
      name: "Branch protection",
      status: STATUS.skipped,
      summary: "Not checked: the base branch is unavailable, so branch protection could not be inspected.",
    };
  }
  /** @type {BranchProtectionPayload | null} */
  let protection;
  let exists;
  try {
    ({ protection, exists } = branchProtection(root, trimmed, runner));
  } catch (/** @type {any} */ error) {
    return {
      name: "Branch protection",
      status: STATUS.skipped,
      summary: `Not checked: could not inspect branch protection: ${error.message ?? String(error)}`,
    };
  }
  if (!exists || !protection) {
    return { name: "Branch protection", status: STATUS.warn, summary: "Base branch is not protected.", details: [trimmed] };
  }

  /** @type {string[]} */
  const issues = [];
  const reviews = protection.required_pull_request_reviews;
  if (!reviews) {
    issues.push("Pull request reviews are not required.");
  } else {
    if ((reviews.required_approving_review_count ?? 0) < 1) issues.push("At least one approving review is not required.");
    if (!reviews.require_code_owner_reviews) issues.push("CODEOWNERS review is not required by branch protection.");
  }
  const statusChecks = protection.required_status_checks;
  const hasStatusContexts = (statusChecks?.contexts?.length ?? 0) > 0 || (statusChecks?.checks?.length ?? 0) > 0;
  if (!statusChecks || !hasStatusContexts) issues.push("Required status checks are not configured.");
  if (!protection.required_conversation_resolution?.enabled) issues.push("Conversation resolution is not required by branch protection.");
  if (protection.allow_force_pushes?.enabled) issues.push("Force pushes are allowed.");
  if (protection.allow_deletions?.enabled) issues.push("Branch deletion is allowed.");

  if (issues.length > 0) {
    return { name: "Branch protection", status: STATUS.warn, summary: "Branch protection is present but missing recommended safeguards.", details: issues };
  }
  return {
    name: "Branch protection",
    status: STATUS.pass,
    summary: "Base branch protection requires reviews, status checks, CODEOWNERS, and conversation resolution.",
    details: [trimmed],
  };
}

/**
 * @param {string} root
 * @param {string} branch
 * @param {Runner} runner
 * @returns {{ protection: BranchProtectionPayload | null, exists: boolean }}
 */
function branchProtection(root, branch, runner) {
  const name = nameWithOwner(root, runner);
  const slash = name.indexOf("/");
  if (slash <= 0) throw new Error(`invalid nameWithOwner: ${name}`);
  const owner = name.slice(0, slash);
  const repo = name.slice(slash + 1);
  const endpoint = `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`;
  let out;
  try {
    out = runner.run(root, ["api", endpoint]);
  } catch (error) {
    if (isBranchNotProtected(error) || isNotFound(error)) return { protection: null, exists: false };
    throw error;
  }
  try {
    return { protection: JSON.parse(out), exists: true };
  } catch (/** @type {any} */ error) {
    throw new Error(`parse gh branch protection response: ${error.message ?? String(error)}`, { cause: error });
  }
}

/**
 * @param {StatusCheck[]} checks
 * @returns {Check}
 */
function statusChecksCheck(checks) {
  if (!checks || checks.length === 0) {
    return { name: "Status checks", status: STATUS.warn, summary: "No status checks found on the PR." };
  }
  /** @type {string[]} */
  const failing = [];
  /** @type {string[]} */
  const pending = [];
  for (const check of checks) {
    const conclusion = String(check.conclusion ?? "").toUpperCase();
    const status = String(check.status ?? check.state ?? "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) continue;
    if (["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STALE"].includes(conclusion)) {
      failing.push(statusCheckDetail(check, conclusion));
      continue;
    }
    if (conclusion === "") {
      if (status !== "COMPLETED") pending.push(statusCheckDetail(check, status || "PENDING"));
      continue;
    }
    failing.push(statusCheckDetail(check, conclusion));
  }
  if (failing.length > 0) return { name: "Status checks", status: STATUS.fail, summary: "One or more status checks failed.", details: failing };
  if (pending.length > 0) return { name: "Status checks", status: STATUS.warn, summary: "One or more status checks are still pending.", details: pending };
  return { name: "Status checks", status: STATUS.pass, summary: "All returned status checks passed." };
}

/**
 * @param {StatusCheck} check
 * @param {string} state
 * @returns {string}
 */
function statusCheckDetail(check, state) {
  const name = firstNonEmpty(check.name, check.context, check.workflowName, "unnamed check");
  let detail = `${name}: ${state}`;
  const parts = [];
  const workflow = String(check.workflowName ?? "").trim();
  if (workflow && workflow !== name) parts.push(`workflow: ${workflow}`);
  if (check.detailsUrl) parts.push(`details: ${check.detailsUrl}`);
  parts.push(...annotationDetails(check.annotations ?? []));
  if (parts.length > 0) detail += ` (${parts.join("; ")})`;
  return detail;
}

/**
 * @param {{ message?: string }[]} annotations
 * @returns {string[]}
 */
function annotationDetails(annotations) {
  /** @type {string[]} */
  const out = [];
  for (const annotation of annotations) {
    const message = String(annotation.message ?? "").trim();
    if (!message) continue;
    const label = isCIReadinessAnnotation(message) ? "ci readiness" : "annotation";
    out.push(`${label}: ${message}`);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isCIReadinessAnnotation(message) {
  const text = message.toLowerCase();
  return text.includes("job was not started") || text.includes("spending limit") || text.includes("payments have failed") || text.includes("billing");
}

/**
 * @param {string} root
 * @param {StatusCheck[]} checks
 * @param {Runner} runner
 * @returns {StatusCheck[]}
 */
function enrichStatusCheckAnnotations(root, checks, runner) {
  /** @type {string | undefined} */
  let name;
  const enriched = [...checks];
  for (let i = 0; i < enriched.length; i += 1) {
    const check = enriched[i];
    if (!shouldFetchAnnotations(check)) continue;
    const checkRunId = checkRunIdFromDetailsUrl(check.detailsUrl);
    if (!checkRunId) continue;
    if (!name) {
      try {
        name = nameWithOwner(root, runner);
      } catch {
        return enriched;
      }
    }
    try {
      const out = runner.run(root, ["api", `repos/${name}/check-runs/${checkRunId}/annotations`]);
      const annotations = JSON.parse(out);
      if (Array.isArray(annotations)) enriched[i] = { ...check, annotations };
    } catch {
      // best-effort; skip enrichment on error
    }
  }
  return enriched;
}

/**
 * @param {StatusCheck} check
 * @returns {boolean}
 */
function shouldFetchAnnotations(check) {
  const conclusion = String(check.conclusion ?? "").toUpperCase();
  if (!["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STALE"].includes(conclusion)) return false;
  return Boolean(String(check.detailsUrl ?? "").trim());
}

/**
 * @param {string | undefined} detailsUrl
 * @returns {string}
 */
function checkRunIdFromDetailsUrl(detailsUrl) {
  try {
    const url = new URL(String(detailsUrl ?? "").trim());
    const parts = url.pathname.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "job" && parts[i + 1]) return parts[i + 1];
    }
  } catch {
    // fall through
  }
  return "";
}

/**
 * @param {PR} pr
 * @param {string | undefined} request
 * @returns {string[]}
 */
function contextEvidence(pr, request) {
  const subject = String(request ?? pr.title ?? "review this pull request").trim() || "review this pull request";
  const evidence = [`solumbe impact . ${JSON.stringify(subject)} --json`];
  if (pr.number) evidence.push(`solumbe pr . --number ${pr.number} --out .solumbe/pr-review.md`);
  else if (pr.baseRefName) evidence.push(`solumbe pr . --base ${pr.baseRefName} --out .solumbe/pr-review.md`);
  else evidence.push("solumbe pr . --out .solumbe/pr-review.md");
  return evidence;
}

/**
 * @param {...(string | undefined)} values
 * @returns {string}
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isBranchNotProtected(error) {
  const text = String(/** @type {any} */ (error)?.message ?? "").toLowerCase();
  return text.includes("branch not protected");
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isNotFound(error) {
  const text = String(/** @type {any} */ (error)?.message ?? "").toLowerCase();
  return text.includes("http 404") || text.includes(`"status":"404"`) || text.includes("not found");
}

/**
 * The shape returned by {@link evaluatePR}, as consumed by the renderers.
 * @typedef {Object} PassPrData
 * @property {Verdict} verdict
 * @property {{ root: string, name: string }} repo
 * @property {{ number?: number, title?: string, url?: string, baseRefName?: string, baseSha?: string, headSha?: string, state: string, mergedAt: string, isDraft: boolean, mergeStateStatus: string, mergeable: string, reviewDecision: string }} pr
 * @property {{ kind?: string, repository?: string, number?: number, baseSha?: string, headSha?: string }} [subject]
 * @property {Record<string, any>} [receipt]
 * @property {string} policy
 * @property {string} governance
 * @property {string[]} changedFiles
 * @property {string[]} contextEvidence
 * @property {Check[]} checks
 */

// Renderers reuse the pass-local layout, just with a richer header.
/** @type {Record<string, string>} */
const STATUS_TO_RENDER = { PASS: "pass", WARN: "warn", FAIL: "fail", SKIPPED: "info" };

/**
 * @param {PassPrData} data
 * @param {(options: object) => any} rendererFactory
 * @returns {string}
 */
export function formatPassPrTerminal(data, rendererFactory) {
  const renderer = rendererFactory({});
  const lines = [];
  const sub = [
    { text: data.pr.title ? `#${data.pr.number ?? "?"} ${data.pr.title}` : `#${data.pr.number ?? "?"}`, glyph: "🔖" },
    { text: data.pr.url || `${data.repo.root}`, glyph: data.pr.url ? "🔗" : "📂" },
    { text: `base: ${data.pr.baseRefName || "?"} · policy: ${data.policy} · governance: ${data.governance}`, glyph: "⚙️" },
  ];
  if (data.pr.baseSha && data.pr.headSha) sub.push({ text: `commits: ${data.pr.baseSha.slice(0, 8)}..${data.pr.headSha.slice(0, 8)}`, glyph: "🧾" });
  lines.push(renderer.header({ text: "solumbe pass-pr · GitHub merge readiness", glyph: "📋" }, sub));
  lines.push("");

  for (const check of data.checks) {
    const status = STATUS_TO_RENDER[check.status] ?? "info";
    const details = (check.details ?? []).slice(0, 10);
    lines.push(renderer.statusLine(status, check.name, check.summary, details));
  }

  lines.push("");
  const blocked = data.checks.find((entry) => entry.status === STATUS.fail);
  const warning = data.checks.find((entry) => entry.status === STATUS.warn);
  // Nothing can block a merge that already happened.
  const merged = data.pr.state.toUpperCase() === "MERGED";
  lines.push(
    renderer.verdict({
      verdict: data.verdict,
      blockedBy: blocked && !merged ? blocked.name : undefined,
      nextStep: nextStep(data, blocked, warning),
    }),
  );

  lines.push("");
  lines.push(`  ${renderer.glyphs.tip}  Context evidence:`);
  for (const command of data.contextEvidence) lines.push(`     ${renderer.paint(renderer.glyphs.item, "dim")} ${command}`);
  return lines.join("\n");
}

/**
 * @param {PassPrData} data
 * @param {Check | undefined} blocked
 * @param {Check | undefined} warning
 * @returns {string}
 */
function nextStep(data, blocked, warning) {
  const state = data.pr.state.toUpperCase();
  if (state === "MERGED") return "already merged; the checks describe the merged change";
  if (state === "CLOSED") return "reopen the PR before it can merge";
  if (blocked) return `address ${blocked.name.toLowerCase()} before merge`;
  if (warning) return "review the warning before merge";
  if (data.changedFiles.length === 0) return "no changes reported";
  // A clean PR run proves the checks that ran, not the ones GitHub gave no evidence for.
  const skipped = data.checks.filter((entry) => entry.status === STATUS.skipped).map((entry) => entry.name.toLowerCase());
  return skipped.length ? `ready to merge once ${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} confirmed` : "ready to merge";
}

/**
 * @param {PassPrData} data
 * @returns {string}
 */
export function formatPassPrMarkdown(data) {
  const lines = [
    `# solumbe pass-pr: #${data.pr.number ?? "?"} ${data.pr.title ?? ""}`.trim(),
    "",
    `Verdict: **${data.verdict}**`,
    `Repository: \`${data.repo.root}\``,
    `Base: \`${data.pr.baseRefName ?? ""}\``,
    ...(data.pr.baseSha ? [`Base commit: \`${data.pr.baseSha}\``] : []),
    ...(data.pr.headSha ? [`Head commit: \`${data.pr.headSha}\``] : []),
    `Policy: \`${data.policy}\``,
    `Governance: \`${data.governance}\``,
    data.pr.url ? `PR: ${data.pr.url}` : "",
    "",
    "## Context Evidence",
    "",
    ...data.contextEvidence.map((command) => `- \`${command}\``),
    "",
    "## Changed Files",
    "",
    ...(data.changedFiles.length ? data.changedFiles.map((file) => `- \`${file}\``) : ["- (no changes reported)"]),
    "",
    "## Checks",
    "",
  ];
  for (const check of data.checks) {
    lines.push(`### ${check.status}  ·  ${check.name}`);
    lines.push("");
    lines.push(check.summary);
    if (check.details && check.details.length) {
      lines.push("");
      for (const detail of check.details) lines.push(`- ${detail}`);
    }
    lines.push("");
  }
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}
