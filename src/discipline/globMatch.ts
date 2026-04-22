/**
 * Tiny glob matcher that adds brace expansion on top of the existing
 * {@link globToRegExp} from sealedFiles (which handles `*`, `**`, `?`).
 *
 * Brace expansion: `**\/*.{ts,tsx}` → [`**\/*.ts`, `**\/*.tsx`] —
 * cross-product over comma-separated alternatives. Nested braces not
 * supported; one pass of expansion is enough for the patterns shipped
 * in {@link DEFAULT_DISCIPLINE}.
 *
 * Normalises Windows path separators + relative-path prefixes before
 * matching so the callers can pass paths as they come off the
 * filesystem.
 */

import { globToRegExp } from "../hooks/builtin/sealedFiles.js";

/**
 * Expand a single glob containing `{a,b,c}` into N separate globs
 * (one per alternative). Handles ONE set of braces per call — good
 * enough for `**\/*.{ts,tsx,js,jsx}`-style patterns. Globs without
 * braces pass through unchanged (single-element array).
 */
export function expandBraces(glob: string): string[] {
  const match = glob.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!match) return [glob];
  const prefix = match[1] ?? "";
  const alts = (match[2] ?? "").split(",").map((s) => s.trim());
  const suffix = match[3] ?? "";
  const expanded: string[] = [];
  for (const alt of alts) {
    // Recurse so `{a,b}{c,d}` still works even though we only matched
    // the first brace group.
    for (const inner of expandBraces(`${prefix}${alt}${suffix}`)) {
      expanded.push(inner);
    }
  }
  return expanded;
}

/** Normalise to POSIX separators and strip leading `./`. */
export function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * True when `relPath` matches any pattern in `globs` after brace
 * expansion. Empty glob list → false.
 */
export function matchesAny(
  relPath: string,
  globs: readonly string[],
): boolean {
  const norm = normalisePath(relPath);
  for (const g of globs) {
    for (const expanded of expandBraces(g)) {
      if (globToRegExp(expanded).test(norm)) return true;
    }
  }
  return false;
}

/**
 * Given a source path, compute the expected test sibling path.
 *
 * Heuristic: if the source is `src/foo/bar.ts`, the expected test is
 * `src/foo/bar.test.ts` (same directory, `.test.` inserted before the
 * final extension). Returns an array of candidate paths because Python
 * uses `test_foo.py` in some conventions while JS uses `foo.test.js`;
 * we probe both the inline (`.test.`) and sibling (`__tests__/`)
 * conventions that show up in the shipped default sourcePatterns.
 *
 * Callers check `fs.access` on each candidate; any hit satisfies the
 * TDD requirement.
 */
export function expectedTestPaths(sourceRelPath: string): string[] {
  const norm = normalisePath(sourceRelPath);
  const extMatch = norm.match(/^(.*)\.([^./]+)$/);
  if (!extMatch) return [];
  const base = extMatch[1] ?? "";
  const ext = extMatch[2] ?? "";
  // `.test.` and `.spec.` sibling
  const inline = [`${base}.test.${ext}`, `${base}.spec.${ext}`];
  // Python `test_foo.py` / `foo_test.py` conventions
  const pyExtras: string[] = [];
  if (ext === "py") {
    const slash = norm.lastIndexOf("/");
    const dir = slash >= 0 ? norm.slice(0, slash + 1) : "";
    const file = norm.slice(slash + 1).replace(/\.py$/, "");
    pyExtras.push(`${dir}test_${file}.py`);
    pyExtras.push(`${dir}${file}_test.py`);
  }
  return [...inline, ...pyExtras];
}
