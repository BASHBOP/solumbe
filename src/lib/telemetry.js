// Opt-in usage telemetry. Local capture and anonymous remote sharing are two
// separate permissions. Local capture appends one JSONL line per CLI run and
// MCP call to ~/.solumbe/usage.jsonl. Remote sharing sends only a much smaller,
// explicitly allowlisted shape through Solumbe's public relay:
//
//   - off by default; gated by the `telemetry` config key or SOLUMBE_TELEMETRY,
//     and forced off under CI unless SOLUMBE_TELEMETRY explicitly opts in.
//   - remote sharing is independently off by default; existing local telemetry
//     consent is never widened into network transmission.
//   - the gate is resolved ONCE per process and cached, so the hot path never
//     re-reads config (no per-event loadConfig directory walk).
//   - appendEvent is best-effort: it swallows every error and NEVER writes to
//     stdout, so it can never corrupt --json output or the MCP JSON-RPC channel
//     and can never fail a command (the determinism firewall).
//   - wall-clock `ts`/`durationMs` live ONLY in this log and the derived
//     dashboard — they are never fed into a token estimate or a converge receipt.
//   - error text is reduced to a class/code (e.g. ENOENT), never the raw message,
//     so absolute paths and queries can never leak into the log.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

export const TELEMETRY_SCHEMA_VERSION = 1;
export const TELEMETRY_SHARE_SCHEMA_VERSION = 1;
// The shared payload's route and its version field keep their pre-rename names
// on purpose: bashbop-api's analytics controller and DTO define them, and both
// sides have to move together (rebrand-keep: analytics/otito, TrackOtitoEventDto).
export const DEFAULT_TELEMETRY_SHARE_ENDPOINT = "https://api.bashbop.com/api/v1/analytics/otito";
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate at 5MB to a single .1 generation
const MAX_ERROR_LEN = 60;
const DEFAULT_SHARE_TIMEOUT_MS = 750;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let solumbeVersion = "0.0.0";
try {
  solumbeVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version ?? "0.0.0";
} catch {
  // best-effort; version is cosmetic in the log
}

/**
 * Resolve the append-only log path. SOLUMBE_TELEMETRY_PATH overrides (used by
 * tests and power users); otherwise it sits beside the catalog under ~/.solumbe.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function telemetryLogPath(env = process.env) {
  return path.resolve(env.SOLUMBE_TELEMETRY_PATH ?? path.join(os.homedir(), ".solumbe", "usage.jsonl"));
}

/** @param {NodeJS.ProcessEnv} [env] */
export function telemetryAnonymousIdPath(env = process.env) {
  return path.resolve(env.SOLUMBE_TELEMETRY_ID_PATH ?? path.join(os.homedir(), ".solumbe", "anonymous-id"));
}

/**
 * @param {string | undefined} value
 * @returns {boolean | undefined}
 */
function coerceBool(value) {
  if (value === "true" || value === "1" || value === "on") return true;
  if (value === "false" || value === "0" || value === "off") return false;
  return undefined;
}

/**
 * Resolve whether telemetry is enabled. Precedence: SOLUMBE_TELEMETRY env wins;
 * under CI the default is OFF unless the env explicitly opts in; otherwise the
 * persisted `telemetry` config key. Pure given its inputs.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {boolean}
 */
function resolveEnabled(env, cwd) {
  const envBool = coerceBool(env.SOLUMBE_TELEMETRY);
  // CI must never capture from an inherited user config; only an explicit
  // SOLUMBE_TELEMETRY=1 turns it on there.
  if (env.CI) return envBool === true;
  if (envBool !== undefined) return envBool;
  try {
    return loadConfig({ cwd, env }).telemetry === true;
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
function resolveSharingEnabled(env, cwd) {
  const envBool = coerceBool(env.SOLUMBE_TELEMETRY_SHARE);
  if (env.CI) return envBool === true;
  if (envBool !== undefined) return envBool;
  try {
    return loadConfig({ cwd, env }).telemetryShare === true;
  } catch {
    return false;
  }
}

/** @type {{ enabled: boolean } | null} */
let _gate = null;
/** @type {{ enabled: boolean } | null} */
let _shareGate = null;

/**
 * Cached per-process gate. The first call resolves config; later calls are free.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, fresh?: boolean }} [opts]
 * @returns {boolean}
 */
export function isTelemetryEnabled(opts = {}) {
  if (_gate && !opts.fresh) return _gate.enabled;
  const enabled = resolveEnabled(opts.env ?? process.env, opts.cwd ?? process.cwd());
  _gate = { enabled };
  return enabled;
}

/**
 * Remote sharing uses its own explicit permission and cache. Local capture
 * being on is not consent to send anything over the network.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, fresh?: boolean }} [opts]
 */
export function isTelemetrySharingEnabled(opts = {}) {
  if (_shareGate && !opts.fresh) return _shareGate.enabled;
  const enabled = resolveSharingEnabled(opts.env ?? process.env, opts.cwd ?? process.cwd());
  _shareGate = { enabled };
  return enabled;
}

/** Test seam: drop the cached gate (and any pending signals). */
export function resetTelemetryCache() {
  _gate = null;
  _shareGate = null;
  _pendingSignals = null;
}

/**
 * Reduce an error to a non-identifying class/code token — never the message,
 * which routinely embeds absolute paths, refs, or queries.
 * @param {unknown} error
 * @returns {string}
 */
export function redactError(error) {
  if (!error) return "Error";
  // Node fs/system errors carry a stable .code (ENOENT, EACCES, ...).
  const code = /** @type {{ code?: unknown }} */ (error).code;
  if (typeof code === "string" && code) return code.slice(0, MAX_ERROR_LEN);
  if (typeof code === "number") return `code:${code}`;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  // McpProtocolError exposes a numeric JSON-RPC code worth keeping.
  const rpc = /** @type {{ code?: unknown }} */ (error).code;
  return (typeof rpc === "number" ? `${name}:${rpc}` : name).slice(0, MAX_ERROR_LEN);
}

/**
 * Pull the value signals a command produced off its result data, with no
 * recompute. Returns null when the data carries none (e.g. a code map).
 * @param {any} data
 * @returns {Record<string, any> | null}
 */
export function extractSignals(data) {
  if (!data || typeof data !== "object") return null;
  /** @type {Record<string, any>} */
  const s = {};
  if (data.tokenEstimate && typeof data.tokenEstimate.fullJson === "number") s.tokenEstimate = data.tokenEstimate.fullJson;
  if (typeof data.verdict === "string") s.verdict = data.verdict;
  if (typeof data.confidence === "number") s.confidence = data.confidence;
  if (typeof data.ax === "number") s.ax = data.ax;
  if (typeof data.convergence === "number") s.convergence = data.convergence;
  if (typeof data.band === "string") s.band = data.band;
  if (data.receipt && typeof data.receipt.id === "string") s.receiptId = data.receipt.id;
  if (data.validation && typeof data.validation.verdict === "string") s.validationVerdict = data.validation.verdict;
  if (data.totals && typeof data.totals.savedTokens === "number") s.savedTokens = data.totals.savedTokens;
  if (data.totals && typeof data.totals.savedPct === "number") s.savedPct = data.totals.savedPct;
  if (typeof data.passed === "boolean") s.evalPassed = data.passed;
  Object.assign(s, followUpSignals(data));
  return Object.keys(s).length ? s : null;
}

/** @param {unknown} value */
function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

/**
 * What `solumbe calibrate --follow-through` joins one run to the next on: each
 * check's status under its name, and hashes that say which repository, change
 * and request a gate verdict or convergence score was for. Check names are a
 * fixed vocabulary; a path or a request reaches the log only as a hash.
 * @param {any} data
 * @returns {Record<string, any>}
 */
function followUpSignals(data) {
  /** @type {Record<string, any>} */
  const s = {};
  const scored = typeof data.verdict === "string" || typeof data.convergence === "number";
  if (!scored) return s;
  const checks = Array.isArray(data.checks) ? data.checks : Array.isArray(data.pass?.checks) ? data.pass.checks : null;
  if (checks) {
    s.checks = Object.fromEntries(
      checks
        .filter((/** @type {any} */ check) => typeof check?.name === "string" && typeof check.status === "string")
        .map((/** @type {any} */ check) => [check.name, check.status]),
    );
  }
  if (typeof data.verdict === "string") s.gateMode = data.pr ? "pr" : "local";
  if (typeof data.repo?.root === "string") s.repoId = shortHash(data.repo.root);
  if (Array.isArray(data.changedFiles))
    s.changeId = shortHash(JSON.stringify([data.scope ?? null, data.subject?.treeSha ?? null, [...data.changedFiles].sort()]));
  const request = String(data.request ?? data.task ?? "").trim();
  if (request) s.requestId = shortHash(request);
  return s;
}

/** @type {Record<string, any> | null} */
let _pendingSignals = null;

/**
 * Stash the signals from a CLI command's result so main()'s recorder can attach
 * them without threading a return value through every handler branch. One-shot:
 * takePendingSignals clears it. (MCP reads result.data directly instead.)
 * @param {any} data
 */
export function noteResult(data) {
  const s = extractSignals(data);
  if (s) _pendingSignals = s;
}

/** @returns {Record<string, any> | null} */
export function takePendingSignals() {
  const s = _pendingSignals;
  _pendingSignals = null;
  return s;
}

/**
 * Append one usage event, best-effort. Short-circuits when telemetry is off.
 * Stamps the envelope (schema version, wall-clock ts, solumbe/node version, and
 * a non-reversible repo group key). NEVER throws, NEVER writes stdout.
 * @param {Record<string, any>} event
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {Record<string, any> | null}
 */
export function appendEvent(event, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    if (!isTelemetryEnabled({ env, cwd: opts.cwd })) return null;

    const repoRoot = event.repoRoot;
    const record = {
      v: TELEMETRY_SCHEMA_VERSION,
      ts: Date.now(),
      surface: event.surface,
      cmd: event.cmd,
      requested: event.requested ?? null,
      argsShape: event.argsShape ?? null,
      outcome: event.outcome ?? "ok",
      error: event.error ?? null,
      durationMs: typeof event.durationMs === "number" ? Math.round(event.durationMs) : null,
      repo: repoRoot ? crypto.createHash("sha256").update(String(repoRoot)).digest("hex").slice(0, 12) : null,
      solumbeVersion,
      node: process.version,
      signals: event.signals ?? null,
    };

    const logPath = telemetryLogPath(env);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Single-generation rotation so the log can never grow without bound.
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`);
    } catch {
      // no existing log, or rotation raced another process — either is fine
    }

    // O_APPEND + one writeSync keeps small lines best-effort atomic across the
    // CLI and a concurrent MCP server writing the same file.
    const fd = fs.openSync(logPath, "a");
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  } catch {
    // Telemetry must never break a command or pollute output.
    return null;
  }
}

/** @param {unknown} value */
function durationBucket(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 100) return "under_100ms";
  if (value < 1_000) return "100ms_to_1s";
  if (value < 5_000) return "1s_to_5s";
  if (value < 30_000) return "5s_to_30s";
  return "over_30s";
}

/** @param {string} value */
function normalizedPlatform(value) {
  return ["darwin", "linux", "win32"].includes(value) ? value : "other";
}

/** @param {unknown} value */
function normalizedCommand(value) {
  const command = typeof value === "string" ? value.toLowerCase() : "";
  return /^[a-z][a-z0-9_-]{0,63}$/.test(command) ? command : "other";
}

/** @param {unknown} value */
function normalizedVersion(value) {
  const version = typeof value === "string" ? value : "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version.slice(0, 32) : "0.0.0";
}

/** @param {NodeJS.ProcessEnv} env */
function getOrCreateAnonymousId(env) {
  const idPath = telemetryAnonymousIdPath(env);
  try {
    const existing = fs.readFileSync(idPath, "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
  } catch {
    // Create it below, only after the user explicitly opted into sharing.
  }

  const id = crypto.randomUUID();
  fs.mkdirSync(path.dirname(idPath), { recursive: true });
  try {
    fs.writeFileSync(idPath, `${id}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return id;
  } catch {
    try {
      const raced = fs.readFileSync(idPath, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(raced)) return raced;
    } catch {
      // best-effort only
    }
    return id;
  }
}

/**
 * Produce the only payload allowed to cross the network boundary. Notice what
 * is intentionally absent: repository/path hashes, prompts, argument shapes,
 * errors, result signals, receipt IDs, source content, and timestamps.
 * @param {Record<string, any>} record
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string }} [opts]
 */
export function buildSharedTelemetryPayload(record, opts = {}) {
  const env = opts.env ?? process.env;
  const nodeMajor = Number.parseInt(
    String(record.node ?? process.version)
      .replace(/^v/, "")
      .split(".")[0],
    10,
  );
  return {
    schema_version: TELEMETRY_SHARE_SCHEMA_VERSION,
    installation_id: getOrCreateAnonymousId(env),
    surface: record.surface === "mcp" ? "mcp" : "cli",
    command: normalizedCommand(record.cmd),
    outcome: ["error", "fail", "ok"].includes(record.outcome) ? record.outcome : "error",
    duration_bucket: durationBucket(record.durationMs),
    otito_version: normalizedVersion(record.solumbeVersion),
    node_major: Number.isInteger(nodeMajor) && nodeMajor >= 18 && nodeMajor <= 100 ? nodeMajor : 18,
    platform: normalizedPlatform(opts.platform ?? process.platform),
  };
}

/**
 * Best-effort anonymous delivery through the public relay. Never throws and
 * never writes to stdout/stderr, so deterministic CLI/MCP channels stay clean.
 * @param {Record<string, any> | null} record
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function shareEvent(record, opts = {}) {
  if (!record) return false;
  const env = opts.env ?? process.env;
  if (!isTelemetrySharingEnabled({ env, cwd: opts.cwd })) return false;

  const endpoint = env.SOLUMBE_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_SHARE_ENDPOINT;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return false;

    const controller = new globalThis.AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_SHARE_TIMEOUT_MS);
    try {
      const response = await (opts.fetchImpl ?? globalThis.fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSharedTelemetryPayload(record, { env })),
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

/**
 * Read all usage events from the log (and its rotated .1). Tolerant of torn or
 * unparseable lines (counted, not thrown) and of records from a newer schema
 * major (skipped, counted) so a downgrade never crashes the reader.
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ events: Record<string, any>[], skipped: number, skippedNewerSchema: number, path: string }}
 */
export function readTelemetryLog(opts = {}) {
  const env = opts.env ?? process.env;
  const logPath = telemetryLogPath(env);
  /** @type {Record<string, any>[]} */
  const events = [];
  let skipped = 0;
  let skippedNewerSchema = 0;

  for (const file of [`${logPath}.1`, logPath]) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue; // file may not exist
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof event?.v === "number" && event.v > TELEMETRY_SCHEMA_VERSION) {
        skippedNewerSchema += 1;
        continue;
      }
      events.push(event);
    }
  }
  return { events, skipped, skippedNewerSchema, path: logPath };
}

/**
 * Delete the usage log and its rotated generation. Best-effort.
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ removed: string[], path: string }}
 */
export function clearTelemetryLog(opts = {}) {
  const env = opts.env ?? process.env;
  const logPath = telemetryLogPath(env);
  /** @type {string[]} */
  const removed = [];
  for (const file of [logPath, `${logPath}.1`]) {
    try {
      fs.rmSync(file);
      removed.push(file);
    } catch {
      // not present — nothing to remove
    }
  }
  return { removed, path: logPath };
}

/**
 * Snapshot of the telemetry state for `solumbe telemetry status`.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {{ enabled: boolean, sharing: boolean, shareEndpoint: string, path: string, exists: boolean, sizeBytes: number, events: number }}
 */
export function telemetryStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const logPath = telemetryLogPath(env);
  let sizeBytes = 0;
  let exists = false;
  try {
    sizeBytes = fs.statSync(logPath).size;
    exists = true;
  } catch {
    // no log yet
  }
  const { events } = readTelemetryLog({ env });
  return {
    enabled: isTelemetryEnabled({ env, cwd: opts.cwd, fresh: true }),
    sharing: isTelemetrySharingEnabled({ env, cwd: opts.cwd, fresh: true }),
    shareEndpoint: env.SOLUMBE_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_SHARE_ENDPOINT,
    path: logPath,
    exists,
    sizeBytes,
    events: events.length,
  };
}
