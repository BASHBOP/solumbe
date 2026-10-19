// Corpus fixture: a commit that lands on main after the change branches off.
// The gate must not count it as part of the change.
export function farewell(name) {
  return `Goodbye, ${name}`;
}
