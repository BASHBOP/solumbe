#!/usr/bin/env node
// Grades the two arms of the check trial on what happened next in the same
// session.
//
// `solumbe calibrate --trial` grades the trial on commits: was the change made
// with the checks shown repaired less often than the one made with them
// withheld. That answer takes weeks to arrive. This is the faster one, read
// from the Claude Code transcript the way route-outcomes.mjs reads it:
//
//   corrected  the next prompt is an interruption, or opens by pushing back
//   reworked   the assistant's next turn edits a file this turn edited
//
// The decision log (`check-decisions.jsonl`, written by the MCP server under
// SOLUMBE_CHECK_MODE=trial) holds the arm of every check. A decision joins to
// the tool call in a transcript by the tool and the hash of its request, and
// the request it grades is the prompt that call was made under. A prompt
// counts once, in the arm of its first check.
//
// Both outcomes are the proxies route-outcomes.mjs documents, with the same
// minimum-sample rule and intervals.
//
//   node scripts/hooks/check-outcomes.mjs [--log <file>] [--transcripts <dir>]
//        [--window-min 60] [--min-sample 30] [--json]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkLogPath, readDecisions } from "../../src/lib/check-trial.js";
import { wilson } from "../../src/lib/regret.js";
import { outcomesFor, readSessions } from "./route-outcomes.mjs";

const ARMS = ["shown", "withheld"];
// A decision is logged when the tool returns; the transcript stamps the call
// when the assistant made it. A replay or a slow dispatch can sit between.
const JOIN_WINDOW_MS = 10 * 60000;

/**
 * Join the decision log to the sessions and grade each arm.
 * @param {Record<string, any>[]} decisions check-decision log lines
 * @param {Map<string, any[]>} sessions
 * @param {{ windowMin?: number, minSample?: number }} [options]
 */
export function gradeCheckOutcomes(decisions, sessions, options = {}) {
  const windowMs = (options.windowMin ?? 60) * 60000;
  const minSample = options.minSample ?? 30;

  /** @type {{ sessionId: string, events: any[], index: number, used: boolean }[]} */
  const calls = [];
  for (const [sessionId, events] of sessions) {
    events.forEach((event, index) => {
      if (event.kind === "check") calls.push({ sessionId, events, index, used: false });
    });
  }

  /** @type {Map<string, { arm: string, checks: number, outcome: ReturnType<typeof outcomesFor> }>} */
  const prompts = new Map();
  let unjoined = 0;
  let noPrompt = 0;
  for (const decision of [...decisions].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const ts = Date.parse(decision.ts ?? "");
    const call = calls
      .filter((entry) => {
        const event = entry.events[entry.index];
        return !entry.used && event.tool === decision.tool && event.hash === decision.requestHash && Math.abs(event.ts - ts) < JOIN_WINDOW_MS;
      })
      .sort((a, b) => Math.abs(a.events[a.index].ts - ts) - Math.abs(b.events[b.index].ts - ts))[0];
    if (!call) {
      unjoined += 1;
      continue;
    }
    call.used = true;
    let promptIndex = -1;
    for (let i = call.index - 1; i >= 0; i--) {
      if (call.events[i].kind === "prompt") {
        promptIndex = i;
        break;
      }
    }
    if (promptIndex === -1) {
      noPrompt += 1;
      continue;
    }
    const key = `${call.sessionId}:${promptIndex}`;
    const known = prompts.get(key);
    if (known) known.checks += 1;
    else prompts.set(key, { arm: decision.arm, checks: 1, outcome: outcomesFor(call.events, promptIndex, windowMs) });
  }

  const rows = [...prompts.values()];
  const arms = ARMS.map((arm) => {
    const graded = rows.filter((row) => row.arm === arm && row.outcome.followUp);
    const editing = graded.filter((row) => row.outcome.reworked !== null);
    return {
      name: arm,
      prompts: rows.filter((row) => row.arm === arm).length,
      corrected: proportion(graded.filter((row) => row.outcome.corrected).length, graded.length, minSample),
      reworked: proportion(editing.filter((row) => row.outcome.reworked).length, editing.length, minSample),
    };
  });
  const [shown, withheld] = arms;
  const fewer = (/** @type {"corrected"|"reworked"} */ outcome) =>
    shown[outcome].ci95 && withheld[outcome].ci95 ? shown[outcome].ci95[1] < withheld[outcome].ci95[0] : null;

  return {
    decisions: decisions.length,
    joined: decisions.length - unjoined,
    unjoined,
    noPrompt,
    prompts: rows.length,
    graded: rows.filter((row) => row.outcome.followUp).length,
    windowMin: options.windowMin ?? 60,
    minSample,
    arms,
    // Fewer corrections or less rework in the shown arm than the intervals
    // allow for. Null until both arms clear the minimum sample.
    fewerWhenShown: { corrected: fewer("corrected"), reworked: fewer("reworked") },
    caveats: [
      "`corrected` reads the user's next prompt: on the corpus it was audited on it caught the user's own typos, deploy failures and interruptions to add information as often as the model being wrong.",
      "`reworked` reads the assistant's next edits: iterating on a plan or a migration across prompts counts, so it measures iteration as much as repair.",
      "A prompt is graded in the arm of its first check. A blocking FAIL is shown in both arms, and the command line is never withheld, so the arms differ by less than their names say.",
      "Rates over fewer than the minimum sample are withheld. A published rate carries a Wilson 95% interval; two rates whose intervals overlap are not shown to differ.",
      "Only the hosts whose transcripts are read here are graded, and only checks made through the MCP server.",
    ],
  };
}

/**
 * @param {number} hits
 * @param {number} n
 * @param {number} minSample
 * @returns {{ hits: number, n: number, rate: number|null, ci95: [number, number]|null, publishable: boolean }}
 */
function proportion(hits, n, minSample) {
  const publishable = n >= minSample;
  return { hits, n, rate: publishable && n ? Math.round((hits / n) * 1000) / 1000 : null, ci95: publishable && n ? wilson(hits, n) : null, publishable };
}

/** @param {ReturnType<typeof gradeCheckOutcomes>} data */
export function formatCheckOutcomes(data) {
  const pct = (/** @type {number|null} */ v) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const cell = (/** @type {any} */ s) =>
    s.publishable ? `${s.n} · ${pct(s.rate)} (${pct(s.ci95[0])} to ${pct(s.ci95[1])})` : `${s.n} · ${s.hits} _(n < ${data.minSample}, withheld)_`;
  const differ = (/** @type {boolean|null} */ v) => (v === null ? "unknown (an arm fell below the minimum sample)" : v ? "yes" : "no — the intervals overlap");
  return [
    "# Check trial outcomes, same session",
    "",
    `Decisions: ${data.decisions} logged, ${data.joined} joined to a tool call in a transcript (${data.unjoined} not found), ${data.prompts} prompts, ${data.graded} with a follow-up inside ${data.windowMin} minutes. Minimum sample: ${data.minSample}.`,
    "",
    "| Arm | prompts | corrected | reworked (of editing requests) |",
    "| --- | ---: | --- | --- |",
    ...data.arms.map((arm) => `| ${arm.name} | ${arm.prompts} | ${cell(arm.corrected)} | ${cell(arm.reworked)} |`),
    "",
    `Fewer corrections when the checks were shown: ${differ(data.fewerWhenShown.corrected)}`,
    `Less rework when the checks were shown: ${differ(data.fewerWhenShown.reworked)}`,
    "",
    "## Caveats",
    "",
    ...data.caveats.map((c) => `- ${c}`),
  ].join("\n");
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
  const logPath = typeof flags.log === "string" ? path.resolve(flags.log) : checkLogPath();
  const transcripts = typeof flags.transcripts === "string" ? flags.transcripts : path.join(os.homedir(), ".claude", "projects");
  if (!logPath) throw new Error("no decision log: SOLUMBE_CHECK_LOG is off; pass --log <file>");
  if (!fs.existsSync(logPath)) throw new Error(`no decision log at ${logPath}; the MCP server writes it under SOLUMBE_CHECK_MODE=trial`);
  const data = gradeCheckOutcomes(readDecisions(logPath), readSessions(transcripts), {
    windowMin: flags["window-min"] === undefined ? undefined : Number(flags["window-min"]),
    minSample: flags["min-sample"] === undefined ? undefined : Number(flags["min-sample"]),
  });
  process.stdout.write(flags.json ? `${JSON.stringify({ ok: true, log: logPath, transcripts, ...data }, null, 2)}\n` : `${formatCheckOutcomes(data)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`check-outcomes: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exit(1);
  }
}
