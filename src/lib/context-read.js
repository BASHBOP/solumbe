// Opt-in: sharpen a context pack with a System One read of the request.
//
// solumbe ranks files from repository evidence: paths, symbols, imports. It has
// never read a request as language, so it cannot tell what kind of work a
// request asks for, and it ranks a file that merely shares vocabulary with the
// request next to the file that owns it. This asks a read provider (TypeSafe's
// Jev, or Claude; see claude-read.js) both questions in one call and applies
// the answers only where they clear a gate:
//
//   - intent: an answer at or above CHOICE_FLOOR replaces solumbe's action word;
//   - relevance: a file under DEMOTE_BELOW leaves the ranked lists and is kept,
//     with its score, in `modelRead.demoted`; the rest are re-ranked by it.
//
// Off unless a caller asks (`context_pack { online: true }`, `solumbe context
// --online`), so a pack stays a pure function of repository state by default.
// Any failure returns the pack unchanged and says why in `modelRead`. Nothing
// here is read by a gate.

import { AMBIGUOUS_ACTION_QUESTION, rebuildContextPack } from "./context-engine.js";
import { askRequestRead } from "./claude-read.js";
import { DEMOTE_BELOW, interpretRead, MAX_RELEVANCE_FILES } from "./jev.js";

/**
 * @param {{ data: Record<string, any>, markdown: string }} pack from generateContextPack
 * @param {{ provider?: string, apiKey?: string, anthropicApiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ data: Record<string, any>, markdown: string }>}
 */
export async function readContextPack(pack, options = {}) {
  const data = globalThis.structuredClone(pack.data);
  const { files, labeled, state } = readState(data);

  let reply;
  try {
    reply = await askRequestRead(state, { files: labeled, capability: false }, options);
  } catch (error) {
    data.modelRead = { source: "offline", applied: false, fallbackReason: String(/** @type {any} */ (error)?.message ?? error) };
    return rebuildContextPack(data);
  }

  const read = interpretRead(reply.answers, files);
  /** @type {Record<string, any>} */
  const modelRead = {
    source: reply.source,
    model: reply.model,
    latencyMs: reply.latencyMs,
    tokens: reply.tokens,
    tokenKind: reply.tokenKind,
    costUsd: reply.costUsd,
    intent: null,
    demoted: [],
    notApplied: null,
  };

  if (read.intent) {
    const heuristic = data.intent.action;
    modelRead.intent = { ...read.intent, heuristic };
    if (read.intent.accepted) {
      data.intent = { ...data.intent, action: read.intent.choice, source: reply.source, heuristicAction: heuristic };
      data.openQuestions = (data.openQuestions ?? []).filter((/** @type {string} */ question) => question !== AMBIGUOUS_ACTION_QUESTION);
    }
  }

  /** @type {Map<string, number|null>} */
  const relevanceByKey = new Map(read.relevance.map((entry, index) => [fileKey(files[index]), entry.relevance]));
  const primary = applyRelevance(data.primaryFiles ?? [], relevanceByKey);
  const related = applyRelevance(data.relatedFiles ?? [], relevanceByKey);

  // A read that rejects every primary file is saying the candidates are wrong,
  // not that the agent should read nothing. Keep solumbe's list and say so, the
  // same way the router treats a read with no evidence behind it.
  if (primary.kept.length === 0 && primary.demoted.length > 0) {
    modelRead.notApplied = `Every primary file scored under ${DEMOTE_BELOW}; kept solumbe's primary files rather than an empty list. Refine the request.`;
    data.primaryFiles = [...primary.demoted.map((entry) => entry.file)].sort(byRank);
  } else {
    data.primaryFiles = primary.kept;
    modelRead.demoted.push(...primary.demoted.map((entry) => demotedEntry(entry, "primaryFiles")));
  }
  data.relatedFiles = related.kept;
  modelRead.demoted.push(...related.demoted.map((entry) => demotedEntry(entry, "relatedFiles")));

  const gone = new Set(modelRead.demoted.map((/** @type {{ repo: string, path: string }} */ entry) => `${entry.repo}\u0000${entry.path}`));
  data.hotspots = (data.hotspots ?? []).filter((/** @type {{ repo: string, path: string }} */ hotspot) => !gone.has(`${hotspot.repo}\u0000${hotspot.path}`));

  data.modelRead = modelRead;
  return rebuildContextPack(data);
}

/**
 * The state a read is asked against, and the files it scores. In a multi-repo
 * pack two repos can share a path (both `src/events.js`), so each file is
 * labelled with its repo; otherwise the model is asked two identical
 * questions. The label rides copies, never the file objects that flow back
 * into the pack, so the output is byte-for-byte solumbe's plus modelRead.
 * @param {Record<string, any>} data a context pack's data
 */
export function readState(data) {
  const files = candidateFiles(data);
  const multiRepo = (data.repos ?? []).length > 1;
  const labeled = files.map((file) => ({ ...file, label: multiRepo ? `${file.repo?.name ?? "?"}:${file.path}` : file.path }));
  const state = {
    request: data.query,
    repositories: (data.repos ?? []).map((/** @type {{ name: string }} */ repo) => repo.name),
    candidate_files: labeled.map((file) => ({ path: file.label, kind: file.kind, why: (file.reasons ?? []).slice(0, 3) })),
  };
  return { files, labeled, state };
}

/**
 * Primary files first, then related, de-duplicated, up to the per-call cap.
 * Each keeps its original rank so a reader can see what the read moved.
 * @param {Record<string, any>} data
 */
function candidateFiles(data) {
  /** @type {Map<string, any>} */
  const seen = new Map();
  for (const list of [data.primaryFiles ?? [], data.relatedFiles ?? []]) {
    for (const file of list) {
      const key = fileKey(file);
      if (!seen.has(key)) seen.set(key, file);
    }
  }
  return [...seen.values()].slice(0, MAX_RELEVANCE_FILES);
}

/**
 * Annotate, demote and re-rank one list. Files the read did not score keep
 * their place after the scored ones, in solumbe's order.
 * @param {any[]} list
 * @param {Map<string, number|null>} relevanceByKey
 */
function applyRelevance(list, relevanceByKey) {
  /** @type {any[]} */
  const kept = [];
  /** @type {{ file: any, relevance: number }[]} */
  const demoted = [];
  list.forEach((original, rank) => {
    const relevance = relevanceByKey.get(fileKey(original)) ?? null;
    const file = { ...original, rank, relevance };
    if (relevance !== null && relevance < DEMOTE_BELOW) demoted.push({ file, relevance });
    else kept.push(file);
  });
  kept.sort((a, b) => {
    if (a.relevance === null || b.relevance === null) return a.relevance === null ? (b.relevance === null ? a.rank - b.rank : 1) : -1;
    return b.relevance - a.relevance || a.rank - b.rank;
  });
  return { kept, demoted };
}

/**
 * @param {{ file: any, relevance: number }} entry
 * @param {string} from
 */
function demotedEntry(entry, from) {
  return { repo: entry.file.repo?.name ?? null, path: entry.file.path, relevance: entry.relevance, from, rank: entry.file.rank };
}

const byRank = (/** @type {any} */ a, /** @type {any} */ b) => a.rank - b.rank;

/**
 * Identify a file the way the context engine does: by repo ROOT, not name.
 * Two repos can share a name but never a root, so keying on name would merge a
 * same-path file across repos and apply one relevance score to both.
 * @param {any} file
 */
function fileKey(file) {
  return `${file?.repo?.root ?? ""}\u0000${file?.path ?? ""}`;
}
