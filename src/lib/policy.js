// Policy profiles ported from pullpass/internal/policy/policy.go.
// `standard` is permissive. `company` requires verified GitHub PR-mode
// evidence (review, CODEOWNERS, conversations, branch protection, status
// checks) and team governance. `high-risk` adds stricter handling when
// sensitive paths change.

import { matchRiskPaths } from "./risk-paths.js";

export const PROFILES = {
  standard: "standard",
  company: "company",
  highRisk: "high-risk",
};

export const GOVERNANCE = {
  team: "team",
  solo: "solo",
};

// `skipped` is a per-check status only, never a verdict: a check that cannot be
// evaluated in this mode (a local run has no PR to review) says so honestly
// instead of warning, and `aggregateVerdict` ignores it.
/** @type {{ pass: "PASS", warn: "WARN", fail: "FAIL", skipped: "SKIPPED" }} */
export const STATUS = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  skipped: "SKIPPED",
};

const PROFILE_ALIASES = {
  "": PROFILES.standard,
  standard: PROFILES.standard,
  company: PROFILES.company,
  team: PROFILES.company,
  "high-risk": PROFILES.highRisk,
  highrisk: PROFILES.highRisk,
  strict: PROFILES.highRisk,
  regulated: PROFILES.highRisk,
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeProfile(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  const profile = /** @type {Record<string, string>} */ (PROFILE_ALIASES)[key];
  if (!profile) {
    throw new Error(`unknown policy profile "${value}"; use "standard", "company", or "high-risk"`);
  }
  return profile;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeGovernance(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (key === "" || key === GOVERNANCE.team) return GOVERNANCE.team;
  if (key === GOVERNANCE.solo) return GOVERNANCE.solo;
  throw new Error(`unknown governance "${value}"; use "team" or "solo"`);
}

// Build the Policy profile check. `remote` is true when running in GitHub PR
// mode (Phase 4); local mode always passes false here.
/**
 * @param {{ profile: string, governance: string, files: string[], checks: import('./pass-local.js').Check[], remote: boolean }} params
 * @returns {import('./pass-local.js').Check}
 */
export function policyCheck({ profile, governance, files, checks, remote }) {
  switch (profile) {
    case PROFILES.company:
      return companyCheck({ governance, checks, remote });
    case PROFILES.highRisk:
      return highRiskCheck({ governance, files, checks, remote });
    default:
      return {
        name: "Policy profile",
        status: STATUS.pass,
        summary: "Standard policy profile active.",
        details: [PROFILES.standard],
      };
  }
}

/**
 * @param {{ governance: string, checks: import('./pass-local.js').Check[], remote: boolean }} params
 * @returns {import('./pass-local.js').Check}
 */
function companyCheck({ governance, checks, remote }) {
  const issues = companyIssues({ governance, checks, remote });
  if (issues.length > 0) {
    return {
      name: "Policy profile",
      status: STATUS.fail,
      summary: "Company policy requires team governance and verified GitHub PR controls.",
      details: issues,
    };
  }
  return {
    name: "Policy profile",
    status: STATUS.pass,
    summary: "Company policy profile satisfied.",
    details: [PROFILES.company],
  };
}

/**
 * @param {{ governance: string, files: string[], checks: import('./pass-local.js').Check[], remote: boolean }} params
 * @returns {import('./pass-local.js').Check}
 */
function highRiskCheck({ governance, files, checks, remote }) {
  // `{ gate: true }` applies the same test/doc/zero-weight filtering the merge
  // gates use. Without it this check contradicted its own run: Risk review
  // reported "no risk-sensitive file paths changed" while the high-risk
  // profile failed the merge citing `tests/checkout.spec.ts` and
  // `docs/auth-guide.md` as high-risk file changes.
  const riskFiles = matchRiskPaths(files, { gate: true });
  const issues = companyIssues({ governance, checks, remote });
  if (!remote && riskFiles.length > 0) {
    issues.push("High-risk file changes require GitHub PR mode evidence.");
  }

  if (issues.length > 0) {
    return {
      name: "Policy profile",
      status: STATUS.fail,
      summary: "High-risk policy requires company controls before merge.",
      details: [...issues, ...riskFiles.slice(0, 20)],
    };
  }
  if (riskFiles.length > 0) {
    return {
      name: "Policy profile",
      status: STATUS.warn,
      summary: "High-risk paths changed; record the specialist or owner decision before merge.",
      details: [PROFILES.highRisk, ...riskFiles.slice(0, 20)],
    };
  }
  return {
    name: "Policy profile",
    status: STATUS.pass,
    summary: "High-risk policy profile satisfied.",
    details: [PROFILES.highRisk],
  };
}

/**
 * @param {{ governance: string, checks: import('./pass-local.js').Check[], remote: boolean }} params
 * @returns {string[]}
 */
function companyIssues({ governance, checks, remote }) {
  const issues = [];
  if (governance === GOVERNANCE.solo) {
    issues.push("Company policy requires team governance; solo-maintainer owner decisions are not enough for shared repositories.");
  }
  if (!remote) {
    issues.push("Company policy requires GitHub PR mode evidence for reviews, CODEOWNERS, status checks, conversations, and branch protection.");
    return issues;
  }
  const required = ["Review decision", "CODEOWNERS", "Review conversations", "Branch protection", "Status checks"];
  for (const name of required) {
    const found = checks.find((entry) => entry.name === name);
    if (!found) {
      issues.push(`${name} check is missing.`);
      continue;
    }
    if (found.status !== STATUS.pass) {
      issues.push(`${name} must be PASS, got ${found.status}: ${found.summary}`);
    }
  }
  return issues;
}

// Roll the per-check statuses into a single verdict. FAIL beats WARN beats
// PASS. SKIPPED checks carry no evidence either way, so they never move the
// verdict. Matches pullpass/rules/Verdict.
/**
 * @param {import('./pass-local.js').Check[]} checks
 * @returns {import('./pass-local.js').Verdict}
 */
export function aggregateVerdict(checks) {
  /** @type {import('./pass-local.js').Verdict} */
  let result = STATUS.pass;
  for (const entry of checks) {
    if (entry.status === STATUS.fail) return STATUS.fail;
    if (entry.status === STATUS.warn) result = STATUS.warn;
  }
  return result;
}
