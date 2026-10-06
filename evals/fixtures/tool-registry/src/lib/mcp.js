import { generateConvergence } from "./converge.js";
import { generateContextPack } from "./context-engine.js";

export const tools = [
  { name: "convergence_score", title: "Convergence Score" },
  { name: "context_pack", title: "Context Pack" },
];

export function callTool(name, args) {
  switch (name) {
    case "convergence_score":
      return generateConvergence(requiredQuery(args));
    case "context_pack":
      return generateContextPack(requiredQuery(args));
    default:
      throw new Error(name);
  }
}

function requiredQuery(args) {
  return String(args.query);
}
