export function shouldRunPremiumGate(tree: { staged: number }) {
  return tree.staged > 0;
}
