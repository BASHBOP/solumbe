// `solumbe dashboard`: aggregate the local usage log (plus existing .solumbe
// JSON artifacts and recent git history) into ONE self-contained HTML file —
// no server, no chart library, no network. The HTML embeds its own data and
// hand-rolled inline-SVG charts so it opens straight off disk via file://.
//
// Two halves, both pure and fixture-testable:
//   - aggregate(events, extra): events + artifacts + git -> a rollup object
//   - renderDashboardHtml(rollup): rollup -> a standalone HTML string
// Every tile and chart carries an interpretation tooltip, and a non-negotiable
// "what this can't show" panel keeps the coverage gaps honest.

import fs from "node:fs";
import path from "node:path";
import { readTelemetryLog } from "./telemetry.js";
import { extractSignals } from "./telemetry.js";
import { inspectRepo } from "./repo.js";
import { runCommand } from "./tools.js";

/**
 * @param {string} repoPath
 * @param {{ env?: NodeJS.ProcessEnv, includeArtifacts?: boolean, includeGit?: boolean }} [options]
 * @returns {{ data: Record<string, any>, html: string }}
 */
export function generateDashboard(repoPath = ".", options = {}) {
  const env = options.env ?? process.env;
  const { events, skipped, skippedNewerSchema, path: logPath } = readTelemetryLog({ env });

  let root = path.resolve(repoPath);
  let repoName = path.basename(root);
  try {
    const repo = inspectRepo(repoPath);
    root = repo.root ?? root;
    repoName = repo.package?.name ?? path.basename(root);
  } catch {
    // repo inspection is best-effort; the log alone is enough to render
  }

  const artifacts = options.includeArtifacts === false ? [] : scanArtifacts(root);
  const git = options.includeGit === false ? [] : mineGit(root);

  const data = aggregate(events, { repoName, root, logPath, skipped, skippedNewerSchema, artifacts, git });
  return { data, html: renderDashboardHtml(data) };
}

/**
 * Roll a flat event list (and optional artifacts/git) into dashboard-ready
 * aggregates. Pure: no IO, no clock except the caller-supplied scan time.
 * @param {Record<string, any>[]} events
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
export function aggregate(events, extra = {}) {
  const list = Array.isArray(events) ? events : [];

  /** @type {Map<string, { cmd: string, count: number, durations: number[], tokens: number[], surfaces: Set<string> }>} */
  const byCommand = new Map();
  /** @type {Record<string, number>} */
  const surfaceCounts = { cli: 0, mcp: 0 };
  /** @type {Record<string, number>} */
  const outcomeCounts = { ok: 0, fail: 0, error: 0 };
  /** @type {Record<string, number>} */
  const verdictCounts = { PASS: 0, WARN: 0, FAIL: 0 };
  const repos = new Set();
  /** @type {{ ts: number, value: number }[]} */
  const convergenceSeries = [];
  /** @type {number[]} */
  const allDurations = [];
  let latestEval = null;
  let tsMin = Infinity;
  let tsMax = -Infinity;

  for (const e of list) {
    const cmd = typeof e.cmd === "string" ? e.cmd : "unknown";
    let bucket = byCommand.get(cmd);
    if (!bucket) {
      bucket = { cmd, count: 0, durations: [], tokens: [], surfaces: new Set() };
      byCommand.set(cmd, bucket);
    }
    bucket.count += 1;
    if (typeof e.surface === "string") {
      bucket.surfaces.add(e.surface);
      if (e.surface === "cli" || e.surface === "mcp") surfaceCounts[e.surface] += 1;
    }
    if (typeof e.durationMs === "number") {
      bucket.durations.push(e.durationMs);
      allDurations.push(e.durationMs);
    }
    const outcome = e.outcome === "fail" || e.outcome === "error" ? e.outcome : "ok";
    outcomeCounts[outcome] += 1;
    if (typeof e.repo === "string") repos.add(e.repo);
    if (typeof e.ts === "number") {
      tsMin = Math.min(tsMin, e.ts);
      tsMax = Math.max(tsMax, e.ts);
    }
    const sig = e.signals && typeof e.signals === "object" ? e.signals : {};
    if (typeof sig.tokenEstimate === "number") bucket.tokens.push(sig.tokenEstimate);
    if (sig.verdict === "PASS" || sig.verdict === "WARN" || sig.verdict === "FAIL") verdictCounts[sig.verdict] += 1;
    if (typeof sig.convergence === "number" && typeof e.ts === "number") convergenceSeries.push({ ts: e.ts, value: sig.convergence });
    if (typeof sig.savedPct === "number") {
      if (!latestEval || (typeof e.ts === "number" && e.ts >= (latestEval.ts ?? 0))) {
        latestEval = { ts: e.ts ?? 0, savedPct: sig.savedPct, savedTokens: typeof sig.savedTokens === "number" ? sig.savedTokens : null };
      }
    }
  }

  const commands = Array.from(byCommand.values())
    .map((b) => ({
      cmd: b.cmd,
      count: b.count,
      surface: b.surfaces.has("mcp") && b.surfaces.has("cli") ? "both" : b.surfaces.has("mcp") ? "mcp" : "cli",
      medianDurationMs: median(b.durations),
      medianTokens: median(b.tokens),
    }))
    .sort((a, b) => b.count - a.count);

  convergenceSeries.sort((a, b) => a.ts - b.ts);

  const totalVerdicts = verdictCounts.PASS + verdictCounts.WARN + verdictCounts.FAIL;
  const passRate = totalVerdicts ? Math.round((100 * verdictCounts.PASS) / totalVerdicts) : null;

  const blindSpots = buildBlindSpots({
    total: list.length,
    hasLatency: allDurations.length > 0,
    hasVerdicts: totalVerdicts > 0,
    hasEval: Boolean(latestEval),
    skipped: extra.skipped ?? 0,
    skippedNewerSchema: extra.skippedNewerSchema ?? 0,
  });

  return {
    ok: true,
    repo: { name: extra.repoName ?? "repo", root: extra.root ?? "" },
    logPath: extra.logPath ?? "",
    totals: {
      events: list.length,
      cli: surfaceCounts.cli,
      mcp: surfaceCounts.mcp,
      distinctRepos: repos.size,
      medianDurationMs: median(allDurations),
      p95DurationMs: percentile(allDurations, 95),
      passRate,
    },
    outcomes: outcomeCounts,
    verdicts: verdictCounts,
    commands,
    convergenceSeries,
    latestEval,
    timeRange: tsMin === Infinity ? null : { from: tsMin, to: tsMax },
    artifacts: Array.isArray(extra.artifacts) ? extra.artifacts : [],
    git: Array.isArray(extra.git) ? extra.git : [],
    blindSpots,
    skipped: extra.skipped ?? 0,
    skippedNewerSchema: extra.skippedNewerSchema ?? 0,
  };
}

/**
 * Classify each .solumbe/*.json artifact by its discriminating keys and pull
 * the value signals it persisted. Best-effort and read-only.
 * @param {string} root
 * @returns {{ file: string, kind: string, signals: Record<string, any> | null }[]}
 */
export function scanArtifacts(root) {
  const dir = path.join(root, ".solumbe");
  /** @type {{ file: string, kind: string, signals: Record<string, any> | null }[]} */
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "index.json" || name === "catalog.json") continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    out.push({ file: name, kind: classifyArtifact(data), signals: extractSignals(data) });
  }
  return out;
}

/**
 * @param {any} data
 * @returns {string}
 */
function classifyArtifact(data) {
  if (!data || typeof data !== "object") return "unknown";
  if (typeof data.convergence === "number" || data.convergenceEngineVersion) return "converge";
  if (typeof data.ax === "number") return "ax";
  if (data.totals && typeof data.totals.savedTokens === "number") return "eval";
  if (data.validation) return "impact";
  if (typeof data.verdict === "string") return "gate";
  if (data.summary && Array.isArray(data.files)) return "map";
  return "report";
}

/**
 * Recent commit subjects, for an at-a-glance activity timeline. One git call.
 * @param {string} root
 * @param {number} [limit]
 * @returns {{ sha: string, date: string, subject: string }[]}
 */
export function mineGit(root, limit = 12) {
  const result = runCommand("git", ["log", `-n${limit}`, "--pretty=%h%x1f%aI%x1f%s"], { cwd: root });
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split("\x1f");
      return { sha: sha ?? "", date: date ?? "", subject: subject ?? "" };
    });
}

/**
 * @param {{ total: number, hasLatency: boolean, hasVerdicts: boolean, hasEval: boolean, skipped: number, skippedNewerSchema: number }} input
 * @returns {string[]}
 */
function buildBlindSpots(input) {
  const spots = [
    "Only runs made after telemetry was enabled appear here — earlier usage is invisible.",
    "Value signals (tokens, verdicts, convergence) show only for commands that produce them; map/search/doctor contribute usage and latency only.",
    "Token savings vs naive is a relative cross-build byte-ratio delta from `solumbe eval`, not an absolute guarantee.",
    "The repo key is a one-way hash — non-reversible, but confirmable against a candidate path; it is not anonymity.",
  ];
  if (!input.total) spots.unshift("No events recorded yet. Enable telemetry (`solumbe config set telemetry true`) and run a few commands.");
  if (input.total && !input.hasLatency) spots.push("No latency captured yet for these events.");
  if (input.total && !input.hasVerdicts) spots.push("No merge-gate runs recorded, so the verdict mix is empty.");
  if (input.total && !input.hasEval) spots.push("No `solumbe eval` run recorded, so token-savings is unavailable.");
  if (input.skipped) spots.push(`${input.skipped} unparseable log line(s) were skipped (likely torn concurrent writes).`);
  if (input.skippedNewerSchema) spots.push(`${input.skippedNewerSchema} event(s) from a newer schema version were ignored.`);
  return spots;
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/**
 * @param {number[]} values
 * @param {number} p
 * @returns {number | null}
 */
function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return Math.round(s[idx]);
}

/**
 * @param {string} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * An interpretation tooltip: an info marker with an accessible label plus a
 * CSS-only hover/focus bubble (no JS — the file must work straight off disk).
 * @param {string} text
 * @returns {string}
 */
function tip(text) {
  const t = esc(text);
  return `<span class="tip" tabindex="0" role="note" aria-label="${t}"><span class="tipmark" aria-hidden="true">i</span><span class="tiptext">${t}</span></span>`;
}

/**
 * @param {number | null} n
 * @param {string} [suffix]
 * @returns {string}
 */
function fmt(n, suffix = "") {
  if (n === null || n === undefined) return "—";
  return `${typeof n === "number" ? n.toLocaleString() : n}${suffix}`;
}

/**
 * Render the full standalone HTML document.
 * @param {Record<string, any>} d
 * @returns {string}
 */
export function renderDashboardHtml(d) {
  const t = d.totals ?? {};
  const range = d.timeRange
    ? `${new Date(d.timeRange.from).toISOString().slice(0, 10)} → ${new Date(d.timeRange.to).toISOString().slice(0, 10)}`
    : "no data yet";

  const tiles = [
    {
      label: "Invocations",
      value: fmt(t.events),
      sub: `${fmt(t.cli)} cli · ${fmt(t.mcp)} mcp`,
      tip: "Total CLI runs plus MCP tool calls recorded while telemetry was on. Only runs after you enabled telemetry are counted.",
    },
    {
      label: "Median latency",
      value: t.medianDurationMs === null ? "—" : `${fmt(t.medianDurationMs)} ms`,
      sub: t.p95DurationMs === null ? "no timing yet" : `p95 ${fmt(t.p95DurationMs)} ms`,
      tip: "Median wall-clock time per run, with the 95th percentile alongside. Latency exists only for runs made after telemetry was enabled.",
    },
    {
      label: "Token savings vs naive",
      value: d.latestEval ? `${Math.round(d.latestEval.savedPct)}%` : "—",
      sub: d.latestEval && d.latestEval.savedTokens != null ? `${fmt(d.latestEval.savedTokens)} tokens` : "run `solumbe eval`",
      tip: "From the latest `solumbe eval`: how much smaller solumbe's context is than feeding whole files to the agent. A relative byte-ratio delta, not an absolute guarantee.",
    },
    {
      label: "Gate pass rate",
      value: t.passRate === null ? "—" : `${t.passRate}%`,
      sub: `${fmt(d.verdicts?.WARN ?? 0)} warn · ${fmt(d.verdicts?.FAIL ?? 0)} fail`,
      tip: "Share of merge-gate runs (gate / pass / review) that returned PASS. WARN means take a look; FAIL means blocked.",
    },
  ];

  const tilesHtml = tiles
    .map(
      (x) =>
        `<div class="tile"><div class="tile-label">${esc(x.label)} ${tip(x.tip)}</div><div class="tile-value">${x.value}</div><div class="tile-sub">${esc(x.sub)}</div></div>`,
    )
    .join("");

  const commandRows = (d.commands ?? []).slice(0, 10);
  const maxCount = commandRows.reduce((/** @type {number} */ m, /** @type {any} */ c) => Math.max(m, c.count), 0) || 1;
  const commandBars = commandRows.length
    ? commandRows
        .map((/** @type {any} */ c) => {
          const pct = Math.round((100 * c.count) / maxCount);
          const lat = c.medianDurationMs === null ? "" : ` · ${fmt(c.medianDurationMs)} ms`;
          return `<div class="bar-row"><div class="bar-label">${esc(c.cmd)}<span class="bar-surface">${esc(c.surface)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="bar-value">${fmt(c.count)}${lat}</div></div>`;
        })
        .join("")
    : `<p class="empty">No commands recorded yet.</p>`;

  const v = d.verdicts ?? { PASS: 0, WARN: 0, FAIL: 0 };
  const verdictHtml = renderVerdictBar(v);
  const convHtml = renderSparkline(d.convergenceSeries ?? []);

  const artifactRows = (d.artifacts ?? []).slice(0, 12);
  const artifactsHtml = artifactRows.length
    ? `<table class="grid-table"><thead><tr><th>artifact</th><th>kind</th><th>signal</th></tr></thead><tbody>${artifactRows
        .map((/** @type {any} */ a) => `<tr><td><code>${esc(a.file)}</code></td><td>${esc(a.kind)}</td><td>${esc(summarizeSignal(a.signals))}</td></tr>`)
        .join("")}</tbody></table>`
    : `<p class="empty">No machine-readable artifacts in .solumbe yet.</p>`;

  const gitRows = (d.git ?? []).slice(0, 10);
  const gitHtml = gitRows.length
    ? `<ul class="git-list">${gitRows.map((/** @type {any} */ g) => `<li><code>${esc(g.sha)}</code> <span class="git-date">${esc((g.date || "").slice(0, 10))}</span> ${esc(g.subject)}</li>`).join("")}</ul>`
    : `<p class="empty">No git history available.</p>`;

  const blindSpots = (d.blindSpots ?? []).map((/** @type {string} */ s) => `<li>${esc(s)}</li>`).join("");

  const embedded = esc(JSON.stringify(d));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>solumbe · usage & performance — ${esc(d.repo?.name ?? "repo")}</title>
<style>
:root{--bg:#fbfbfa;--surface:#fff;--ink:#1d1c1a;--muted:#5f5e5a;--faint:#88877f;--line:rgba(0,0,0,.1);--blue:#378ADD;--teal:#1D9E75;--amber:#EF9F27;--red:#E24B4A;--gray:#B4B2A9;}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a18;--surface:#232320;--ink:#ededdf;--muted:#aaa99f;--faint:#88877f;--line:rgba(255,255,255,.12);}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;padding:24px;}
.wrap{max-width:980px;margin:0 auto;}
h1{font-size:20px;font-weight:500;margin:0;}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;}
.badges{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.pill{font-size:12px;color:var(--muted);border:.5px solid var(--line);border-radius:8px;padding:4px 10px;}
.pill.ok{color:#0f6e56;background:rgba(29,158,117,.12);border:none;}
.grid{display:grid;gap:12px;}
.tiles{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:14px;}
.tile{background:var(--surface);border:.5px solid var(--line);border-radius:12px;padding:14px 16px;}
.tile-label{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px;}
.tile-value{font-size:26px;font-weight:500;margin-top:4px;}
.tile-sub{font-size:12px;color:var(--faint);margin-top:4px;}
.cards{grid-template-columns:repeat(auto-fit,minmax(300px,1fr));}
.card{background:var(--surface);border:.5px solid var(--line);border-radius:12px;padding:16px 18px;}
.card h2{font-size:14px;font-weight:500;margin:0 0 12px;color:var(--muted);display:flex;align-items:center;gap:6px;}
.bar-row{display:grid;grid-template-columns:120px 1fr auto;gap:10px;align-items:center;margin-bottom:8px;font-size:13px;}
.bar-label{display:flex;flex-direction:column;font-size:12px;overflow:hidden;text-overflow:ellipsis;}
.bar-surface{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;}
.bar-track{height:10px;background:var(--line);border-radius:6px;overflow:hidden;}
.bar-fill{height:100%;background:var(--blue);border-radius:6px;}
.bar-value{font-size:12px;color:var(--muted);white-space:nowrap;}
.vbar{display:flex;height:26px;border-radius:6px;overflow:hidden;border:.5px solid var(--line);}
.vbar span{display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;}
.vlegend{display:flex;gap:14px;margin-top:10px;font-size:12px;color:var(--muted);flex-wrap:wrap;}
.dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:5px;vertical-align:-1px;}
.grid-table{width:100%;border-collapse:collapse;font-size:12px;}
.grid-table th{text-align:left;color:var(--faint);font-weight:400;padding:4px 6px;border-bottom:.5px solid var(--line);}
.grid-table td{padding:5px 6px;border-bottom:.5px solid var(--line);}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
.git-list{list-style:none;margin:0;padding:0;font-size:12px;}
.git-list li{padding:4px 0;border-bottom:.5px solid var(--line);}
.git-date{color:var(--faint);margin:0 6px;}
.empty{font-size:13px;color:var(--faint);margin:6px 0;}
.honesty{background:rgba(239,159,39,.08);border:.5px solid rgba(239,159,39,.4);border-radius:12px;padding:14px 18px;margin-top:16px;}
.honesty h2{color:#854f0b;font-size:14px;font-weight:500;margin:0 0 8px;}
@media (prefers-color-scheme:dark){.honesty h2{color:#FAC775;}}
.honesty ul{margin:0;padding-left:18px;font-size:13px;color:var(--muted);}
.honesty li{margin:4px 0;}
.foot{font-size:12px;color:var(--faint);margin-top:16px;display:flex;align-items:center;gap:6px;}
.tip{position:relative;display:inline-flex;cursor:help;}
.tipmark{width:15px;height:15px;border-radius:50%;border:.5px solid var(--faint);color:var(--faint);font-size:10px;font-style:italic;line-height:14px;text-align:center;}
.tiptext{visibility:hidden;opacity:0;position:absolute;left:0;top:20px;z-index:20;width:240px;background:var(--ink);color:var(--bg);font-size:12px;line-height:1.45;padding:8px 10px;border-radius:8px;transition:opacity .12s;}
.tip:hover .tiptext,.tip:focus .tiptext{visibility:visible;opacity:1;}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}
</style>
</head>
<body>
<div class="wrap">
<h2 class="sr">solumbe usage and performance dashboard for ${esc(d.repo?.name ?? "repo")}: invocations, latency, token savings versus a naive baseline, top commands, merge-gate verdicts, and the limits of what this view can show. Hover the i markers for how to read each panel.</h2>
<div class="head">
  <div>
    <h1>solumbe · usage & performance</h1>
    <div style="font-size:13px;color:var(--muted);margin-top:2px;">${esc(d.repo?.name ?? "repo")} · ${esc(range)}</div>
  </div>
  <div class="badges">
    <span class="pill ok">local-only</span>
    <span class="pill">${fmt(t.distinctRepos)} repos</span>
    <span class="pill">${fmt(t.events)} events</span>
  </div>
</div>

<div class="grid tiles">${tilesHtml}</div>

<div class="grid cards">
  <div class="card">
    <h2>Top commands & tools ${tip("How often each command or MCP tool ran, with its median latency. Bar length is the run count relative to the busiest command.")}</h2>
    ${commandBars}
  </div>
  <div class="card">
    <h2>Merge-gate verdicts ${tip("Outcome of every merge-gate run (gate / pass / review). PASS = ready to merge, WARN = needs a human look, FAIL = blocked by a check.")}</h2>
    ${verdictHtml}
  </div>
  <div class="card">
    <h2>Convergence over time ${tip("`solumbe converge` score 0–100: how closely the actual git diff matched the stated task. Higher is more aligned; dips flag scope drift.")}</h2>
    ${convHtml}
  </div>
  <div class="card">
    <h2>Recent artifacts ${tip("Machine-readable JSON reports already written under .solumbe, classified by type with their headline signal. Independent of the usage log.")}</h2>
    ${artifactsHtml}
  </div>
  <div class="card">
    <h2>Recent commits ${tip("Latest commit subjects from git log, for at-a-glance activity. Provenance only — not tied to specific solumbe runs.")}</h2>
    ${gitHtml}
  </div>
</div>

<div class="honesty">
  <h2>What this can't show</h2>
  <ul>${blindSpots}</ul>
</div>

<div class="foot">Opt-in local telemetry · ${esc(d.logPath ?? "")} · anonymous sharing is a separate opt-in · clear with <code>solumbe telemetry clear</code></div>
</div>
<script type="application/json" id="solumbe-dashboard-data">${embedded}</script>
</body>
</html>`;
}

/**
 * @param {{ PASS: number, WARN: number, FAIL: number }} v
 * @returns {string}
 */
function renderVerdictBar(v) {
  const total = v.PASS + v.WARN + v.FAIL;
  if (!total) return `<p class="empty">No merge-gate runs recorded yet.</p>`;
  const seg = (/** @type {number} */ n, /** @type {string} */ color, /** @type {string} */ dark) =>
    n ? `<span style="width:${(100 * n) / total}%;background:${color};color:${dark}">${Math.round((100 * n) / total)}%</span>` : "";
  return `<div class="vbar">${seg(v.PASS, "#1D9E75", "#04342C")}${seg(v.WARN, "#EF9F27", "#412402")}${seg(v.FAIL, "#E24B4A", "#fff")}</div>
  <div class="vlegend"><span><span class="dot" style="background:#1D9E75"></span>pass ${v.PASS}</span><span><span class="dot" style="background:#EF9F27"></span>warn ${v.WARN}</span><span><span class="dot" style="background:#E24B4A"></span>fail ${v.FAIL}</span></div>`;
}

/**
 * @param {{ ts: number, value: number }[]} series
 * @returns {string}
 */
function renderSparkline(series) {
  if (!series.length) return `<p class="empty">No convergence runs recorded yet.</p>`;
  const w = 280;
  const h = 90;
  const pad = 6;
  const n = series.length;
  const pts = series.map((p, i) => {
    const x = n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1);
    const y = h - pad - (Math.max(0, Math.min(100, p.value)) / 100) * (h - 2 * pad);
    return `${Math.round(x)},${Math.round(y)}`;
  });
  const last = series[series.length - 1].value;
  const dots = pts.map((p) => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="2.5" fill="#534AB7" />`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Convergence score over ${n} runs, latest ${Math.round(last)} out of 100">
  <polyline points="${pts.join(" ")}" fill="none" stroke="#534AB7" stroke-width="2" stroke-linejoin="round" />
  ${dots}
  </svg>
  <div style="font-size:12px;color:var(--muted);margin-top:4px;">${n} run${n === 1 ? "" : "s"} · latest ${Math.round(last)}/100</div>`;
}

/**
 * @param {Record<string, any> | null} signals
 * @returns {string}
 */
function summarizeSignal(signals) {
  if (!signals) return "—";
  if (typeof signals.convergence === "number") return `convergence ${signals.convergence}`;
  if (signals.band === "inconclusive") return "convergence inconclusive";
  if (typeof signals.ax === "number") return `AX ${signals.ax}`;
  if (typeof signals.savedPct === "number") return `saved ${Math.round(signals.savedPct)}%`;
  if (typeof signals.verdict === "string") return `verdict ${signals.verdict}`;
  if (typeof signals.tokenEstimate === "number") return `${signals.tokenEstimate.toLocaleString()} tokens`;
  return "—";
}
