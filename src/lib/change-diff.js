import { runCommand } from "./tools.js";

/**
 * The commit a change branched from: `merge-base(base, tip)`.
 *
 * Diffing a change against the base *tip* counts every commit that landed on
 * the base since the branch point as a reversed change of this one, so a
 * moving `main` reads as drift. This is the rule a pull request diff already
 * uses. When the two share no history, the base itself is returned so the diff
 * still runs and reports what it can.
 *
 * @param {string} root
 * @param {string} base commit sha or ref
 * @param {string} [tip] commit sha or ref the change sits on
 * @returns {string}
 */
export function diffOrigin(root, base, tip = "HEAD") {
  const result = runCommand("git", ["--no-replace-objects", "merge-base", base, tip], { cwd: root });
  const sha = result.ok ? result.stdout.trim() : "";
  return sha || base;
}

/**
 * Lines each file adds between `from` and `to`, numbered in the new file. With
 * no `to`, the comparison is against the working tree (staged and unstaged).
 *
 * Files the diff reports with no hunks (mode-only, rename-only, binary) map to
 * an empty set: they add no text to scan. A file missing from the result is
 * unknown, not clean, and the caller must treat it as whole-file.
 *
 * One git process covers the whole change. Returns null when git cannot
 * produce the diff.
 *
 * @param {string} root
 * @param {string} from
 * @param {string | null} [to]
 * @returns {Map<string, Set<number>> | null}
 */
export function addedLineNumbers(root, from, to = null) {
  const args = ["--no-replace-objects", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", from];
  if (to) args.push(to);
  args.push("--");
  const result = runCommand("git", args, { cwd: root });
  if (!result.ok) return null;

  /** @type {Map<string, Set<number>>} */
  const added = new Map();
  /** @type {string | null} */
  let current = null;
  // A `+++` line is a file header only directly after its `diff --git` line.
  // Inside a hunk a body line can also start with `+++`, so the position
  // matters.
  let inHeader = false;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = pathFromDiffLine(line);
      inHeader = true;
      if (current && !added.has(current)) added.set(current, new Set());
      continue;
    }
    if (inHeader && line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/\t$/, "");
      current = target === "/dev/null" ? null : unquote(target).replace(/^b\//, "");
      if (current && !added.has(current)) added.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    inHeader = false;
    if (!current) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = added.get(current);
    for (let number = start; number < start + count; number += 1) lines?.add(number);
  }
  return added;
}

/**
 * The new-side path of a `diff --git a/<old> b/<new>` header. Unparseable
 * headers return null, so their hunks are ignored and the file reads as
 * unknown rather than as wrongly attributed lines.
 * @param {string} line
 * @returns {string | null}
 */
function pathFromDiffLine(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const close = rest.indexOf('" "');
    if (close < 0) return null;
    return unquote(rest.slice(close + 2)).replace(/^b\//, "") || null;
  }
  const at = rest.lastIndexOf(" b/");
  if (at < 0) return null;
  return rest.slice(at + 3) || null;
}

/**
 * Git quotes paths with unusual characters. Undo the escapes that matter for
 * source file names.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}
