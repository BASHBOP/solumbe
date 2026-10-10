// Content tables for the How It Works page.
//
// Everything here is what a catalog cannot know: which phase of the loop a
// tool belongs to, the surfaces around the tools, the walkthrough, and the
// guarantees. What a tool *does* is not here: each card's blurb is the tool's
// `summary` in src/lib/mcp.js, so a change in meaning is made once and the
// page follows.
//
// This module has no side effects so tests can import the tables directly.

/**
 * The loop, top to bottom. `actor` says who does the work in that phase; the
 * point of the page is that solumbe is absent from exactly one of them.
 */
export const PHASES = [
  {
    id: "know",
    index: "01",
    title: "Know the repository",
    actor: "solumbe · reads the checkout",
    color: "var(--cyan)",
    sub: "Shape, symbols, commands and ownership, from the code rather than from a rules file. Cached per user; the repository itself is never written to.",
  },
  {
    id: "before",
    index: "02",
    title: "Before the edit",
    actor: "solumbe · deterministic, with one optional advisory read",
    color: "var(--teal)",
    sub: "What the request actually touches, what it will cost an agent, and how much model it deserves. All of it is computed before a token is spent on the change.",
  },
  {
    id: "edit",
    index: "03",
    title: "The edit",
    actor: "the model · through its own harness",
    color: "var(--violet)",
    sub: "Solumbe does not generate code. The agent writes the change in Claude Code, Codex, Cursor, Gemini or any MCP host, calling the tools above through MCP or the CLI.",
  },
  {
    id: "merge",
    index: "04",
    title: "Before the merge",
    actor: "solumbe · from the diff and the repository, never from the model",
    color: "var(--green)",
    sub: "Did the intent happen, did only the intent happen, and is the exact staged tree safe to merge? The verdict recomputes to the same value on any checkout.",
  },
  {
    id: "after",
    index: "05",
    title: "After the merge",
    actor: "CI · solumbe attest",
    color: "var(--amber)",
    sub: "Every merge to main leaves a hash-chained record of what shipped and under which verdict, in your own repository, verifiable by anyone.",
  },
  {
    id: "time",
    index: "06",
    title: "Over time",
    actor: "solumbe · graded against the repository's own history",
    color: "var(--slate)",
    sub: "The risk flags and the router are measured against what this repository actually needed to fix, and decline to answer when the sample is too small.",
  },
];

/**
 * Placement for every MCP tool. `tool` keys into the catalog: the card's
 * title, blurb and CLI chip are read from there, never written here.
 */
export const LAYOUT = [
  { id: "inspect", tool: "repo_inspect", phase: "know", sub: "repo facts" },
  { id: "map", tool: "repo_map", phase: "know", sub: "AST code map" },
  { id: "index", tool: "repo_index", phase: "know", sub: "per-user catalog" },
  { id: "search", tool: "repo_search", phase: "know", sub: "symbols & routes" },
  { id: "harness", tool: "repo_harness", phase: "know", sub: "commands" },
  { id: "workspace", tool: "workspace_report", phase: "know", sub: "multi-repo" },

  { id: "context", tool: "context_pack", phase: "before", sub: "task pack" },
  { id: "impact", tool: "change_impact", phase: "before", sub: "blast radius" },
  { id: "ax", tool: "agent_experience", phase: "before", sub: "AX 0–100" },
  { id: "route", tool: "model_route", phase: "before", sub: "model tier" },

  { id: "converge", tool: "convergence_score", phase: "merge", sub: "intent vs diff" },
  { id: "gate", tool: "review_gate", phase: "merge", sub: "PASS · WARN · FAIL" },
  { id: "reviewctx", tool: "review_context", phase: "merge", sub: "reviewer pack" },
  { id: "verdict", tool: "review_verdict", phase: "merge", sub: "composite" },
];

/**
 * Entry surfaces, the edit itself, CLI-only stages and outputs are not catalog
 * tools, so they are declared whole. A surface with a `command` stands for
 * that CLI command on the page; the test checks the command still exists and
 * that no command in `solumbe help` is left unaccounted for.
 */
export const SURFACES = [
  {
    id: "cli",
    section: "entry",
    kind: "surface",
    command: "doctor",
    title: "CLI",
    sub: "solumbe <command> --json",
    blurb: "Human and script entrypoint. Every command takes --json, prints the same evidence a tool returns, and runs without a server or an account.",
    chips: ["npm install -g @bashbop/solumbe", "solumbe doctor", "solumbe context", "solumbe gate"],
  },
  {
    id: "mcp",
    section: "entry",
    kind: "surface",
    command: "mcp",
    title: "MCP server",
    sub: "solumbe mcp · stdio",
    blurb: "",
    chips: ["solumbe mcp", "context_pack", "review_gate", "io.github.BASHBOP/solumbe"],
  },
  {
    id: "ci",
    section: "entry",
    kind: "surface",
    command: "init",
    title: "CI, hooks and skills",
    sub: "solumbe init",
    blurb:
      "solumbe init writes solumbe-ci.yml, a pre-commit hook and .solumbe/ assets into a target repository. A UserPromptSubmit hook routes every request before work starts, and the model-router skill teaches an agent to call solumbe first.",
    chips: ["solumbe init .", "solumbe-ci.yml", "attest.yml", "model-router skill"],
  },

  {
    id: "edit",
    section: "edit",
    kind: "surface",
    title: "The edit",
    sub: "the model writes the change",
    blurb:
      "The agent generates the change in its own harness. Solumbe never writes code and is handed only the request text and the checkout. What it produced before the edit is context; what it produces after is evidence about the diff that appeared.",
    chips: ["Claude Code", "Codex", "Cursor", "Gemini", "VS Code", "any MCP host"],
    hosts: ["Claude Code", "Codex", "Cursor", "Gemini", "VS Code", "any MCP host"],
  },

  {
    id: "attest",
    section: "after",
    kind: "cli",
    command: "attest",
    title: "solumbe attest",
    sub: "hash-chained record",
    blurb:
      "After a merge to main, CI appends a record of the merge commit, its verdict and their hashes to a ledger branch in your own repository. Never the diff or the source. A reusable workflow does it with one uses: line.",
    chips: ["solumbe attest --verdict … --merge <sha>", ".github/workflows/attest.yml", "audit-pilot/ledger.jsonl"],
  },
  {
    id: "verify",
    section: "after",
    kind: "cli",
    command: "attest",
    title: "solumbe attest --verify",
    sub: "recompute the chain",
    blurb:
      "Walks the ledger, recomputes every hash and exits 1 if any record was altered or any merge is missing. Open JSON Lines with a schemaVersion on every record; the export is the file itself.",
    chips: ["solumbe attest --verify", "schemaVersion: 1"],
  },

  {
    id: "calibrate",
    section: "time",
    kind: "cli",
    command: "calibrate",
    title: "solumbe calibrate",
    sub: "risk flags vs history",
    blurb:
      "Grades the gate's risk flags against this repository's own history, joining fix commits to the commits they repaired by line overlap rather than by filename. Below the minimum sample it declines to answer, which is the honest result.",
    chips: ["solumbe calibrate <repo>", "--window 30", "--min-sample"],
  },
  {
    id: "regret",
    section: "time",
    kind: "cli",
    command: "regret",
    title: "solumbe regret",
    sub: "router tiers vs history",
    blurb:
      "Grades the router's tiers the same way, three variants side by side: the deterministic half alone, the offline heuristic, and the model read. --rescore regrades a saved run on frozen answers with no checkout and no model call. Never a saving: solumbe does not know which model a host used.",
    chips: ["solumbe regret <repo>", "solumbe regret --rescore run.json"],
  },

  {
    id: "artifacts",
    section: "output",
    kind: "surface",
    title: ".solumbe/ artifacts",
    sub: "Markdown and JSON",
    blurb:
      "Durable evidence a reviewer can read: context-pack.md, pr-review.md, harness.md, workspace.md. Gitignored by init; kept under .solumbe/runs/ when you want it to survive.",
    chips: [".solumbe/pr-review.md", ".solumbe/harness.md", ".solumbe/runs/"],
  },
  {
    id: "receipt",
    section: "output",
    kind: "surface",
    title: "Convergence receipt",
    sub: "bound to the tree",
    blurb:
      "A timestamp-free hash binding the score to the exact base, parent and staged tree or commit it measured. Anyone with the checkout recomputes it; a receipt whose subject does not match what the gate measured fails with the mode to rerun in.",
    chips: ["rcpt_…", "solumbe converge --staged", "solumbe gate --receipt <hash>"],
  },
  {
    id: "verdictout",
    section: "output",
    kind: "surface",
    title: "PASS / WARN / FAIL",
    sub: "the merge verdict",
    blurb:
      "Merge-readiness for humans, agents and CI. WARN surfaces risk that needs an explicit reviewer; FAIL blocks the merge. A passing local gate is evidence, never an approval.",
    chips: ["PASS", "WARN", "FAIL"],
  },
  {
    id: "ledger",
    section: "output",
    kind: "surface",
    title: "Ledger record",
    sub: "one per merge",
    blurb:
      "One JSON line per merged commit: commit identity, verdict, and the hash of the record before it. Optional hosted copy per organisation for teams with SOC 2, ISO 27001 or regulated audits.",
    chips: ["audit-pilot/ledger.jsonl", "audit-ledger branch"],
  },
];

/**
 * CLI commands that are deliberately not a card on the page, each with the
 * reason. Every command `solumbe help` lists must be either on the page or
 * here, so a new command cannot ship without deciding where it belongs; and
 * a command that leaves the CLI must leave this table too.
 */
export const SUPPORTING_COMMANDS = {
  discover: "repo_index with discover: true; the card covers it",
  catalog: "repo_search with no query; the card covers it",
  declare: "change_impact with declare: true, which freezes its prediction as a scope contract; the card covers it",
  amend: "change_impact with amend, which adds a file to that contract with a reason; the card covers it",
  "workspace-gate": "named on the workspace_report card",
  pass: "the older name of gate, kept for compatibility",
  "pass-pr": "the older name of gate --pr, kept for compatibility",
  report: "an older composite report; review_verdict is the stage",
  structure: "a narrower view of repo_map",
  "data-access": "a narrower view of repo_map",
  deps: "package lookup, not a stage of the loop",
  obsidian: "an export format, not a stage of the loop",
  matrix: "the host compatibility matrix, not a stage of the loop",
  eval: "grades solumbe itself against fixtures; docs/EVALS.md is its page",
  "agent-tools": "prints the catalog this page is generated from",
  dashboard: "the local usage UI",
  telemetry: "opt-in local usage capture",
  install: "the installer",
  i: "alias of install",
  config: "settings",
};

/** The animated walkthrough. Each step focuses one card. */
export const STEPS = [
  { node: "mcp", title: "Connect", text: "Install the CLI or wire the MCP server into any host; init scaffolds CI and hooks." },
  { node: "map", title: "Know the repository", text: "Inspect, map, index and search the checkout; infer its commands." },
  { node: "context", title: "Before the edit", text: "Build the task pack, rank what the request touches, score AX, pick a tier." },
  { node: "edit", title: "The edit", text: "The model writes the change in its own harness. Solumbe waits." },
  { node: "gate", title: "Before the merge", text: "Score intent against the diff, then gate the exact staged tree." },
  { node: "attest", title: "After the merge", text: "CI appends a hash-chained record; anyone can verify the chain." },
  { node: "calibrate", title: "Over time", text: "Grade the flags and the router against what the repository actually had to fix." },
];

/**
 * The four things the page exists to say. The first is also a test: the gate
 * modules' import graph is checked to contain no model client.
 */
export const GUARANTEES = [
  {
    color: "var(--green)",
    title: "The gate never consults a model",
    text: "PASS, WARN and FAIL are computed from repository state. The one model read solumbe can make, for a tier or a context pack, is advisory and has no path into the verdict.",
  },
  {
    color: "var(--teal)",
    title: "Nothing leaves the machine by default",
    text: "The core commands and every MCP tool open no socket. --pr reads GitHub through your own gh login; route sends the request text to Jev only on your own key.",
  },
  {
    color: "var(--cyan)",
    title: "Same inputs, same output",
    text: "Run anything twice and get the same answer. Receipts and ledger records are timestamp-free hashes anyone can regenerate from the same checkout.",
  },
  {
    color: "var(--amber)",
    title: "Evidence, not approval",
    text: "A passing local gate is never an automatic merge. Hosted CI, GitHub review, CODEOWNERS and the human release decision remain separate authorities.",
  },
];
