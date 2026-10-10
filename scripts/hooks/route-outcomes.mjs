#!/usr/bin/env node
// Grades the route-prompt hook's decisions against what happened next in the
// same session.
//
// The decision log (`route-decisions.jsonl`, written by route-prompt.mjs)
// holds the tier each half of the router gave a prompt. The Claude Code
// transcript holds everything else: the prompts in order, the interruptions,
// and every file the assistant edited. Joined on the session id and the
// prompt's hash, each routed request gets two same-session outcomes:
//
//   corrected  the next prompt inside the window is an interruption, or opens
//              by pushing back (no / wrong / still / undo / why did you ...)
//   reworked   the assistant's next turn edits a file this turn edited, the
//              session-turn analogue of the commit join in `solumbe regret`
//
// Both are proxies with known failure modes, measured on 2026-09-26 and
// written up in docs/18: pushback catches the user's own typos and deploy
// failures as often as the model; rework catches iteration. They are printed
// with the same minimum-sample rule and intervals as regret, so an
// under-powered lane says so instead of publishing a rate.
//
// What the harness submitted itself (a task notification, a CI monitor event,
// the record of a `!` shell command) is not a request. The hook skips those
// now, but it routed them until 2026-09-27 and the log keeps the rows. They
// are left out of the grade and counted, and in the transcript they are
// neither a prompt nor anybody's follow-up.
//
//   node scripts/hooks/route-outcomes.mjs [--log <file>] [--transcripts <dir>]
//        [--window-min 60] [--min-sample 30] [--arm delegate|control|advisory] [--json]
//
// `--arm` grades one arm of the enforce-mode trial (route-prompt's
// SOLUMBE_ROUTE_MODE=delegate). Rows logged before the trial have no arm and
// count as `advisory`.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { wilson } from "../../src/lib/regret.js";
import { isHarnessPrompt, routeLogPath } from "./route-prompt.mjs";

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_based_edit_tool"]);
const CHECK_TOOL = /(?:^|__)(convergence_score|review_gate)$/;
const TIERS = ["cheap", "mid", "premium"];
const INTERRUPT = /^\[Request interrupted by user/;
const PUSHBACK =
  /^(no\b|nope|not\b|wrong|that'?s (not|wrong)|this is (not|wrong)|still\b|again\b|undo|revert|roll ?back|stop\b|wait\b|hold on|why (did|are|is|does|would)|you (didn'?t|did not|missed|broke|forgot|changed|removed|ignored|should)|i (said|asked|meant|told)|but\b|actually\b|instead\b|it'?s (not|still|broken)|doesn'?t|didn'?t|isn'?t|can'?t|won'?t|leave it|don'?t|dont\b|never)/i;

/** @param {string} text */
export function promptHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/** @param {string} text */
export function readsAsPushback(text) {
  return PUSHBACK.test(String(text).trim());
}

/**
 * The text of a user record, or null when it is a tool result, a meta record,
 * or has no text.
 * @param {any} record
 */
function promptText(record) {
  if (record?.type !== "user" || record.isSidechain || record.isMeta || "toolUseResult" in record) return null;
  const content = record.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
  return text || null;
}

/**
 * Every session in a transcripts directory: prompts, interruptions and the
 * assistant's file edits, in time order.
 *
 * A harness prompt is kept as a `harness` event holding only its hash, which
 * is all the decision log holds of it. It is read from the user record and
 * from the queue, because a notification that arrives in the middle of a turn
 * is filed as an attachment and never becomes a user record, while the queue
 * holds every one as the hook hashed it.
 * @param {string} dir `~/.claude/projects` or a directory shaped like it
 * @returns {Map<string, { ts: number, kind: "prompt"|"interrupt"|"edit"|"harness"|"check", text?: string, file?: string, uuid?: string, hash?: string, tool?: string }[]>}
 */
export function readSessions(dir) {
  /** @type {Map<string, any[]>} */
  const sessions = new Map();
  const files = [];
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    if (entry.endsWith(".jsonl")) files.push(full);
    else for (const inner of safeReaddir(full)) if (inner.endsWith(".jsonl")) files.push(path.join(full, inner));
  }
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"type":"queue-operation"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const sessionId = record?.sessionId;
      const ts = Date.parse(record?.timestamp ?? "");
      if (!sessionId || Number.isNaN(ts) || record.isSidechain) continue;
      const events = sessions.get(sessionId) ?? [];
      if (record.type === "assistant") {
        for (const block of Array.isArray(record.message?.content) ? record.message.content : []) {
          if (block?.type !== "tool_use") continue;
          // A call to one of solumbe's pre-commit checks, under whatever name
          // the host gave the server. check-outcomes.mjs joins these to the
          // check trial's decision log by tool and the hash of the request.
          const check = CHECK_TOOL.exec(String(block.name ?? ""));
          if (check) {
            events.push({ ts, kind: "check", tool: check[1], hash: promptHash(block.input?.query ?? block.input?.request ?? "") });
            continue;
          }
          if (!EDIT_TOOLS.has(block.name)) continue;
          const file = block.input?.file_path ?? block.input?.path;
          if (file) events.push({ ts, kind: "edit", file: String(file) });
        }
      } else if (record.type === "queue-operation") {
        if (record.operation !== "enqueue" || typeof record.content !== "string" || !isHarnessPrompt(record.content)) continue;
        events.push({ ts, kind: "harness", hash: promptHash(record.content) });
      } else {
        const text = promptText(record);
        if (!text) continue;
        if (isHarnessPrompt(text)) events.push({ ts, kind: "harness", hash: promptHash(text) });
        else events.push({ ts, kind: INTERRUPT.test(text) ? "interrupt" : "prompt", text, uuid: record.uuid });
      }
      sessions.set(sessionId, events);
    }
  }
  for (const [id, events] of sessions) {
    events.sort((a, b) => a.ts - b.ts);
    // The transcript can hold a prompt twice within seconds (a relocation
    // artefact). One copy is the prompt.
    const kept = [];
    let lastPrompt = null;
    for (const event of events) {
      if (event.kind === "prompt") {
        if (lastPrompt && lastPrompt.text === event.text && event.ts - lastPrompt.ts < 120000) continue;
        lastPrompt = event;
      }
      kept.push(event);
    }
    sessions.set(id, kept);
  }
  return sessions;
}

/** @param {string} dir */
function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Both outcomes for the prompt at `index` in a session's events.
 * @param {any[]} events
 * @param {number} index
 * @param {number} windowMs
 */
export function outcomesFor(events, index, windowMs) {
  const prompt = events[index];
  let next = -1;
  for (let i = index + 1; i < events.length; i++) {
    if (events[i].kind === "prompt" || events[i].kind === "interrupt") {
      next = i;
      break;
    }
  }
  if (next === -1 || events[next].ts - prompt.ts > windowMs) return { followUp: false, corrected: null, reworked: null };
  const corrected = events[next].kind === "interrupt" || readsAsPushback(events[next].text);
  const edited = new Set(
    events
      .slice(index + 1, next)
      .filter((e) => e.kind === "edit")
      .map((e) => e.file),
  );
  let after = events.length;
  for (let i = next + 1; i < events.length; i++) {
    if (events[i].kind === "prompt" || events[i].kind === "interrupt") {
      after = i;
      break;
    }
  }
  const editedNext = events.slice(next + 1, after).filter((e) => e.kind === "edit" && edited.has(e.file));
  return { followUp: true, corrected, reworked: edited.size ? editedNext.length > 0 : null };
}

/**
 * Join the log to the sessions and grade every variant per tier.
 * @param {Record<string, any>[]} records decision-log lines
 * @param {Map<string, any[]>} sessions
 * @param {{ windowMin?: number, minSample?: number, arm?: string }} [options]
 */
export function gradeDecisions(records, sessions, options = {}) {
  const windowMs = (options.windowMin ?? 60) * 60000;
  const minSample = options.minSample ?? 30;
  const rows = [];
  let unjoined = 0;
  let excluded = 0;
  let otherArm = 0;
  for (const record of records) {
    if (options.arm && (record?.arm ?? "advisory") !== options.arm) {
      otherArm += 1;
      continue;
    }
    const events = record?.sessionId ? sessions.get(record.sessionId) : null;
    // Routed before the hook skipped them. The log holds only a hash, so the
    // row is known by the hash of a harness prompt in its own session.
    if (events?.some((e) => e.kind === "harness" && e.hash === record.promptHash)) {
      excluded += 1;
      continue;
    }
    const recordTs = Date.parse(record?.ts ?? "");
    const index = events
      ? events.findIndex((e) => e.kind === "prompt" && promptHash(e.text) === record.promptHash && Math.abs(e.ts - recordTs) < 10 * 60000)
      : -1;
    if (!events || index === -1) {
      unjoined += 1;
      continue;
    }
    rows.push({ record, ...outcomesFor(events, index, windowMs) });
  }
  const graded = rows.filter((row) => row.followUp);
  /** @type {Record<string, any>} */
  const variants = {};
  for (const variant of ["deterministic", "offline", "jev"]) {
    const scoped = graded.filter((row) => row.record.tiers?.[variant]);
    if (!scoped.length) continue;
    const tiers = TIERS.map((tier) =>
      summarize(
        tier,
        scoped.filter((row) => row.record.tiers[variant] === tier),
        minSample,
      ),
    );
    const rates = tiers.map((row) => row.corrected.rate);
    variants[variant] = {
      n: scoped.length,
      tiers,
      monotonic: rates.every((rate) => rate !== null) ? rates[0] < rates[1] && rates[1] < rates[2] : null,
    };
  }
  return {
    records: records.length - otherArm,
    excluded,
    joined: rows.length,
    unjoined,
    graded: graded.length,
    windowMin: options.windowMin ?? 60,
    minSample,
    arm: options.arm ?? null,
    variants,
    caveats: [
      "`corrected` reads the user's next prompt: on the corpus it was audited on it caught the user's own typos, deploy failures and interruptions to add information as often as the model being wrong.",
      "`reworked` reads the assistant's next edits: iterating on a plan or a migration across prompts counts, so it measures iteration as much as repair.",
      "Rates over fewer than the minimum sample are withheld. A published rate carries a Wilson 95% interval; two rates whose intervals overlap are not shown to differ.",
      "The tier the session ran on is unknown. These grade what the router said, and only for the host the hook runs in.",
    ],
  };
}

/**
 * @param {string} name
 * @param {any[]} rows
 * @param {number} minSample
 */
function summarize(name, rows, minSample) {
  const stat = (/** @type {any[]} */ xs, /** @type {(row: any) => boolean} */ hit) => {
    const n = xs.length;
    const hits = xs.filter(hit).length;
    const publishable = n >= minSample;
    return { n, hits, rate: publishable && n ? round(hits / n) : null, ci95: publishable && n ? wilson(hits, n) : null, publishable };
  };
  const editing = rows.filter((row) => row.reworked !== null);
  return { name, corrected: stat(rows, (row) => row.corrected), reworked: stat(editing, (row) => row.reworked) };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {ReturnType<typeof gradeDecisions>} data */
export function formatOutcomes(data) {
  const pct = (/** @type {number|null} */ v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const cell = (/** @type {any} */ s) =>
    s.publishable ? `${s.n} · ${pct(s.rate)} (${pct(s.ci95[0])} to ${pct(s.ci95[1])})` : `${s.n} · ${s.hits} _(n < ${data.minSample}, withheld)_`;
  const lines = [
    `# Route outcomes, same session${data.arm ? ` (${data.arm} arm)` : ""}`,
    "",
    `Decisions: ${data.records} logged, ${data.excluded} excluded as harness prompts (task notifications, CI monitor events, shell records), ${data.joined} joined to a transcript prompt (${data.unjoined} not found), ${data.graded} with a follow-up inside ${data.windowMin} minutes. Minimum sample: ${data.minSample}.`,
    "",
  ];
  for (const [variant, grade] of Object.entries(data.variants)) {
    lines.push(`## ${variant}`, "", `| Tier | corrected | reworked (of editing requests) |`, `| --- | --- | --- |`);
    for (const tier of grade.tiers) lines.push(`| ${tier.name} | ${cell(tier.corrected)} | ${cell(tier.reworked)} |`);
    lines.push(
      "",
      `Monotonic on corrected (cheap < mid < premium): ${grade.monotonic === null ? "unknown (a tier fell below the minimum sample)" : grade.monotonic ? "yes" : "no"}`,
      "",
    );
  }
  if (!Object.keys(data.variants).length) lines.push("Nothing to grade yet: no logged decision joined to a prompt with a follow-up.", "");
  lines.push("## Caveats", "", ...data.caveats.map((c) => `- ${c}`));
  return lines.join("\n");
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else flags[key] = true;
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const logPath = typeof flags.log === "string" ? flags.log : routeLogPath();
  const transcripts = typeof flags.transcripts === "string" ? flags.transcripts : path.join(os.homedir(), ".claude", "projects");
  if (!logPath) throw new Error("no decision log: SOLUMBE_ROUTE_LOG is off; pass --log <file>");
  let raw = "";
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    throw new Error(`no decision log at ${logPath}; the route-prompt hook writes it once wired in`);
  }
  const records = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record && record.v === 1);
  const data = gradeDecisions(records, readSessions(transcripts), {
    windowMin: flags["window-min"] === undefined ? undefined : Number(flags["window-min"]),
    minSample: flags["min-sample"] === undefined ? undefined : Number(flags["min-sample"]),
    arm: typeof flags.arm === "string" ? flags.arm : undefined,
  });
  process.stdout.write(flags.json ? `${JSON.stringify({ ok: true, log: logPath, transcripts, ...data }, null, 2)}\n` : `${formatOutcomes(data)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`route-outcomes: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exit(1);
  }
}
