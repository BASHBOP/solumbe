// The MCP server: the tools it lists and how a call reaches them.
import { extractGoTypes } from "../code-map/languages.js";

export const tools = [
  { name: "symbols", description: "List the symbols a file defines.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "outline", description: "Outline a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
];

export function listTools() {
  return { tools };
}

export function callTool(name, args) {
  switch (name) {
    case "symbols":
      return extractGoTypes(String(args.source ?? ""));
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
