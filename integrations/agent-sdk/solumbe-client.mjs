// A minimal MCP client for solumbe's stdio server (`solumbe mcp`).
//
// The orchestrator calls solumbe from code, not through the model: the
// context, the scope contract and the merge gate are deterministic steps the
// agent cannot skip or talk its way past. solumbe speaks newline-delimited
// JSON-RPC, so a few dozen lines replace an MCP SDK dependency.

import { spawn } from "node:child_process";
import readline from "node:readline";

export const PROTOCOL_VERSION = "2025-06-18";

/**
 * @typedef {{ send: (message: object) => void, onMessage: (listener: (message: any) => void) => void, close: () => void }} Transport
 */

/**
 * Spawn `solumbe mcp` and wrap its stdio as a transport.
 * @param {{ command?: string, args?: string[], cwd?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {Transport}
 */
export function spawnSolumbeTransport({ command = "solumbe", args = ["mcp"], cwd, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  return streamTransport(child.stdout, child.stdin, () => child.kill());
}

/**
 * A transport over any pair of streams: a child's stdio, or the PassThrough
 * pair a test hands to solumbe's in-process server.
 * @param {import("node:stream").Readable} readable the server's output
 * @param {import("node:stream").Writable} writable the server's input
 * @param {() => void} [onClose]
 * @returns {Transport}
 */
export function streamTransport(readable, writable, onClose = () => {}) {
  const lines = readline.createInterface({ input: readable, crlfDelay: Infinity });
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return {
    send: (message) => writable.write(`${JSON.stringify(message)}\n`),
    onMessage: (listener) => listeners.push(listener),
    close: () => {
      lines.close();
      writable.end();
      onClose();
    },
  };
}

/**
 * A JSON-RPC client over a transport, with typed helpers for the five tools
 * the orchestrator uses.
 * @param {Transport} transport
 */
export function createSolumbeClient(transport) {
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  transport.onMessage((message) => {
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`solumbe ${message.error.code}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });

  /**
   * @param {string} method
   * @param {object} [params]
   */
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      transport.send({ jsonrpc: "2.0", id, method, params });
    });

  let ready = /** @type {Promise<any>|null} */ (null);
  const initialize = () => {
    ready ??= request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "solumbe-agent-sdk-example", version: "0.1.0" },
    }).then((result) => {
      transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    });
    return ready;
  };

  /**
   * Call a solumbe tool and return its parsed JSON result.
   * @param {string} name
   * @param {object} args
   */
  const call = async (name, args) => {
    await initialize();
    const result = await request("tools/call", { name, arguments: args });
    const text = result?.content?.find((/** @type {any} */ block) => block.type === "text")?.text ?? "";
    let data;
    try {
      data = JSON.parse(text);
    } catch (_error) {
      data = { text };
    }
    if (result?.isError) throw new Error(`solumbe ${name} failed: ${data.error ?? text}`);
    return data;
  };

  return {
    call,
    /** @param {{ query: string, path: string }} args */
    contextPack: ({ query, path }) => call("context_pack", { query, path, limit: 8, online: true }),
    /** @param {{ query: string, path: string }} args */
    modelRoute: ({ query, path }) => call("model_route", { query, path, host: "claude-code" }),
    /** @param {{ query: string, path: string }} args */
    declareIntent: ({ query, path }) => call("change_impact", { query, path, declare: true }),
    /** @param {{ path: string, base: string, intent: object, request: string }} args */
    reviewGate: ({ path, base, intent, request }) => call("review_gate", { path, base, intent, request }),
    close: () => transport.close(),
  };
}

/**
 * The check trial withholds about half of convergence_score and local
 * review_gate results. A withheld answer is a recorded, non-blocking result:
 * the caller carries on and must not fetch it another way.
 * @param {any} result
 */
export function isWithheld(result) {
  return Boolean(result && result.withheld === true);
}
