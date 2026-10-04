import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { discoverRepositories, indexRepositories, listCatalog, searchCatalog } from "./catalog.js";
import { generateContextPack } from "./context-engine.js";
import { readContextPack } from "./context-read.js";
import { generateImpact } from "./impact.js";
import { generateAxScore, formatAxMarkdown } from "./ax.js";
import { generateConvergence, formatConvergenceMarkdown } from "./converge.js";
import { generateRoute, hostModelFor, TIERS } from "./model-route.js";
import { formatRouteMarkdown } from "./render/route.js";
import { appendEvent, extractSignals, redactError, shareEvent } from "./telemetry.js";
import { forwardToCanvas } from "./canvas-tap.js";
import { contextRepoPaths, gatePolicy } from "./config.js";
import { evaluateLocal } from "./pass-local.js";
import { evaluatePR } from "./pass-pr.js";
import { generateReview } from "./review.js";
import { generateHarness } from "./harness.js";
import { getCachedCodeMap } from "./index-cache.js";
import { inspectRepo, gateInspectScripts } from "./repo.js";
import { generatePrReview } from "./pr-review.js";
import { generateWorkspaceReport } from "./workspace.js";

/**
 * A JSON-schema fragment describing one MCP tool input.
 * @typedef {object} McpInputSchema
 * @property {string} [type]
 * @property {McpInputSchema} [items]
 * @property {Record<string, McpInputSchema & { description?: string }>} [properties]
 * @property {string[]} [required]
 */

/**
 * One MCP tool definition as advertised over tools/list.
 * @typedef {object} McpTool
 * @property {string} name
 * @property {string} title
 * @property {string} summary One or two plain sentences on what the tool is for. Not sent over tools/list;
 *   it is the blurb the How It Works page and `solumbe agent-tools` print, so a change in meaning is made here once.
 * @property {string} description
 * @property {{ readOnlyHint?: boolean, openWorldHint?: boolean }} annotations
 * @property {McpInputSchema} inputSchema
 */

/**
 * Loosely-typed tool-call arguments. Tool handlers read a heterogeneous set of
 * optional fields off this bag, so it is intentionally permissive.
 * @typedef {Record<string, any>} ToolArgs
 */

/**
 * A parsed JSON-RPC request/notification.
 * @typedef {{ jsonrpc?: string, id?: string | number | null, method?: string, params?: any }} JsonRpcMessage
 */

const latestProtocolVersion = "2025-06-18";
// This server's surface (initialize, ping, tools/list, tools/call) is
// identical across these protocol revisions, so we can echo whichever the
// client asks for instead of forcing our latest and triggering a disconnect.
const supportedProtocolVersions = new Set(["2024-11-05", "2025-03-26", latestProtocolVersion]);

/**
 * @param {unknown} requested
 * @returns {string}
 */
function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && supportedProtocolVersions.has(requested) ? requested : latestProtocolVersion;
}
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));

/** @type {McpTool[]} */
export const tools = [
  {
    name: "repo_inspect",
    summary: "Repository facts: languages, scripts, package managers, entrypoints and git state.",
    title: "Inspect Repository",
    description:
      "Inspect repository shape, languages, package managers, script names, entrypoints, and git metadata. Returns up to 200 representative file paths; pass includeScripts:true to get full script command bodies instead of just names.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        includeScripts: { type: "boolean", description: "Include full package.json script command bodies, not just their names. Defaults to false." },
      },
    },
  },
  {
    name: "repo_map",
    summary: "AST-backed JSON code map: imports, exports, routes, domains and data access across TS/JS, Go, C#, Python, Java, Ruby and Rust.",
    title: "Map Repository",
    description:
      "Map a repository into a compact JSON code map, optionally narrowed by domain, file kind, or controller route. Pass domain to find files for a feature, kind to find files of a type (route, controller, service, apiClient, component, test), or route to match Nest controller routes by substring/regex. Replaces the old find_domain, find_file_kind, find_backend_route, and find_frontend_api_client tools. Uses a per-user external cache and leaves the target repository unchanged.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        domain: { type: "string", description: "Optional domain filter such as booking, payment, email, events." },
        kind: { type: "string", description: "Optional file kind filter such as route, controller, service, apiClient, component, test." },
        route: {
          type: "string",
          description:
            "Optional route filter. Substring or regex matched against each controller's combined route (controllerBasePath + httpMethods paths) and file path.",
        },
        includeFiles: { type: "boolean", description: "Include matching files in the response. Defaults to false." },
        limit: { type: "number", description: "Maximum files to include. Defaults to 100." },
      },
    },
  },
  {
    name: "repo_index",
    summary:
      "Index local repositories into a per-user catalog; dryRun discovers read-only. Markdown is indexed too, so skills and docs pages rank alongside code. The inspected repository is never modified.",
    title: "Index Repositories",
    description:
      "Index local repositories: generate per-user external indexes and add them to the local catalog. Pass discover:true to find repository roots under the given paths first. Pass dryRun:true to discover and report without writing any indexes or catalog (read-only); this replaces the old repo_discover tool. Without dryRun this mutates the persistent local catalog, so it is not a pure read.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Repository paths, or roots when discover is true." },
        path: { type: "string", description: "Single repository path." },
        discover: { type: "boolean", description: "Discover repositories under the provided paths before indexing." },
        dryRun: {
          type: "boolean",
          description: "Discover and report repositories without writing indexes or mutating the catalog. Read-only. Defaults to false.",
        },
        catalog: { type: "string", description: "Optional catalog JSON path." },
        depth: { type: "number", description: "Maximum discovery depth." },
        limit: { type: "number", description: "Maximum discovered repositories." },
      },
    },
  },
  {
    name: "repo_search",
    summary: "Search indexed repositories by path, domain, kind, route, imports, exports and symbols. Omit the query to list the catalog.",
    title: "Search Repository Catalog",
    description:
      "Search indexed local repositories by path, domain, kind, route, imports, exports, and symbols. Omit query to list the local repository catalog instead (the catalog listing the old repo_catalog tool returned). Only searches repositories already in the local catalog — if the catalog is empty this returns no matches, so call repo_index on the target repositories first.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query. Omit to return the catalog listing instead of search matches." },
        catalog: { type: "string", description: "Optional catalog JSON path." },
        limit: { type: "number", description: "Maximum matches. Defaults to 25." },
        offline: { type: "boolean", description: "Use stored index files without refreshing fingerprints." },
      },
    },
  },
  {
    name: "context_pack",
    summary:
      "Task-aware packet: primary and related files, hotspots, tests, validation commands and token estimates, with git state read live. online lets a model read demote files it judges irrelevant; it is off unless asked. Run before planning or editing.",
    title: "Context Pack",
    description:
      "Generate a task-aware local context packet with primary files, related files, tests, and validation commands. Uses a per-user external cache and leaves the target repository unchanged. Deterministic by default; pass online:true to also ask a System One model (needs TYPESAFE_API_KEY) what kind of work the request is and which candidate files it needs, which relabels a confidently read intent and demotes files it judges irrelevant, reported under modelRead.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task or question to gather context for." },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repository paths for a multi-repo context packet. Omitted, `path` plus the `companions` listed in its .solumberc.json.",
        },
        limit: { type: "number", description: "Maximum primary, related, and test files per section. Defaults to 8." },
        includeEvidence: {
          type: "boolean",
          description: "Include per-file imports, exports, and symbol slices as source evidence. Defaults to false to keep the packet compact.",
        },
        includeMarkdown: {
          type: "boolean",
          description: "Return a compact human-readable markdown report instead of the full JSON packet. Defaults to false.",
        },
        online: {
          type: "boolean",
          description:
            "Ask TypeSafe's Jev to read the request (intent, and relevance of each candidate file) in one call, and apply answers that clear their confidence gate. Needs TYPESAFE_API_KEY; without one the pack is returned unchanged with modelRead.source offline. Defaults to false.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "change_impact",
    summary:
      "Ranks the files most likely to own a plain-English change request, with risk flags and suggested tests. A diff base adds exact changed-file evidence beside the heuristic.",
    title: "Change Impact",
    description:
      "Given a plain-English change request, rank the files most likely to own the change, with risk flags, suggested tests, and an implementation plan. Optional diff base surfaces exact changed-file evidence alongside the heuristic. When the repository's .solumberc.json lists companions, companions also carries the top few files each companion repository would own for the same request. Uses a per-user external cache and leaves the target repository unchanged.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-English change request." },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        top: { type: "number", description: "Number of files to return. Defaults to 10." },
        diffBase: { type: "string", description: "Optional git ref to validate predictions against (e.g. origin/main, HEAD)." },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
      required: ["query"],
    },
  },
  {
    name: "agent_experience",
    summary:
      "Agent Experience: how cheap and safe it is for an agent to make this change here. Changeability, Containment, Guardrails and Clarity, with concrete recommendations for raising the score.",
    title: "Agent Experience (AX)",
    description:
      'Score Agent Experience (AX): a single 0–100 number answering "how cheap and safe is it for an agent to make this change here?", blending Changeability (token cost), Containment (blast radius), Guardrails (tests / validation / CODEOWNERS / CI), and Clarity (task groundedness). Deterministic and composed from the change_impact, token-estimate, and CODEOWNERS engines — no new analysis. Returns sub-scores, drivers, and concrete recommendations for raising AX. Uses a per-user external cache and leaves the target repository unchanged.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Plain-English change request to score, e.g. "add a new MCP tool".' },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        top: { type: "number", description: "Number of impact files to consider when scoring blast radius. Defaults to 8." },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
      required: ["query"],
    },
  },
  {
    name: "model_route",
    summary:
      "Recommends a model tier (cheap, mid or premium) before work starts. solumbe answers the repository half deterministically; TypeSafe's Jev reads the request when TYPESAFE_API_KEY is set, otherwise the read is a labelled offline estimate. Advisory: it never feeds the gate.",
    title: "Model Route",
    description:
      "Recommend a model tier (cheap, mid or premium) for a coding request before any work starts. Combines solumbe's deterministic repository half (AX, containment, top-severity risk paths) with a System One model's calibrated read of the request (specificity, blast radius, novelty). The model is called only when TYPESAFE_API_KEY is set in this server's environment and offline is not true; otherwise the read is a labelled offline estimate, and model.source says which. Advisory: it recommends a tier and never feeds review_gate or review_verdict. Pass host to map the tier to that host's model id.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Plain-English change request to route, e.g. "fix the typo in the README".' },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        top: { type: "number", description: "Number of impact files to consider. Defaults to 8." },
        host: {
          type: "string",
          description: "Optional host whose model map resolves the tier to a model id (built in: claude-code; add others in .solumbe/model-route.json).",
        },
        offline: { type: "boolean", description: "Never call the model, even when a key is set. Defaults to false." },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
      required: ["query"],
    },
  },
  {
    name: "convergence_score",
    summary:
      "0–100 distance between the stated task and the actual diff: Coverage, Scope and Risk alignment. head scores exactly base..head; staged binds to the index tree. Emits a timestamp-free receipt anyone can recompute, which a model cannot award itself.",
    title: "Convergence Score",
    description:
      "Score convergence: a deterministic 0–100 measure of the distance between a stated task (intent) and the actual git diff (execution), with sub-scores for Coverage (did the intent happen?), Scope (did only the intent happen?), and Risk alignment (did unrequested drift land on risk-sensitive paths?). Composed from the change_impact diff comparison and the shared risk vocabulary — no model, no new analysis. New files beside a confirmed owner and tests of confirmed files count as in scope, listed under drivers.inferredRelated. Emits a recomputable receipt (a timestamp-free hash anyone can regenerate and verify) as durable evidence. Requires a base git ref to diff against; scores the working tree's tracked changes unless head or staged selects an exact subject.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'The stated task / intent to measure against the diff, e.g. "add Stripe refunds".' },
        base: { type: "string", description: "Git ref to diff against (e.g. origin/main, HEAD~1). Required." },
        head: {
          type: "string",
          description:
            "Score exactly base..head (a direct tree diff, no merge base) instead of the working tree, and bind the receipt to the head commit and its tree SHA. Uncommitted and untracked files play no part. Cannot be combined with staged.",
        },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        top: { type: "number", description: "Number of predicted owner files to consider. Defaults to 10." },
        staged: {
          type: "boolean",
          description:
            "Measure only the exact Git index tree and bind the receipt to its tree SHA. May create Git object or index-cache metadata; source files are unchanged.",
        },
        includeUntracked: {
          type: "boolean",
          description:
            "Working-tree mode only: also score untracked, non-ignored files. Defaults to false; untracked files are otherwise listed under untracked and not scored.",
        },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
      required: ["query", "base"],
    },
  },
  {
    name: "review_gate",
    summary:
      "The merge gate, from repository state alone: changed files, secret safety, risk paths, release discipline, validation, dependency audit, policy profile and a convergence floor. With pr, adds review decision, CODEOWNERS, branch protection and checks through your own gh login.",
    title: "Review Gate",
    description:
      "Gate a change for merge and return a PASS / WARN / FAIL verdict. Omit pr to run the local, no-GitHub gate against a base ref (changed files, secret safety, risk-sensitive paths, release discipline, validation commands, dependency audit, policy profile). Set pr to gate an open GitHub PR via `gh` (PR state, review decision, CODEOWNERS approvals, unresolved conversations, branch protection, status checks). Merges the old merge_readiness and pr_merge_readiness tools. Use review_verdict instead when you want the full impact + review + gate composite, or review_context when you want diff/comment context with no verdict.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        pr: {
          type: "string",
          description: "PR selector (number, URL, or branch). Set, runs the GitHub gate on that PR; omitted or blank, runs the local gate.",
        },
        staged: {
          type: "boolean",
          description:
            "Use the exact Git index for changed-path, risk, secret, and convergence evidence. Release, validation-command, and optional analyzer checks still inspect the working tree. May create Git object or index-cache metadata; source files are unchanged. Ignored in GitHub PR mode.",
        },
        head: {
          type: "string",
          description:
            "Gate exactly base..head: changed-path, risk, secret, and convergence evidence come from the head commit's tree, so uncommitted and untracked files play no part. Release, validation-command, and optional analyzer checks still inspect the working tree. Cannot be combined with staged. Ignored in GitHub PR mode.",
        },
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        base: { type: "string", description: "Base ref for the local gate. Defaults to origin/main, then HEAD. Ignored in PR mode." },
        policy: {
          type: "string",
          description: "Policy profile: standard, company, or high-risk. Omitted, the repository's .solumberc.json or user config decides, else standard.",
        },
        governance: { type: "string", description: "Governance: team or solo. Omitted, the repository's .solumberc.json or user config decides, else team." },
        request: { type: "string", description: "Optional change request for context evidence output." },
        minConvergence: {
          type: "number",
          description: "Optional minimum convergence score (0–100). Enables a failing gate when the task/diff score is below this floor.",
        },
        receipt: {
          type: "string",
          description:
            "Optional convergence inputs hash, JSON object, or path to a JSON receipt artifact. Exact-subject v2 receipts require the full hash; legacy v1 display IDs remain accepted. A receipt bound to a head commit or the staged index verifies only in the same mode (head / staged); a JSON receipt names the mode it needs when they differ.",
        },
      },
    },
  },
  {
    name: "review_verdict",
    summary:
      "change_impact plus review_context plus review_gate in one call, with a derived confidence score and a schemaVersion the attestation ledger records.",
    title: "Review Verdict",
    description:
      "Run the full review pipeline in one shot: change_impact plus review_context plus review_gate, returning a unified verdict with a derived confidence score. When the repository's .solumberc.json lists companions and a request is given, impactSummary.companions names the top few files each companion repository would own for that request. Use review_verdict when you want the complete picture of a change in a single call. Use review_context instead for diff metadata only (no verdict), or review_gate for the gate verdict alone.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        request: { type: "string", description: "Plain-English change request for impact scoring." },
        base: { type: "string", description: "Base ref for local diff. Defaults to origin/main, then HEAD." },
        pr: {
          type: "string",
          description: "PR selector (number, URL, or branch). Set, gates that GitHub PR, as review_gate does; omitted or blank, runs the local gate.",
        },
        policy: {
          type: "string",
          description: "Policy profile: standard, company, or high-risk. Omitted, the repository's .solumberc.json or user config decides, else standard.",
        },
        governance: { type: "string", description: "Governance: team or solo. Omitted, the repository's .solumberc.json or user config decides, else team." },
        impactTop: { type: "number", description: "Number of impact files. Defaults to 8." },
        minConvergence: { type: "number", description: "Optional minimum convergence score (0–100) enforced by the merge gate." },
        receipt: {
          type: "string",
          description:
            "Optional convergence inputs hash, JSON object, or path to a JSON receipt artifact. Exact-subject v2 receipts require the full hash; legacy v1 display IDs remain accepted.",
        },
      },
    },
  },
  {
    name: "workspace_report",
    summary: "One report across related repositories for cross-service work. workspace-gate gates them together.",
    title: "Workspace Report",
    description: "Generate a product-level report across multiple related repositories.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Repository paths to inspect together.",
        },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
      required: ["paths"],
    },
  },
  {
    name: "review_context",
    summary: "Diff-aware review context for a human: changed domains, risk flags and review targets, optionally with GitHub comments. No verdict.",
    title: "Review Context",
    description:
      "Produce PR review context from local git diff metadata, optionally enriched with GitHub PR comments. Use review_context when you want the raw diff/comment context for a change, not a verdict. Use review_verdict instead for the full impact + review + gate composite, or review_gate for the gate verdict alone.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        number: { type: "number", description: "Optional GitHub PR number for gh enrichment." },
        github: { type: "boolean", description: "Ask gh to infer the current branch PR." },
        comment: { type: "boolean", description: "Create or update a sticky GitHub PR comment using gh. This writes to GitHub." },
        base: { type: "string", description: "Base ref. Defaults to PR base, upstream, origin/main, or main." },
        head: { type: "string", description: "Head ref. Defaults to HEAD." },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
    },
  },
  {
    name: "repo_harness",
    summary: "Setup, validation and runtime commands inferred from the repository: the first artifact an agent or CI job should read.",
    title: "Repository Harness",
    description: "Generate setup, validation, runtime, and context commands for an agent or CI harness.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository path. Defaults to current working directory." },
        includeMarkdown: { type: "boolean", description: "Return a compact human-readable markdown report instead of the full JSON. Defaults to false." },
      },
    },
  },
];

// review_gate reads a blank pr as omitted and runs the local gate, so no pr a
// client can send asks for the checked-out branch's PR. pr_merge_readiness
// gated that PR when its selector was left out, as `gh pr view` does, so its
// alias passes this instead: a value JSON cannot carry.
const CURRENT_BRANCH_PR = Symbol("the checked-out branch's PR");

// Legacy MCP tool names remain callable through tools/call even though they no
// longer appear in tools/list. Each entry maps an old name to its canonical
// successor plus a pure arguments translator. Renames forward 1:1; folded tools
// translate params (e.g. find_backend_route's query → repo_map.route). The
// names date from Repoctx 2.0's 18-to-11 consolidation and still work in 3.x;
// no release is named to remove them, and removing one is a breaking change.
// The mapping is documented under "Legacy tool names" in
// docs/02-mcp-agent-workflows/README.md, which a test keeps in step with this.
/**
 * @typedef {{ tool: string, mapArgs: (args?: ToolArgs) => (ToolArgs | undefined) }} LegacyAlias
 * @type {Record<string, LegacyAlias>}
 */
export const LEGACY_TOOL_ALIASES = {
  // Renames — same schema, new name.
  pr_review: { tool: "review_context", mapArgs: (args) => args },
  review_pr: { tool: "review_verdict", mapArgs: (args) => args },
  // merge_readiness is the local gate (no pr). pr_merge_readiness is the GitHub
  // gate: its `selector` becomes review_gate's `pr`, and an omitted or blank one
  // gates the checked-out branch's PR, the old tool's documented default.
  merge_readiness: { tool: "review_gate", mapArgs: ({ selector: _selector, ...rest } = {}) => rest },
  pr_merge_readiness: {
    tool: "review_gate",
    mapArgs: ({ selector, ...rest } = {}) => ({ ...rest, pr: optionalString(selector) ?? optionalString(rest.pr) ?? CURRENT_BRANCH_PR }),
  },
  // repo_catalog → repo_search with no query returns the catalog listing.
  repo_catalog: { tool: "repo_search", mapArgs: ({ query: _query, ...rest } = {}) => rest },
  // repo_discover → repo_index in read-only discover mode.
  repo_discover: { tool: "repo_index", mapArgs: (args = {}) => ({ ...args, discover: true, dryRun: true }) },
  // The four find_* tools fold into repo_map's domain/kind/route/includeFiles params.
  find_domain: {
    tool: "repo_map",
    mapArgs: ({ domain, path, paths, limit } = {}) => ({ domain, path: path ?? paths?.[0], limit, includeFiles: true }),
  },
  find_file_kind: {
    tool: "repo_map",
    mapArgs: ({ kind, path, paths, limit } = {}) => ({ kind, path: path ?? paths?.[0], limit, includeFiles: true }),
  },
  find_backend_route: {
    tool: "repo_map",
    mapArgs: ({ query, path, paths, limit } = {}) => ({ kind: "controller", route: query, path: path ?? paths?.[0], limit, includeFiles: true }),
  },
  find_frontend_api_client: {
    tool: "repo_map",
    mapArgs: ({ query, domain, path, paths, limit } = {}) => ({
      kind: "apiClient",
      route: query ?? domain,
      path: path ?? paths?.[0],
      limit,
      includeFiles: true,
    }),
  },
};

/**
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [options]
 * @returns {Promise<void>}
 */
export async function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  // Each message is handled without blocking the read of the next one, so an
  // I/O-bound tool (model_route, or context_pack with online:true, both of
  // which await a Jev round trip of up to JEV_TIMEOUT_MS) does not stall every
  // other request behind it. JSON-RPC matches responses to requests by id, so
  // writing them as they resolve — not necessarily in receipt order — is
  // within spec. writeMessage emits one whole line, and Node orders writes, so
  // responses never interleave on the wire.
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  const track = (/** @type {Promise<void>} */ promise) => {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    /** @type {JsonRpcMessage} */
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      writeMessage(output, errorResponse(null, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }

    track(
      handleMessage(message).then((response) => {
        if (response) writeMessage(output, response);
      }),
    );
  }

  // The stream ended; let every in-flight handler finish so a caller that
  // awaits startMcpServer (the tests do) sees all responses written.
  await Promise.allSettled(inFlight);
}

/**
 * @param {JsonRpcMessage | null} message
 * @returns {Promise<object | undefined>}
 */
async function handleMessage(message) {
  // JSON-RPC notifications (no id member) must never receive a response —
  // not even an error for unknown methods. Real MCP clients routinely send
  // notifications/cancelled and notifications/roots/list_changed.
  const isNotification = message !== null && typeof message === "object" && !Array.isArray(message) && !("id" in message);
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (isNotification) {
      return undefined;
    }
    return errorResponse(message?.id ?? null, -32600, "Invalid JSON-RPC request");
  }
  if (isNotification) {
    return undefined;
  }

  try {
    switch (message.method) {
      case "initialize":
        return successResponse(message.id, {
          protocolVersion: negotiateProtocolVersion(message.params?.protocolVersion),
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: packageJson.name,
            version: packageJson.version,
          },
        });
      case "ping":
        return successResponse(message.id, {});
      case "tools/list":
        return successResponse(message.id, { tools: tools.map(({ summary: _summary, ...tool }) => tool) });
      case "tools/call":
        return successResponse(message.id, await callTool(message.params));
      default:
        return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const code = error instanceof McpProtocolError ? error.code : -32603;
    return errorResponse(message.id, code, error instanceof Error ? error.message : String(error));
  }
}

/**
 * @param {any} [params]
 * @returns {Promise<{ content: { type: string, text: string }[], isError: boolean }>}
 */
async function callTool(params = {}) {
  if (!params || typeof params !== "object") {
    throw new McpProtocolError(-32602, "Tool call params must be an object");
  }

  const name = params.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new McpProtocolError(-32602, "Tool name is required");
  }

  const args = params.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new McpProtocolError(-32602, "Tool arguments must be an object");
  }

  const startedAt = performance.now();
  // Opt-in and fire-and-forget: off unless SOLUMBE_CANVAS_URL is set. When it is
  // on, yield once so the loopback POST is flushed before a synchronous,
  // CPU-bound dispatch (context_pack, change_impact) blocks the event loop —
  // otherwise the request sits unsent until the tool finishes, and a dispatch
  // longer than the tap's own timeout would abort it unsent. We never wait for
  // the canvas's reply, only for the send to leave.
  const tap = forwardToCanvas(LEGACY_TOOL_ALIASES[name]?.tool ?? name, args);
  if (tap) await Promise.race([tap, new Promise((resolve) => globalThis.setImmediate(resolve))]);
  let result;
  try {
    result = await dispatchTool(name, args);
  } catch (error) {
    recordToolEvent(name, args, startedAt, error instanceof McpProtocolError ? "error" : "fail", { error });
    if (error instanceof McpProtocolError) {
      throw error;
    }

    return {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
  }

  recordToolEvent(name, args, startedAt, "ok", { result });
  return {
    content: [
      {
        type: "text",
        text: toolResultText(result),
      },
    ],
    isError: false,
  };
}

// Opt-in usage telemetry tap for the MCP surface. Records the canonical tool
// name, latency, outcome, value signals, and result size. Wrapped in its own
// try/catch and routed through appendEvent (which is itself best-effort and
// never writes stdout) so it can NEVER alter or delay the JSON-RPC response.
/**
 * @param {string} name
 * @param {ToolArgs} args
 * @param {number} startedAt
 * @param {"ok" | "fail" | "error"} outcome
 * @param {{ result?: any, error?: unknown }} payload
 * @returns {void}
 */
function recordToolEvent(name, args, startedAt, outcome, payload) {
  try {
    const canonical = LEGACY_TOOL_ALIASES[name]?.tool ?? name;
    const hasResult = payload.result !== undefined;
    const data = hasResult && payload.result && typeof payload.result === "object" && "markdown" in payload.result ? payload.result.data : payload.result;
    /** @type {Record<string, any> | null} */
    let signals = hasResult ? extractSignals(data) : null;
    if (hasResult) {
      signals = { ...(signals ?? {}), resultBytes: toolResultText(payload.result).length };
    }
    const record = appendEvent({
      surface: "mcp",
      cmd: canonical,
      requested: canonical !== name ? name : null,
      argsShape: { positionals: 0, flags: Object.keys(args ?? {}).sort() },
      outcome,
      error: payload.error ? redactError(payload.error) : null,
      durationMs: performance.now() - startedAt,
      signals,
      repoRoot: typeof args?.path === "string" ? args.path : process.cwd(),
    });
    void shareEvent(record);
  } catch {
    // Telemetry must never affect the JSON-RPC channel.
  }
}

// Render a dispatched tool result as the single text payload. When a tool was
// asked for its markdown report (includeMarkdown:true) the dispatcher returns a
// { data, markdown } pair — surface the human-readable markdown directly instead
// of nesting it inside the full JSON, which is far smaller on the wire. Every
// other result is serialized as compact (non-pretty) JSON. We deliberately do
// not emit structuredContent: no tool declares an outputSchema, so no client
// relies on it, and duplicating the payload doubled transport weight.
/**
 * @param {unknown} result
 * @returns {string}
 */
function toolResultText(result) {
  if (result && typeof result === "object" && "markdown" in result && typeof (/** @type {{ markdown?: unknown }} */ (result).markdown) === "string") {
    return /** @type {{ markdown: string }} */ (result).markdown;
  }
  return JSON.stringify(result);
}

/**
 * @param {string} name
 * @param {ToolArgs} args
 * @returns {Promise<any>}
 */
async function dispatchTool(name, args) {
  const alias = LEGACY_TOOL_ALIASES[name];
  if (alias) {
    return dispatchTool(alias.tool, alias.mapArgs(args) ?? {});
  }

  switch (name) {
    case "repo_inspect":
      return gateInspectScripts(inspectRepo(args.path ?? "."), args.includeScripts);
    case "repo_map":
      return compactCodeMap(getCachedCodeMap(args.path ?? "."), args);
    case "repo_index":
      // dryRun discovers and reports without writing indexes or mutating the
      // catalog, preserving the read-only semantics of the old repo_discover tool.
      if (args.dryRun) {
        return { ...discoverRepositories(args.paths ?? [args.path ?? "."], args), dryRun: true };
      }
      return indexRepositories(args.paths ?? [args.path ?? "."], args);
    case "repo_search":
      // No query → return the catalog listing (what repo_catalog returned).
      if (typeof args.query !== "string" || !args.query.trim()) {
        return listCatalog(args);
      }
      return withSearchRemediation(searchCatalog(args.query, args));
    case "context_pack": {
      let result = generateContextPack(requiredString(args.query, "query"), { ...args, paths: contextRepoPaths(args) });
      if (args.online === true) result = await readContextPack(result);
      return args.includeMarkdown ? result : result.data;
    }
    case "change_impact": {
      const result = generateImpact(requiredString(args.query, "query"), {
        path: args.path ?? ".",
        top: args.top,
        diffBase: args.diffBase,
        companions: true,
      });
      return args.includeMarkdown ? result : result.data;
    }
    case "agent_experience": {
      const data = generateAxScore(requiredString(args.query, "query"), {
        path: args.path ?? ".",
        top: args.top,
      });
      return args.includeMarkdown ? { data, markdown: formatAxMarkdown(data) } : data;
    }
    case "model_route": {
      const repoPath = args.path ?? ".";
      const query = requiredString(args.query, "query");
      // An unknown host is a deterministic config miss. Reject it before the
      // impact pass, the AX score and a billed Jev round trip, not after. The
      // tier is not known yet, so validate the host map's existence with any
      // tier; the resolved value is discarded here and recomputed below.
      const host = typeof args.host === "string" && args.host.trim() ? args.host : null;
      if (host) hostModelFor(repoPath, host, TIERS[0]);
      const data = await generateRoute(query, {
        path: repoPath,
        top: args.top,
        offline: args.offline === true,
      });
      if (host) data.hostModel = hostModelFor(repoPath, host, data.tier);
      return args.includeMarkdown ? { data, markdown: formatRouteMarkdown(data) } : data;
    }
    case "convergence_score": {
      const data = generateConvergence(requiredString(args.query, "query"), {
        path: args.path ?? ".",
        base: requiredString(args.base, "base"),
        head: args.head,
        top: args.top,
        staged: args.staged,
        includeUntracked: args.includeUntracked,
      });
      return args.includeMarkdown ? { data, markdown: formatConvergenceMarkdown(data) } : data;
    }
    case "review_gate": {
      // pr naming a PR → GitHub gate (evaluatePR); pr omitted or blank → local
      // gate (evaluateLocal), as merge_readiness did. A blank pr is no PR, as a
      // blank policy or governance is no setting; passed on, `gh pr view` would
      // drop it and gate the checked-out branch's PR, which nobody named. Only
      // the pr_merge_readiness alias asks for that PR, with CURRENT_BRANCH_PR.
      const repoPath = args.path ?? ".";
      const { policy, governance } = gatePolicy(repoPath, args);
      const pr = args.pr === CURRENT_BRANCH_PR ? "" : optionalString(args.pr);
      if (pr !== undefined) {
        return evaluatePR(repoPath, pr, {
          policy,
          governance,
          request: args.request,
          minConvergence: args.minConvergence,
          receipt: args.receipt,
        });
      }
      return evaluateLocal(repoPath, {
        base: args.base,
        head: args.head,
        policy,
        governance,
        request: args.request,
        minConvergence: args.minConvergence,
        receipt: args.receipt,
        staged: args.staged,
      });
    }
    case "review_verdict": {
      const repoPath = args.path ?? ".";
      const { policy, governance } = gatePolicy(repoPath, args);
      const { data } = await generateReview(repoPath, {
        request: args.request,
        base: args.base,
        // Blank runs the local gate, as for review_gate. generateReview would
        // take " " for a PR, and gh would drop it and gate the checked-out
        // branch's PR instead.
        prSelector: optionalString(args.pr),
        policy,
        governance,
        minConvergence: args.minConvergence,
        receipt: args.receipt,
        impactTop: args.impactTop,
      });
      return data;
    }
    case "workspace_report": {
      const paths = requirePaths(args);
      const result = generateWorkspaceReport(paths);
      return args.includeMarkdown ? result : result.data;
    }
    case "review_context": {
      const result = generatePrReview(args.path ?? ".", args);
      return args.includeMarkdown ? result : result.data;
    }
    case "repo_harness": {
      const result = generateHarness(args.path ?? ".", args);
      return args.includeMarkdown ? result : result.data;
    }
    default:
      throw new McpProtocolError(-32602, `Unknown tool: ${name}`);
  }
}

// repo_search only sees repositories already in the local catalog. When the
// catalog is empty (or holds no repositories), the agent gets an empty match
// list with no clue why — so attach an explicit next step pointing at repo_index.
/**
 * @param {any} result
 * @returns {any}
 */
function withSearchRemediation(result) {
  if (result && typeof result === "object" && !result.repositoryCount) {
    return {
      ...result,
      remediation: "No repositories are in the local catalog yet. Call repo_index on the repositories you want to search, then retry repo_search.",
    };
  }
  return result;
}

/**
 * @param {any} map
 * @param {ToolArgs} [args]
 * @returns {object}
 */
function compactCodeMap(map, args = {}) {
  const limit = normalizeLimit(args.limit, 100);
  const filtered = args.domain || args.kind || args.route;
  const files = filterFiles(map.files, args).slice(0, limit).map(summarizeFile);
  return {
    ok: true,
    repo: map.repo,
    cache: map.cache,
    summary: map.summary,
    domains: map.domains.slice(0, 30),
    files: args.includeFiles || filtered ? files : undefined,
    notableFiles: args.includeFiles || filtered ? undefined : map.files.filter(isNotableFile).slice(0, limit).map(summarizeFile),
  };
}

// The domain/kind/route filters fold in the behavior of the retired find_domain,
// find_file_kind, find_backend_route, and find_frontend_api_client tools. The
// route filter replicates findBackendRoute's matching: it checks every controller
// route built from controllerBasePath + each httpMethod path (and the file path),
// so kind:"controller" + route reproduces the backend-route lookup, while
// kind:"apiClient" + route reproduces the frontend-api-client query.
/**
 * @param {any[]} files
 * @param {ToolArgs} [args]
 * @returns {any[]}
 */
function filterFiles(files, args = {}) {
  return files
    .filter((file) => !args.domain || matches(domainSearchText(file), args.domain))
    .filter((file) => !args.kind || file.kind === args.kind)
    .filter((file) => !args.route || matchesRoute(file, args.route));
}

/**
 * @param {any} file
 * @param {string} route
 * @returns {boolean}
 */
function matchesRoute(file, route) {
  const haystacks = [file.path, file.route, file.controllerBasePath, domainSearchText(file), ...(file.imports ?? []), ...(file.exports ?? [])];
  for (const method of file.httpMethods ?? []) {
    haystacks.push(combineRoute(file.controllerBasePath, method.path), method.path, method.method);
  }
  return haystacks.some((value) => matchesPattern(value, route));
}

// Route filter matches as a regex when the value is a valid pattern, otherwise
// falls back to case-insensitive substring matching (findBackendRoute's behavior).
/**
 * @param {unknown} value
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPattern(value, pattern) {
  const text = String(value ?? "");
  if (!text) {
    return false;
  }
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return matches(text, pattern);
  }
}

/**
 * @param {any} file
 * @returns {string}
 */
function domainSearchText(file) {
  const tags = file.domains?.length ? file.domains : [file.domain];
  return tags.filter(Boolean).join(" ");
}

/**
 * @param {any} file
 * @returns {object}
 */
function summarizeFile(file) {
  return {
    path: file.path,
    kind: file.kind,
    domain: file.domain,
    domains: file.domains ?? (file.domain ? [file.domain] : []),
    route: file.route,
    controllerBasePath: file.controllerBasePath,
    httpMethods: file.httpMethods,
    imports: file.imports.slice(0, 20),
    exports: file.exports.slice(0, 20),
    symbols: file.symbols.slice(0, 20),
  };
}

/**
 * @param {any} file
 * @returns {boolean}
 */
function isNotableFile(file) {
  return ["route", "apiRoute", "controller", "service", "module", "apiClient"].includes(file.kind);
}

/**
 * @param {ToolArgs} [args]
 * @returns {string[]}
 */
function requirePaths(args = {}) {
  if (!Array.isArray(args.paths) || args.paths.length < 2) {
    throw new McpProtocolError(-32602, "paths must contain at least two repository paths");
  }
  return args.paths;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new McpProtocolError(-32602, `${name} is required`);
  }
  return value;
}

/**
 * An optional string argument, or undefined when it is missing or blank: a
 * blank argument counts as omitted.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(number), 500);
}

/**
 * @param {unknown} value
 * @param {unknown} query
 * @returns {boolean}
 */
function matches(value, query) {
  return String(value ?? "")
    .toLowerCase()
    .includes(String(query ?? "").toLowerCase());
}

/**
 * @param {unknown} basePath
 * @param {unknown} methodPath
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
 * @param {string | number | null | undefined} id
 * @param {object} result
 * @returns {object}
 */
function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * @param {string | number | null | undefined} id
 * @param {number} code
 * @param {string} message
 * @returns {object}
 */
function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {object} message
 * @returns {void}
 */
function writeMessage(output, message) {
  output.write(`${JSON.stringify(message)}\n`);
}

class McpProtocolError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    /** @type {number} */
    this.code = code;
  }
}
