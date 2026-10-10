// Content-aware secret detection for the merge gates.
//
// `risk-paths.js` answers "is this file *named* like a credential store?".
// That check never opens a file, so a live credential pasted into ordinary
// source (`src/config.js`) passed the gate untouched. This module answers the
// complementary question — "does the text of this change contain a credential?"
// — against the exact staged blob the gate is already reading.
//
// Precision is the design constraint. A false FAIL blocks a merge, so the
// vendor rules only match credential formats that carry an issuer prefix and a
// fixed shape, and the one generic rule additionally requires a high-entropy
// value assigned to an obviously secret-bearing name. Anything that looks like
// a placeholder, an environment lookup, or a template expression is ignored.
//
// Test files, documentation, fixtures and committed templates hold made-up
// values by convention (`accessToken: 'valid-access-token'`), so the heuristic
// rule stands down there. Vendor-format rules still run everywhere: a real
// `sk_live_` key is a leak in a spec file too.
//
// Escape hatch: put `solumbe:allow-secret` on the matching line (or the line
// above it) to silence a reviewed false positive.

import { isTestFilePath } from "./code-map/classify.js";
import { isDocPath, isFixturePath, isTemplatePath } from "./risk-paths.js";

/** Marker that suppresses a finding on the line it appears on, or the next line. */
export const ALLOW_MARKER = "solumbe:allow-secret";

/** Files larger than this are not scanned; the gate reports them as skipped. */
export const MAX_SCAN_BYTES = 1024 * 1024;

/** Upper bound on lines scanned per file, so a generated blob cannot stall a gate. */
export const MAX_SCAN_LINES = 20000;

/** Longest single line considered; minified bundles are not credential stores. */
const MAX_LINE_LENGTH = 2000;

/** Values containing any of these are documentation stand-ins, never live keys. */
const PLACEHOLDER_MARKERS = [
  "example",
  "placeholder",
  "redacted",
  "changeme",
  "change-me",
  "your-",
  "your_",
  "yourkey",
  "dummy",
  "sample",
  "fake",
  "notreal",
  "not-a-real",
  "test-only",
  "testonly",
  "xxxx",
  "0000",
  "1234567890",
  "abcdef",
  "insert-",
  "<",
  "{{",
  "${",
  "%s",
];

/** Value forms that read a credential rather than embed one. */
const INDIRECTION_PATTERNS = [/process\s*\.\s*env/i, /import\.meta\.env/i, /os\.environ/i, /getenv/i, /secretsmanager/i, /vault/i, /\bref\s*:/i];

/**
 * A single detection rule.
 * @typedef {object} SecretRule
 * @property {string} id
 * @property {string} label
 * @property {RegExp} pattern
 * @property {"fail" | "warn"} severity
 * @property {boolean} [heuristic] matches a shape, not an issuer format; skipped in test, doc, fixture and template files
 * @property {(match: RegExpMatchArray) => boolean} [accept] extra validation on a raw match
 */

// The PEM header is assembled from parts so this rule cannot match its own
// source text when solumbe gates its own repository.
const PEM_HEADER = ["-----BEGIN ", "(?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?", "PRIVATE KEY", "-----"].join("");

/** @type {SecretRule[]} */
export const SECRET_CONTENT_RULES = [
  {
    id: "aws-access-key-id",
    label: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
    severity: "fail",
  },
  {
    id: "aws-secret-access-key",
    label: "AWS secret access key",
    pattern: /aws_?secret_?access_?key\W{1,20}([A-Za-z0-9/+=]{40})\b/gi,
    severity: "fail",
  },
  {
    id: "private-key-block",
    label: "private key block",
    pattern: new RegExp(PEM_HEADER, "g"),
    severity: "fail",
  },
  {
    id: "stripe-live-secret-key",
    label: "Stripe live secret key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
    severity: "fail",
  },
  {
    id: "github-token",
    label: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
    severity: "fail",
  },
  {
    id: "github-fine-grained-token",
    label: "GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
    severity: "fail",
  },
  {
    id: "slack-token",
    label: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{12,}\b/g,
    severity: "fail",
  },
  {
    id: "google-api-key",
    label: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: "fail",
  },
  {
    id: "anthropic-api-key",
    label: "Anthropic API key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g,
    severity: "fail",
  },
  {
    id: "openai-project-key",
    label: "OpenAI project key",
    pattern: /\bsk-proj-[A-Za-z0-9_-]{24,}\b/g,
    severity: "fail",
  },
  {
    id: "npm-token",
    label: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    severity: "fail",
  },
  {
    id: "generic-credential-assignment",
    label: "hardcoded credential",
    // Deliberately the only heuristic rule, and the only one that warns rather
    // than blocks: the name must be unambiguously credential-bearing, the value
    // must be a literal of real length, and `accept` still requires entropy.
    // The value may not contain whitespace: a credential never does, while
    // prose in a doc comment (`const password = 'Password used to generate
    // key'`) otherwise clears the entropy bar on character variety alone.
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["'`]([^"'`\s\n]{16,})["'`]/gi,
    severity: "warn",
    heuristic: true,
    accept: (match) => shannonEntropy(match[1] ?? "") >= 3.6,
  },
];

/**
 * A single finding.
 * @typedef {object} SecretFinding
 * @property {string} file
 * @property {string} rule
 * @property {string} label
 * @property {"fail" | "warn"} severity
 * @property {number} line 1-indexed
 */

/**
 * Scan one file's text. Findings never carry the matched value — a gate
 * receipt must not become a second copy of the credential.
 *
 * @param {string} text
 * @param {{ file?: string, maxFindings?: number }} [options]
 * @returns {SecretFinding[]}
 */
export function scanSecretContent(text, options = {}) {
  const file = options.file ?? "";
  const maxFindings = options.maxFindings ?? 20;
  /** @type {SecretFinding[]} */
  const findings = [];
  if (typeof text !== "string" || text.length === 0) return findings;
  // A NUL byte means a binary blob: not reviewable text, never scanned.
  if (text.includes("\0")) return findings;

  const lines = text.split(/\r?\n/, MAX_SCAN_LINES);
  const rules = isPlaceholderValuePath(file) ? SECRET_CONTENT_RULES.filter((rule) => !rule.heuristic) : SECRET_CONTENT_RULES;
  /** @type {Set<string>} */
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.length > MAX_LINE_LENGTH) continue;
    if (isAllowed(line) || isAllowed(lines[index - 1] ?? "")) continue;

    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        const value = match[1] ?? match[0];
        if (isPlaceholder(value) || isIndirection(line)) continue;
        if (rule.accept && !rule.accept(match)) continue;
        const key = `${rule.id}:${index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ file, rule: rule.id, label: rule.label, severity: rule.severity, line: index + 1 });
        if (findings.length >= maxFindings) return findings;
      }
    }
  }
  return findings;
}

/**
 * Files whose credential-shaped values are placeholders by convention.
 * @param {string} file
 * @returns {boolean}
 */
function isPlaceholderValuePath(file) {
  if (!file) return false;
  return isTestFilePath(file) || isDocPath(file) || isFixturePath(file) || isTemplatePath(file);
}

/** @param {string} line */
function isAllowed(line) {
  return line.toLowerCase().includes(ALLOW_MARKER);
}

/** @param {string} value */
function isPlaceholder(value) {
  const lowered = String(value).toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
}

/** @param {string} line */
function isIndirection(line) {
  return INDIRECTION_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Shannon entropy in bits per character. A 16+ character literal below ~3.6
 * bits is overwhelmingly prose or a structured identifier, not a key.
 * @param {string} value
 * @returns {number}
 */
export function shannonEntropy(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Summarise findings for a gate check: the worst severity present, plus a
 * stable, value-free detail line per finding.
 *
 * @param {SecretFinding[]} findings
 * @returns {{ severity: "fail" | "warn" | null, details: string[] }}
 */
export function summarizeSecretFindings(findings) {
  if (!findings.length) return { severity: null, details: [] };
  const severity = findings.some((finding) => finding.severity === "fail") ? "fail" : "warn";
  const details = findings.map((finding) => `${finding.file}:${finding.line} — ${finding.label}`);
  return { severity, details };
}
