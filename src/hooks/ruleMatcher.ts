/**
 * ruleMatcher — parse + evaluate the declarative `if:` grammar used by
 * RegisteredHook.if (CC P0-1 port). Ports Claude Code's permission-rule
 * grammar so hooks can cheaply gate on tool-name + argument globs
 * without each handler duplicating `if (toolName !== "X") return`.
 *
 * Supported surface:
 *   "*"                         — universal match (same as no rule)
 *   "Bash"                      — tool-name match, any args
 *   "Bash(*)"                   — identical to "Bash"
 *   "Bash(git *)"               — tool-name match + argument substring/glob
 *   "Read(*.ts)"                — glob over the tool's primary arg
 *   "Tool:*"                    — legacy alias for "*" (any tool event)
 *   "BeforeCommit"              — non-tool point-level match
 *
 * When a rule references an argument glob, the matcher concatenates the
 * tool's argument values into a single stable string (sorted keys, joined
 * with spaces) and tests the glob against that projection. Callers that
 * want stricter matching can supply a pre-projected `toolArgs` string in
 * `ctx` — the matcher uses it verbatim if present.
 *
 * Design goal: parse once, match many times. `parseRule` is pure and
 * deterministic, so callers cache the result keyed by raw rule string.
 *
 * NOT a sandbox or a security boundary — this is a performance filter
 * that short-circuits "don't run this hook for this event." All the real
 * authorization logic (dangerous_patterns, auto-approval, sealed-files)
 * still runs inside the hook handlers as before.
 */

/**
 * Kinds a parsed rule can take. Exported so tests and downstream
 * diagnostics can narrow without string-matching.
 */
export type ParsedRuleKind = "any" | "tool" | "point";

/**
 * Result of parsing a rule string. The matcher never throws; a malformed
 * rule parses to `kind: "malformed"` and `matchesRule` returns false
 * after logging a single warn via the caller-supplied logger.
 */
export type ParsedRule =
  | { kind: "any"; raw: string }
  | { kind: "tool"; raw: string; toolName: string; argGlob: RegExp | null }
  | { kind: "point"; raw: string; pointName: string }
  | { kind: "malformed"; raw: string; reason: string };

/**
 * Evaluation context. Hooks that care about arguments pre-project them;
 * otherwise the matcher constructs a stable string from `toolArgs` when
 * it is an object.
 */
export interface RuleMatchContext {
  /** Lifecycle point the registry is currently running. */
  point: string;
  /** Tool name if the event is a tool-use variant (beforeToolUse / afterToolUse). */
  toolName?: string;
  /** Tool args — either a pre-projected string or the raw input object. */
  toolArgs?: unknown;
}

const TOOL_RULE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?$/;

/**
 * Compile a glob (`*`, `?`, literal chars) to an anchored RegExp. A
 * bare "*" matches anything; "git *" matches any string starting with
 * "git ". Regex metacharacters are escaped so `.` in `*.ts` is literal.
 */
function globToRegExp(glob: string): RegExp {
  if (glob === "*") return /^.*$/s;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      re += ".*";
    } else if (ch === "?") {
      re += ".";
    } else if (ch !== undefined && /[.+^$|()[\]{}\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch ?? "";
    }
  }
  re += "$";
  return new RegExp(re, "s");
}

/**
 * Parse a single rule string. Never throws — malformed input yields a
 * `{ kind: "malformed" }` token the caller can detect.
 *
 * Whitespace is trimmed. Empty / non-string input is treated as
 * malformed (NOT as "any") so a hook registered with `if: ""` surfaces
 * the mistake rather than silently always-running.
 */
export function parseRule(rule: string): ParsedRule {
  if (typeof rule !== "string") {
    return { kind: "malformed", raw: String(rule), reason: "non-string rule" };
  }
  const trimmed = rule.trim();
  if (trimmed.length === 0) {
    return { kind: "malformed", raw: rule, reason: "empty rule" };
  }
  if (trimmed === "*" || trimmed === "Tool:*") {
    return { kind: "any", raw: rule };
  }
  // Point-style rule: capitalised identifier without parens and not a
  // known tool-style token. We keep this liberal so callers can use
  // any of the hook-point strings verbatim.
  const match = TOOL_RULE_RE.exec(trimmed);
  if (!match) {
    return {
      kind: "malformed",
      raw: rule,
      reason: `unable to parse: ${JSON.stringify(rule)}`,
    };
  }
  const name = match[1];
  const inner = match[2];
  if (name === undefined) {
    return { kind: "malformed", raw: rule, reason: "missing identifier" };
  }

  // Heuristic: if the identifier begins lower-case or matches a known
  // HookPoint camelCase pattern and there are no parens, treat it as a
  // point name (e.g. "beforeCommit", "onAbort"). Tool names are
  // conventionally PascalCase in core-agent (Bash, FileWrite, Read), so
  // the distinction is stable in practice. When `inner` is present the
  // rule is always a tool rule.
  if (inner === undefined) {
    const firstCh = name.charAt(0);
    const looksLikePoint =
      firstCh === firstCh.toLowerCase() && firstCh !== firstCh.toUpperCase();
    if (looksLikePoint) {
      return { kind: "point", raw: rule, pointName: name };
    }
    return { kind: "tool", raw: rule, toolName: name, argGlob: null };
  }

  // `inner` is the raw string between the parens — may be empty ("")
  // or an arbitrary glob. We accept empty as "no args match" (treated
  // identical to "*") to mirror what CC does.
  const globSource = inner.trim();
  if (globSource.length === 0 || globSource === "*") {
    return { kind: "tool", raw: rule, toolName: name, argGlob: null };
  }
  let compiled: RegExp;
  try {
    compiled = globToRegExp(globSource);
  } catch (err) {
    return {
      kind: "malformed",
      raw: rule,
      reason: `glob compile failed: ${String(err)}`,
    };
  }
  return { kind: "tool", raw: rule, toolName: name, argGlob: compiled };
}

/**
 * Project a tool-args value into a stable string the matcher can test
 * a glob against. Strings are returned verbatim. Objects are flattened
 * by sorting top-level keys and joining `key=value` pairs with spaces.
 * Arrays join their elements. This is intentionally simple — it's not
 * a serialisation contract, just a surface for substring/glob checks.
 *
 * Non-string primitives are stringified via `String(x)`.
 */
export function projectToolArgs(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => projectToolArgs(v)).join(" ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: string[] = [];
    for (const [k, v] of entries) {
      // Common `command` / `path` keys — surface the value bare so
      // rules like `Bash(git *)` match against `git status` not
      // `command=git status`. Everything else carries the key=value
      // form so distinct projections don't accidentally collide.
      if (k === "command" || k === "path" || k === "file_path") {
        out.push(projectToolArgs(v));
      } else {
        out.push(`${k}=${projectToolArgs(v)}`);
      }
    }
    return out.join(" ");
  }
  return String(value);
}

/**
 * Evaluate a parsed rule against the current context. Returns true if
 * the hook should run. Malformed rules always return false — the
 * calling registry logs once and treats the hook as skipped.
 */
export function matchesRule(rule: ParsedRule, ctx: RuleMatchContext): boolean {
  switch (rule.kind) {
    case "any":
      return true;
    case "malformed":
      return false;
    case "point":
      return ctx.point === rule.pointName;
    case "tool": {
      const toolName = ctx.toolName;
      if (toolName === undefined || toolName === null) return false;
      if (toolName !== rule.toolName) return false;
      if (rule.argGlob === null) return true;
      const projected =
        typeof ctx.toolArgs === "string"
          ? ctx.toolArgs
          : projectToolArgs(ctx.toolArgs);
      return rule.argGlob.test(projected);
    }
  }
}
