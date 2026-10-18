#!/usr/bin/env node
// Run the example against a real repository:
//
//   cd integrations/agent-sdk && npm install
//   node run.mjs --repo /path/to/repo "add a --json flag to the status command"
//
// Needs Claude credentials for the Agent SDK and `solumbe` on PATH (or
// SOLUMBE_COMMAND="node /path/to/solumbe/src/cli.js"). It proposes a merge and
// prints the PR body; it never commits, pushes or merges.

import { resolve } from "node:path";
import { runOrchestrator } from "./orchestrator.mjs";
import { createSolumbeClient, spawnSolumbeTransport } from "./solumbe-client.mjs";

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { repo: process.cwd(), base: "origin/develop", maxBudgetUsd: 5, maxTurns: 40, task: "" };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--repo") args.repo = argv[++i];
    else if (flag === "--base") args.base = argv[++i];
    else if (flag === "--budget") args.maxBudgetUsd = Number(argv[++i]);
    else if (flag === "--max-turns") args.maxTurns = Number(argv[++i]);
    else rest.push(flag);
  }
  args.task = rest.join(" ").trim();
  args.repo = resolve(args.repo);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('usage: node run.mjs [--repo DIR] [--base REF] [--budget USD] [--max-turns N] "task"');
    process.exit(2);
  }
  const [command, ...commandArgs] = (process.env.SOLUMBE_COMMAND ?? "solumbe").split(" ");
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const solumbe = createSolumbeClient(spawnSolumbeTransport({ command, args: [...commandArgs, "mcp"], cwd: args.repo }));
  try {
    const result = await runOrchestrator({
      task: args.task,
      repo: args.repo,
      base: args.base,
      query,
      solumbe,
      solumbeServer: { type: "stdio", command, args: [...commandArgs, "mcp"] },
      limits: { maxBudgetUsd: args.maxBudgetUsd, maxTurns: args.maxTurns },
      escalate: ({ kind, verdict, reasons }) => {
        console.error(`\nESCALATED to a human (${kind}${verdict ? `, ${verdict}` : ""}):`);
        for (const reason of reasons) console.error(`  - ${reason}`);
      },
    });
    if (result.status === "proposed") process.stdout.write(`\nProposed for merge (not merged):\n\n${result.prBody}`);
    process.exitCode = result.status === "proposed" ? 0 : 1;
  } finally {
    solumbe.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
