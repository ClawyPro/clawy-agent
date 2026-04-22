/**
 * Tool-result helpers used across every Tool.execute() and by Turn.ts when
 * rendering tool_result blocks for the LLM / SSE activity previews.
 *
 * Extracted from src/tools/FileRead.ts and src/Turn.ts (pure relocation,
 * no semantic change) so FileRead is no longer an ambient util namespace.
 */

import type { ToolResult } from "../Tool.js";

/**
 * Construct a ToolResult<never> from a thrown error. Preserves the
 * error's `code` (NodeJS.ErrnoException) or `name` when available so
 * callers can distinguish ENOENT / EACCES / etc. from generic errors.
 */
export function errorResult(err: unknown, startedAt: number): ToolResult<never> {
  const msg = err instanceof Error ? err.message : String(err);
  const code =
    (err as NodeJS.ErrnoException)?.code ??
    (err as { name?: string })?.name ??
    "error";
  return {
    status: "error",
    errorCode: code,
    errorMessage: msg,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Render a ToolResult into the text the LLM sees inside a tool_result
 * content block. String outputs pass through; objects are JSON-encoded;
 * errors become `error:<code> <message>` so models can recover.
 */
export function summariseToolOutput(result: ToolResult): string {
  if (result.status === "ok") {
    const out = result.output;
    if (out === undefined) return "ok";
    if (typeof out === "string") return out;
    try {
      return JSON.stringify(out);
    } catch {
      return String(out);
    }
  }
  const code = result.errorCode ?? result.status;
  const msg = result.errorMessage ?? "";
  return msg ? `error:${code} ${msg}` : `error:${code}`;
}

/**
 * Build a compact preview of an arbitrary tool input value for display
 * in the client activity card. Keeps JSON shape where possible, truncates
 * at ~400 chars. Used by tool_start + tool_end AgentEvents.
 */
export function buildPreview(input: unknown): string {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return s.length > 400 ? `${s.slice(0, 400)}...` : s;
  } catch {
    return "<unstringifiable>";
  }
}
