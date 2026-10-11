// Post-merge attestation: turn a review verdict into a hash-chained record
// bound to a merged commit, and verify a ledger of such records.
//
// Each record's `recordHash = sha256(prevHash + canonical(body))`, so editing
// any stored field breaks every hash after it, and each record is keyed to an
// exact merge SHA, so a missing commit is visible. The ledger is JSON Lines:
// one record per line, append-only. Locally that file is the whole audit
// trail; a hosted store receives copies of the same records, never the diff
// or the source. See docs/19-local-core-optional-hosted.
//
// A record can also be signed. The chain shows that nothing was edited after
// the fact; an Ed25519 signature over `recordHash` shows who wrote it, which
// a chain anyone can recompute does not. The published schema is
// docs/schemas/attestation-record.v2.json.

import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runCommand } from "./tools.js";

/**
 * Version of the ledger record shape. Bump when a field is added, removed or
 * changes meaning, so a store or a verifier can read old records correctly.
 * Records written before this field existed carry no version and verify as
 * they always did: the hash covers whatever body was stored.
 */
export const ATTESTATION_SCHEMA_VERSION = 2;

/** The commit status a record is published under. */
export const RECEIPT_STATUS_CONTEXT = "solumbe/receipt";

/** The hash a chain starts from. */
export const GENESIS_HASH = "0".repeat(64);

/** Where a repository keeps its ledger unless told otherwise. */
export const DEFAULT_LEDGER = "audit-pilot/ledger.jsonl";

/**
 * Stable stringify so the hash is reproducible regardless of key order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * @typedef {object} AttestationRecord
 * @property {number} seq
 * @property {string} mergeSha
 * @property {string} prevHash
 * @property {string} recordHash
 * @property {string} [verdict]
 * @property {number} [schemaVersion]
 * @property {RecordSignature} [signature]
 */

/**
 * @typedef {object} RecordSignature
 * @property {"ed25519"} alg
 * @property {string} keyId the first 16 hex characters of the public key's SHA-256
 * @property {string} value the signature over `recordHash`, base64
 */

/**
 * Resolve the ledger path: an explicit file, else the default under the repo.
 * @param {{ ledger?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveLedgerPath(options = {}) {
  if (options.ledger) return resolve(options.ledger);
  return resolve(options.path ?? ".", DEFAULT_LEDGER);
}

/**
 * @param {string} ledgerPath
 * @returns {AttestationRecord[]}
 */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => /** @type {AttestationRecord} */ (JSON.parse(line)));
}

/**
 * @typedef {object} AttestOptions
 * @property {Record<string, any>} verdict the `solumbe review --json` payload
 * @property {string} merge the merged commit SHA
 * @property {string} [prev] the base (first parent) SHA
 * @property {number|string|null} [pr]
 * @property {string} [author]
 * @property {string|null} [committed] ISO commit time
 * @property {import("node:crypto").KeyObject | null} [signingKey] an Ed25519 private key; the record is signed when given
 */

/**
 * Build the next record for a ledger without writing it.
 * @param {AttestOptions} options
 * @param {AttestationRecord[]} rows the existing ledger, oldest first
 * @returns {AttestationRecord & Record<string, unknown>}
 */
export function buildAttestation(options, rows) {
  const { verdict } = options;
  if (!verdict || typeof verdict !== "object") throw new Error("attest needs a review verdict (JSON from `solumbe review --json`)");
  if (!options.merge) throw new Error("attest needs --merge <sha>, the merged commit to bind the record to");
  const prevHash = rows.length ? rows[rows.length - 1].recordHash : GENESIS_HASH;
  const pr = Number(options.pr ?? 0) || null;
  const pass = verdict.pass ?? {};
  const subject = pass.subject && typeof pass.subject === "object" ? pass.subject : null;

  const body = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    seq: rows.length + 1,
    mergeSha: options.merge,
    baseSha: options.prev ?? null,
    pr,
    author: options.author ?? "unknown",
    committedAt: options.committed ?? null,
    attestedAt: verdict.generatedAt ?? null,
    engineVersion: verdict.reviewEngineVersion ?? null,
    verdictSchemaVersion: verdict.schemaVersion ?? null,
    policy: verdict.pass?.policy ?? null,
    governance: verdict.pass?.governance ?? null,
    verdict: verdict.verdict,
    confidence: verdict.confidence ?? null,
    changedFiles: verdict.prReviewSummary?.changedFiles ?? null,
    riskLevel: verdict.prReviewSummary?.riskLevel ?? null,
    riskFlags: verdict.prReviewSummary?.riskFlags ?? [],
    checks: (verdict.pass?.checks ?? []).map((/** @type {any} */ check) => ({ name: check.name, status: check.status })),
    impactedFiles: (verdict.impactSummary?.topFiles ?? []).map((/** @type {any} */ file) => file.path),
    // Version 2: what was asked, what was declared before the edit, the exact
    // tree the verdict was measured at, and the change by the hash of its
    // paths. Each is null when the verdict it came from did not carry it.
    request: verdict.requestStated === true ? String(verdict.request ?? "") : null,
    contract: pass.contract
      ? { tip: pass.contract.tip ?? null, amendments: pass.contract.amendments ?? 0, undeclared: (pass.contract.undeclared ?? []).length }
      : null,
    subject: subject
      ? { kind: subject.kind ?? null, baseSha: subject.baseSha ?? null, headSha: subject.headSha ?? null, treeSha: subject.treeSha ?? null }
      : null,
    changedPathsHash: Array.isArray(pass.changedFiles) ? sha256(canonical([...pass.changedFiles].sort())) : null,
    convergence: typeof pass.convergence === "number" ? pass.convergence : null,
    band: typeof pass.band === "string" ? pass.band : null,
    receipt: typeof pass.receipt?.inputsHash === "string" ? pass.receipt.inputsHash : null,
    prevHash,
  };
  const recordHash = sha256(prevHash + canonical(body));
  /** @type {AttestationRecord & Record<string, unknown>} */
  const record = { ...body, recordHash };
  // The signature is over the record hash and sits outside it, so a record
  // verifies the same way signed or not.
  if (options.signingKey) record.signature = signRecordHash(recordHash, options.signingKey);
  return record;
}

/**
 * Load an Ed25519 key from a PEM file or PEM text. A private key is read as
 * given; `asPublic` returns its public half, or reads a public key.
 * @param {string | undefined | null} source a path, or the PEM itself
 * @param {{ asPublic?: boolean }} [options]
 * @returns {import("node:crypto").KeyObject | null}
 */
export function loadAttestKey(source, options = {}) {
  const text = String(source ?? "").trim();
  if (!text) return null;
  let pem = text;
  if (!text.includes("-----BEGIN")) {
    if (!existsSync(text)) throw new Error(`no key file at ${text}`);
    pem = readFileSync(text, "utf8");
  }
  let key;
  try {
    key = options.asPublic ? createPublicKey(pem) : createPrivateKey(pem);
  } catch {
    throw new Error(`could not read ${options.asPublic ? "a public" : "a private"} key from the PEM given`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`attestation keys are Ed25519, not ${key.asymmetricKeyType ?? "unknown"}`);
  return key;
}

/**
 * @param {import("node:crypto").KeyObject} key a private or public Ed25519 key
 * @returns {string}
 */
export function attestKeyId(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * @param {string} recordHash
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {RecordSignature}
 */
function signRecordHash(recordHash, privateKey) {
  return { alg: "ed25519", keyId: attestKeyId(privateKey), value: signBytes(null, Buffer.from(recordHash, "hex"), privateKey).toString("base64") };
}

/**
 * Append one attestation to the ledger and return the record written.
 * @param {AttestOptions & { ledgerPath: string }} options
 * @returns {AttestationRecord & Record<string, unknown>}
 */
export function appendAttestation(options) {
  const rows = readLedger(options.ledgerPath);
  const record = buildAttestation(options, rows);
  mkdirSync(dirname(options.ledgerPath), { recursive: true });
  appendFileSync(options.ledgerPath, `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * @typedef {object} VerifyResult
 * @property {boolean} ok
 * @property {string} ledger
 * @property {number} records
 * @property {string} tip the last record hash, or the genesis hash for an empty ledger
 * @property {{ signed: number, verified: number, invalid: number, unsigned: number, keyId: string | null }} signatures
 * @property {Array<{ seq: number, mergeSha: string, verdict: string|null, valid: boolean, signature: "valid" | "invalid" | "unsigned" | "unchecked" }>} chain
 */

/**
 * Recompute every hash in the ledger and report the first break. With a
 * public key, each signature is checked too: a signature that does not match
 * fails the ledger, and so does an unsigned record when `requireSignature` is
 * set. Without a key a signature is reported as present but unchecked.
 * @param {string} ledgerPath
 * @param {{ publicKey?: import("node:crypto").KeyObject | null, requireSignature?: boolean }} [options]
 * @returns {VerifyResult}
 */
export function verifyLedger(ledgerPath, options = {}) {
  const rows = readLedger(ledgerPath);
  const publicKey = options.publicKey ?? null;
  let prev = GENESIS_HASH;
  let ok = true;
  const signatures = { signed: 0, verified: 0, invalid: 0, unsigned: 0, keyId: publicKey ? attestKeyId(publicKey) : null };
  const chain = rows.map((row) => {
    const { recordHash, signature, ...body } = row;
    const valid = sha256(prev + canonical(body)) === recordHash && body.prevHash === prev;
    if (!valid) ok = false;
    prev = recordHash;

    /** @type {"valid" | "invalid" | "unsigned" | "unchecked"} */
    let signed = "unsigned";
    if (signature) {
      signatures.signed += 1;
      signed = publicKey ? (signatureMatches(recordHash, signature, publicKey) ? "valid" : "invalid") : "unchecked";
    }
    if (signed === "valid") signatures.verified += 1;
    if (signed === "invalid") signatures.invalid += 1;
    if (signed === "unsigned") signatures.unsigned += 1;
    if (signed === "invalid" || (signed === "unsigned" && options.requireSignature)) ok = false;
    return { seq: body.seq, mergeSha: body.mergeSha, verdict: body.verdict ?? null, valid, signature: signed };
  });
  return { ok, ledger: ledgerPath, records: rows.length, tip: prev, signatures, chain };
}

/**
 * @param {string} recordHash
 * @param {any} signature
 * @param {import("node:crypto").KeyObject} publicKey
 * @returns {boolean}
 */
function signatureMatches(recordHash, signature, publicKey) {
  if (signature?.alg !== "ed25519" || typeof signature.value !== "string" || !/^[0-9a-f]{64}$/.test(recordHash)) return false;
  try {
    return verifyBytes(null, Buffer.from(recordHash, "hex"), publicKey, Buffer.from(signature.value, "base64"));
  } catch {
    return false;
  }
}

/**
 * @param {VerifyResult} result
 * @returns {string}
 */
export function formatVerify(result) {
  const signatureNote = { valid: "  signed", invalid: "  BAD SIGNATURE", unchecked: "  signed (not checked: no public key)", unsigned: "" };
  const lines = result.chain.map(
    (row) =>
      `#${row.seq} ${String(row.mergeSha ?? "").slice(0, 7)}  ${row.valid ? "OK  " : "TAMPERED"}  ${row.verdict ?? ""}${signatureNote[row.signature] ?? ""}`,
  );
  lines.push("");
  const chainBroken = result.chain.some((row) => !row.valid);
  const { signatures } = result;
  if (chainBroken) lines.push("CHAIN BROKEN");
  else if (signatures.invalid > 0) lines.push(`SIGNATURE MISMATCH: ${signatures.invalid} record(s) were not signed by key ${signatures.keyId}`);
  else if (!result.ok) lines.push(`UNSIGNED: ${signatures.unsigned} record(s) carry no signature`);
  else {
    const signed = signatures.keyId && signatures.verified > 0 ? `, ${signatures.verified} signed by key ${signatures.keyId}` : "";
    lines.push(`Chain intact: ${result.records} record(s), tip ${result.tip.slice(0, 12)}${signed}`);
  }
  return lines.join("\n");
}

/**
 * @param {AttestationRecord & Record<string, unknown>} record
 * @returns {string}
 */
export function formatAttested(record) {
  const signed = record.signature ? `  signed ${record.signature.keyId}` : "";
  return `Attested #${record.seq} ${record.mergeSha.slice(0, 7)} -> ${record.verdict} (conf ${record.confidence})  hash ${record.recordHash.slice(0, 12)}${signed}`;
}

/**
 * The commit status that carries a record: its verdict, its place in the
 * chain and its hash, on the commit it attests. A FAIL verdict is a failed
 * status; PASS and WARN are a success, since WARN asks for a reviewer and does
 * not block.
 * @param {AttestationRecord & Record<string, any>} record
 * @param {{ targetUrl?: string }} [options]
 * @returns {{ context: string, state: "success" | "failure", description: string, target_url?: string }}
 */
export function receiptStatus(record, options = {}) {
  const tree = record.subject?.treeSha ? ` · tree ${String(record.subject.treeSha).slice(0, 7)}` : "";
  const signed = record.signature ? ` · signed ${record.signature.keyId}` : "";
  return {
    context: RECEIPT_STATUS_CONTEXT,
    state: record.verdict === "FAIL" ? "failure" : "success",
    description: `${record.verdict} · record #${record.seq} ${record.recordHash.slice(0, 12)}${tree}${signed}`.slice(0, 140),
    ...(options.targetUrl ? { target_url: options.targetUrl } : {}),
  };
}

/**
 * Publish a record as a commit status on the commit it attests, through the
 * caller's own `gh` login.
 * @param {AttestationRecord & Record<string, any>} record
 * @param {{ repo?: string, targetUrl?: string, cwd?: string, dryRun?: boolean, runner?: typeof runCommand }} [options]
 * @returns {{ posted: boolean, repo: string | null, sha: string, status: ReturnType<typeof receiptStatus>, error?: string }}
 */
export function postReceiptStatus(record, options = {}) {
  const run = options.runner ?? runCommand;
  const status = receiptStatus(record, { targetUrl: options.targetUrl });
  let repo = options.repo ?? process.env.GITHUB_REPOSITORY ?? "";
  if (!repo && !options.dryRun) {
    const view = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: options.cwd });
    repo = view.ok ? String(view.stdout).trim() : "";
  }
  const result = { posted: false, repo: repo || null, sha: record.mergeSha, status };
  if (options.dryRun) return result;
  if (!repo) return { ...result, error: "could not tell which GitHub repository to post to; pass --repo owner/name" };
  const fields = Object.entries(status).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
  const posted = run("gh", ["api", "--method", "POST", `repos/${repo}/statuses/${record.mergeSha}`, ...fields], { cwd: options.cwd });
  if (!posted.ok)
    return {
      ...result,
      error:
        String(posted.stderr || posted.stdout)
          .trim()
          .split("\n")[0] || "gh could not post the status",
    };
  return { ...result, posted: true };
}
