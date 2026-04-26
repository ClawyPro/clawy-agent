/**
 * ToolDispatcher — executes tool_use blocks in parallel (§7.3).
 *
 * Extracted from `Turn.runTools` (R3 refactor, 2026-04-19). Owns the
 * full tool-dispatch surface:
 *   • beforeToolUse hook chain (bypass-aware, T2-08)
 *   • permission_bypass audit emission
 *   • tool resolution + unknown-tool error path
 *   • parallel execute via AbortController
 *   • tool_start / tool_end SSE emission
 *   • transcript tool_call / tool_result append
 *   • afterToolUse observer hook
 */

import type { Session } from "../Session.js";
import type { SseWriter } from "../transport/SseWriter.js";
import type { LLMContentBlock } from "../transport/LLMClient.js";
import type { HookContext } from "../hooks/types.js";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  Tool,
  ToolContext,
  ToolResult,
} from "../Tool.js";
import { buildPreview, summariseToolOutput } from "../util/toolResult.js";

export type PermissionMode = "default" | "plan" | "auto" | "bypass";

/**
 * Threshold at which repeated unknown-tool dispatches abort the turn
 * with stop_reason `"unknown_tool_loop"`. Ten is generous — a
 * well-behaved LLM typos a tool name once, sees the error in
 * tool_result, and self-corrects by iteration #2 or #3. Ten
 * consecutive misses within one turn is ~always a hallucination loop.
 */
export const UNKNOWN_TOOL_LOOP_THRESHOLD = 10;

export interface ToolDispatchContext {
  readonly session: Session;
  readonly sse: SseWriter;
  readonly turnId: string;
  readonly permissionMode: PermissionMode;
  /** Build a HookContext for the given point. */
  readonly buildHookContext: (point: "beforeToolUse" | "afterToolUse") => HookContext;
  /** Fire-and-forget audit event (mirrors Turn.stageAuditEvent). */
  readonly stageAuditEvent: (event: string, data?: Record<string, unknown>) => void;
  /** Human-in-the-loop delegate — Turn's askUser. */
  readonly askUser: (input: AskUserQuestionInput) => Promise<AskUserQuestionOutput>;
  /**
   * Gap §11.3 unknown-tool guard — per-turn counter incremented on
   * every unknown tool_use. When it reaches `UNKNOWN_TOOL_LOOP_
   * THRESHOLD`, dispatch throws `UnknownToolLoopError` so Turn.ts
   * aborts with stop_reason=`unknown_tool_loop`. Optional for
   * backward-compat with callers (spawn pipelines) that don't want
   * the guard — when omitted the counter is internal to the dispatch
   * call and only the "available tools" enrichment kicks in.
   */
  readonly unknownToolCounter?: {
    get: () => number;
    inc: () => number;
  };
  /**
   * Names of tools actually exposed to the LLM for this turn (after
   * plan-mode filter + intent classification + MAX_TOOLS_PER_TURN cap).
   *
   * Two purposes (codex P1, 2026-04-20):
   *   1. The unknown-tool enrichment hint is built from this list, not
   *      from the full registry — prevents plan-mode from leaking
   *      `Bash` / `FileWrite` names to the LLM via an error message.
   *   2. Dispatch enforces this allowlist at execution time: a tool
   *      that resolves in the registry but is NOT in this set is
   *      treated exactly like an unknown tool (error tool_result,
   *      counter increment). Without this the registry-level resolver
   *      would happily execute a hidden tool the LLM named after seeing
   *      it in a prior hint.
   *
   * Optional for back-compat with spawn pipelines and tests that
   * dispatch directly. When omitted, allowlist enforcement is skipped
   * and the hint falls back to the full registry (legacy behaviour).
   */
  readonly exposedToolNames?: readonly string[];
}

export interface ToolDispatchResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * Thrown by `dispatch` when the per-turn unknown-tool counter reaches
 * `UNKNOWN_TOOL_LOOP_THRESHOLD`. Turn.ts catches and aborts the turn
 * with `stop_reason = "unknown_tool_loop"` + user-facing SSE text.
 */
export class UnknownToolLoopError extends Error {
  readonly stopReason = "unknown_tool_loop";
  readonly unknownToolCount: number;
  constructor(count: number) {
    super(`unknown_tool_loop: ${count} unknown tool dispatches in one turn`);
    this.name = "UnknownToolLoopError";
    this.unknownToolCount = count;
  }
}

/**
 * Execute tool_use blocks in parallel. Independence is assumed (§7.3)
 * — each tool's transcript entries and SSE emissions are interleaved
 * but self-contained so ordering doesn't matter semantically.
 */
export async function dispatch(
  ctx: ToolDispatchContext,
  toolUses: Array<Extract<LLMContentBlock, { type: "tool_use" }>>,
): Promise<ToolDispatchResult[]> {
  const abortController = new AbortController();
  const runs = toolUses.map((tu) => dispatchOne(ctx, tu, abortController));
  const results = await Promise.all(runs);
  // Gap §11.3 — if the per-turn counter crossed the threshold during
  // this batch, tell Turn.ts to abort. Emit a user-facing text_delta
  // FIRST so the UI shows the reason before the abort propagates.
  const counter = ctx.unknownToolCounter;
  if (counter && counter.get() >= UNKNOWN_TOOL_LOOP_THRESHOLD) {
    ctx.sse.agent({
      type: "text_delta",
      delta: "⚠️ 할루시네이션한 툴 호출 반복 감지. 턴 종료.",
    });
    ctx.stageAuditEvent("unknown_tool_loop", {
      count: counter.get(),
      threshold: UNKNOWN_TOOL_LOOP_THRESHOLD,
    });
    throw new UnknownToolLoopError(counter.get());
  }
  return results;
}

async function dispatchOne(
  ctx: ToolDispatchContext,
  tu: Extract<LLMContentBlock, { type: "tool_use" }>,
  abortController: AbortController,
): Promise<ToolDispatchResult> {
  const { session, sse, turnId, permissionMode } = ctx;
  const registryTool = session.agent.tools.resolve(tu.name);
  // Codex P1 (2026-04-20): enforce the exposed-tool allowlist here.
  // A tool that resolves in the registry but wasn't advertised to the
  // LLM this turn (plan-mode filter / intent filter / MAX_TOOLS cap)
  // is treated as unknown — prevents post-hint escalation into hidden
  // tools like Bash / FileWrite. When no allowlist is passed (spawn
  // pipelines, tests) we fall back to registry-only resolution.
  const exposed = ctx.exposedToolNames;
  const tool =
    registryTool && (exposed === undefined || exposed.includes(tu.name))
      ? registryTool
      : null;
  const started = Date.now();

  // Emit tool_start with input_preview — clients render this as the
  // expandable activity card. 400 char cap keeps it light over SSE.
  const inputPreview = buildPreview(tu.input);
  sse.agent({
    type: "tool_start",
    id: tu.id,
    name: tu.name,
    input_preview: inputPreview,
  });

  if (!tool) {
    // Gap §11.3 — enrich the tool_result with the available tool list
    // so the LLM can self-correct immediately instead of retrying the
    // same typo. Also increment the per-turn unknown-tool counter so
    // `dispatch()` can detect a hallucination loop at the batch
    // boundary and abort the turn once the threshold is reached.
    const counter = ctx.unknownToolCounter;
    const currentCount = counter ? counter.inc() : 0;
    // Hint is built from the EXPOSED tool set when available. Falling
    // back to the full registry would leak hidden tool names to the
    // LLM in plan mode or intent-filtered turns (codex P1, 2026-04-20).
    const sourceNames =
      ctx.exposedToolNames !== undefined
        ? ctx.exposedToolNames
        : session.agent.tools
            .list()
            .map((t) => t.name)
            .filter((n): n is string => typeof n === "string" && n.length > 0);
    const availableNames = Array.from(new Set(sourceNames)).sort();
    const preview = availableNames.slice(0, 20).join(", ");
    const suffix = availableNames.length > 20 ? `, ... (+${availableNames.length - 20} more)` : "";
    const listText = availableNames.length > 0 ? `${preview}${suffix}` : "(none)";
    const err = `Unknown tool: ${tu.name}. Available tools: ${listText}.`;
    console.warn(
      `[clawy-agent] unknown_tool=${tu.name} turnId=${turnId} count=${currentCount}`,
    );
    sse.agent({
      type: "tool_end",
      id: tu.id,
      status: "error",
      durationMs: Date.now() - started,
      output_preview: err,
    });
    await session.transcript.append({
      kind: "tool_result",
      ts: Date.now(),
      turnId,
      toolUseId: tu.id,
      status: "unknown_tool",
      output: err,
      isError: true,
    });
    return { toolUseId: tu.id, content: err, isError: true };
  }

  // ── beforeToolUse hook ─────────────────────────────────────
  // Hooks may rewrite the input or block with a reason (which
  // becomes the tool_result content with is_error=true so the
  // model can self-correct). T2-07 — thread the askUser delegate
  // so hooks returning `permission_decision: "ask"` can reach the
  // human via the turn's pendingAsks machinery.
  //
  // T2-08 — `permissionMode=bypass` sessions (admin / shadow)
  // skip the beforeToolUse chain entirely. An audit event
  // `permission_bypass` is emitted per tool so the skipped hook
  // chain is still observable.
  const bypass = permissionMode === "bypass";
  if (bypass) {
    ctx.stageAuditEvent("permission_bypass", {
      toolName: tu.name,
      toolUseId: tu.id,
    });
  }
  const preTool = bypass
    ? {
        action: "continue" as const,
        args: { toolName: tu.name, toolUseId: tu.id, input: tu.input },
      }
    : await session.agent.hooks.runPre(
        "beforeToolUse",
        { toolName: tu.name, toolUseId: tu.id, input: tu.input },
        {
          ...ctx.buildHookContext("beforeToolUse"),
          askUser: (q) => ctx.askUser(q),
        },
      );

  if (preTool.action === "block") {
    const blockedMsg = `blocked by hook: ${preTool.reason}`;
    sse.agent({
      type: "tool_end",
      id: tu.id,
      status: "permission_denied",
      durationMs: Date.now() - started,
      output_preview: blockedMsg,
    });
    await session.transcript.append({
      kind: "tool_result",
      ts: Date.now(),
      turnId,
      toolUseId: tu.id,
      status: "permission_denied",
      output: blockedMsg,
      isError: true,
    });
    return { toolUseId: tu.id, content: blockedMsg, isError: true };
  }
  const effectiveInput =
    preTool.action === "continue" ? preTool.args.input : tu.input;

  await session.transcript.append({
    kind: "tool_call",
    ts: Date.now(),
    turnId,
    toolUseId: tu.id,
    name: tu.name,
    input: effectiveInput,
  });

  const toolCtx: ToolContext = {
    botId: session.agent.config.botId,
    sessionKey: session.meta.sessionKey,
    turnId,
    workspaceRoot: session.agent.config.workspaceRoot,
    abortSignal: abortController.signal,
    emitProgress: (p) => {
      sse.agent({ type: "tool_start", id: tu.id, name: p.label });
    },
    emitAgentEvent: (event) => {
      // Tool-emitted structured events (task_board, future
      // artifact_* etc.) go onto the same SSE agent channel.
      sse.agent(event as Parameters<typeof sse.agent>[0]);
    },
    askUser: (q) => ctx.askUser(q),
    staging: {
      stageFileWrite: () => {
        /* Phase 1c: StagedWriteJournal; tools currently write directly */
      },
      stageTranscriptAppend: () => {
        /* no-op — Turn owns transcript directly */
      },
      stageAuditEvent: (event: string, data?: Record<string, unknown>) => {
        // Phase 2h — fire-and-forget append to the per-bot audit log.
        // Best-effort (errors swallowed inside AuditLog) so audit
        // failures never abort a turn (§6 invariant G).
        void session.agent.auditLog.append(
          event,
          session.meta.sessionKey,
          turnId,
          data,
        );
      },
    },
  };

  let result: ToolResult;
  try {
    result = await (tool as Tool<unknown, unknown>).execute(effectiveInput, toolCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      status: "error",
      errorCode: "tool_threw",
      errorMessage: msg,
      durationMs: Date.now() - started,
    };
  }

  const previewSource = result.output ?? result.errorMessage ?? "";
  const preview =
    typeof previewSource === "string"
      ? previewSource
      : JSON.stringify(previewSource);
  const content = summariseToolOutput(result);
  const isError = result.status !== "ok";

  sse.agent({
    type: "tool_end",
    id: tu.id,
    status: result.status,
    durationMs: result.durationMs,
    output_preview:
      preview.length > 400 ? `${preview.slice(0, 400)}...` : preview,
  });
  await session.transcript.append({
    kind: "tool_result",
    ts: Date.now(),
    turnId,
    toolUseId: tu.id,
    status: result.status,
    output: content.slice(0, 64 * 1024),
    isError,
  });

  // ── afterToolUse hook (observer) ───────────────────────────
  void session.agent.hooks.runPost(
    "afterToolUse",
    { toolName: tu.name, toolUseId: tu.id, input: effectiveInput, result },
    ctx.buildHookContext("afterToolUse"),
  );

  return { toolUseId: tu.id, content, isError };
}
