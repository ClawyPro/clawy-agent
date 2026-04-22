/**
 * ContextEngine — first-class compaction boundary orchestration (T1-02).
 * Design reference: §7.12.b (revised 2026-04-19) +
 * docs/plans/2026-04-19-core-agent-phase-3-plan.md §3 T1-02.
 *
 * Replaces the superseded "anchor-in-prompt" design (§7.12.b draft)
 * which replicated OpenClaw issue #48547 — second-pass compaction
 * absorbed the regex-detected `<compaction-handoff>` string and the
 * boundary vanished. See docs/notes/2026-04-19-cc-parity-audit-01-agent-loop.md.
 *
 * The revised design stores each compaction as a
 * `TranscriptEntry.kind = "compaction_boundary"` row inside the
 * append-only transcript. `buildMessagesFromTranscript` partitions
 * entries around every boundary and emits a single synthetic system
 * summary message per boundary; entries AFTER the latest boundary
 * replay as normal user / assistant / tool messages. The model never
 * sees the literal anchor string — the summary IS the content of an
 * ordinary system message.
 *
 * Mirrors CC's `src/services/compact/` separation of concerns.
 */

import crypto from "node:crypto";
import { monotonicFactory } from "ulid";
import type { Session } from "../../Session.js";
import type { LLMClient, LLMMessage, LLMContentBlock } from "../../transport/LLMClient.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";
import { isCompactionBoundary } from "../../storage/Transcript.js";
import { getContextWindowOrDefault } from "../../llm/modelCapabilities.js";

export type CompactionBoundaryEntry = Extract<
  TranscriptEntry,
  { kind: "compaction_boundary" }
>;

/**
 * Gap §11.6 — default reserve-token floor (response + tool-result
 * headroom) requested when no per-engine override is given. Capped at
 * runtime to `contextWindow * RESERVE_TOKEN_CAP_FRACTION` so small-
 * window models never starve themselves of live budget.
 */
export const DEFAULT_RESERVE_TOKENS = 40_000;

/**
 * Gap §11.6 — cap the reserve floor at 20 % of the model's context
 * window. Rationale:
 *   - 20 % is the "one-shot response + a couple of tool round-trips"
 *     budget that keeps the live transcript feasible even after a
 *     maximal compaction.
 *   - Any higher and a 16k-window model would reserve more than the
 *     post-compaction summary fits, producing an infinite compact
 *     loop (the exact failure mode Codex CLI hit upstream).
 *   - Any lower and a large-window model would leak too much budget
 *     into history, forcing premature compaction under normal load.
 */
export const RESERVE_TOKEN_CAP_FRACTION = 0.2;

/**
 * Gap §11.6 — minimum viable live budget (post-compaction) below which
 * we declare compaction_impossible instead of looping. 5k is empirical
 * for "Haiku can still emit a boundary summary and the successor turn
 * can still produce a usable reply + one tool call."
 */
export const DEFAULT_MIN_VIABLE_BUDGET_TOKENS = 5_000;

/**
 * Emitted to the SSE stream when the routed model's effective budget
 * cannot fit even a fully compacted transcript. The caller (Session)
 * translates this into an `agent_event.compaction_impossible` + a
 * user-facing text_delta in Korean.
 */
export class CompactionImpossibleError extends Error {
  readonly code = "compaction_impossible";
  readonly model: string;
  readonly contextWindow: number;
  readonly effectiveReserveTokens: number;
  readonly effectiveBudgetTokens: number;
  readonly minViableBudgetTokens: number;

  constructor(opts: {
    model: string;
    contextWindow: number;
    effectiveReserveTokens: number;
    effectiveBudgetTokens: number;
    minViableBudgetTokens: number;
  }) {
    super(
      `compaction_impossible: model=${opts.model} window=${opts.contextWindow} ` +
        `reserve=${opts.effectiveReserveTokens} budget=${opts.effectiveBudgetTokens} ` +
        `min=${opts.minViableBudgetTokens}`,
    );
    this.name = "CompactionImpossibleError";
    this.model = opts.model;
    this.contextWindow = opts.contextWindow;
    this.effectiveReserveTokens = opts.effectiveReserveTokens;
    this.effectiveBudgetTokens = opts.effectiveBudgetTokens;
    this.minViableBudgetTokens = opts.minViableBudgetTokens;
  }
}

export interface ContextEngineOptions {
  /** Default wall-clock deadline for the Haiku summarisation call. */
  haikuDeadlineMs?: number;
  /** Override the Haiku model id (tests). */
  summaryModel?: string;
  /**
   * Gap §11.6 — caller-configured reserve-token floor for live
   * response + tool-result budget. The engine caps this at runtime
   * to `contextWindow * RESERVE_TOKEN_CAP_FRACTION`, so a caller
   * requesting 40k on a 16k-window model will see the effective
   * reserve shrink to 3.2k rather than starve the model.
   */
  reserveTokens?: number;
  /**
   * Gap §11.6 — minimum post-compaction live budget below which the
   * engine gives up with `CompactionImpossibleError` instead of
   * looping. Default 5k.
   */
  minViableBudgetTokens?: number;
  /**
   * Gap §11.6 — resolver that takes a model id and returns its
   * context window. Injected so tests can stub hypothetical 16k /
   * 2k models without editing the real capability registry.
   * Default: `getContextWindowOrDefault` from modelCapabilities.
   */
  contextWindowResolver?: (model: string) => number;
}

/**
 * ContextEngine decides whether to compact and rehydrates transcripts
 * into LLM messages across prior compaction boundaries.
 */
export class ContextEngine {
  private readonly ulid = monotonicFactory();
  private readonly haikuDeadlineMs: number;
  private readonly summaryModel: string;
  private readonly configuredReserveTokens: number;
  private readonly minViableBudgetTokens: number;
  private readonly contextWindowResolver: (model: string) => number;

  constructor(
    private readonly llm: LLMClient,
    opts: ContextEngineOptions = {},
  ) {
    this.haikuDeadlineMs = opts.haikuDeadlineMs ?? 10_000;
    this.summaryModel = opts.summaryModel ?? "claude-haiku-4-5";
    this.configuredReserveTokens = opts.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
    this.minViableBudgetTokens =
      opts.minViableBudgetTokens ?? DEFAULT_MIN_VIABLE_BUDGET_TOKENS;
    this.contextWindowResolver =
      opts.contextWindowResolver ?? getContextWindowOrDefault;
  }

  /**
   * Gap §11.6 — compute the effective reserve floor for a model,
   * capped at `RESERVE_TOKEN_CAP_FRACTION` of its context window.
   *
   * Exposed for tests and observability; Turn-layer code should keep
   * calling `maybeCompact`, which uses this internally.
   */
  effectiveReserveTokens(model: string): number {
    const windowTokens = this.contextWindowResolver(model);
    const cap = Math.floor(windowTokens * RESERVE_TOKEN_CAP_FRACTION);
    return Math.min(this.configuredReserveTokens, cap);
  }

  /**
   * Decide whether the current transcript exceeds `tokenLimit` and, if
   * so, summarise everything up to now into a new
   * `compaction_boundary` entry appended to the transcript.
   *
   * Returns the created boundary entry, or `null` when:
   *   - token count is under threshold; OR
   *   - the Haiku call failed (fail-open — never block a turn on a
   *     failed compaction attempt).
   *
   * Gap §11.6 — before compacting, the engine verifies that the routed
   * model's context window can hold `(effectiveReserveFloor + minViable
   * LiveBudget)` at all. If even a perfectly compacted transcript would
   * leave < `minViableBudgetTokens` of live room, the engine throws
   * `CompactionImpossibleError` so the caller can translate it into a
   * user-facing SSE `compaction_impossible` event + prompt the user to
   * switch to a larger-window model. Without this cap a small-context
   * model routed mid-session would loop forever trying to compact into
   * a reserve that's already larger than its window.
   *
   * The `model` parameter is used only for the §11.6 cap/floor check;
   * it does NOT affect the Haiku summariser (summaryModel). When omitted
   * the engine skips the §11.6 check — existing callers who haven't
   * opted in behave exactly as before (29d8da97 boundary semantics
   * untouched).
   *
   * Idempotency / race: `summaryHash` is sha256 of `summaryText`. If
   * two boundaries land simultaneously the one with the lower
   * `boundaryId` (ULID lex order) wins when `buildMessagesFromTranscript`
   * sorts by on-disk order. No regex re-parsing is ever performed.
   */
  async maybeCompact(
    session: Session,
    transcriptEntries: readonly TranscriptEntry[],
    tokenLimit: number,
    model?: string,
  ): Promise<CompactionBoundaryEntry | null> {
    const before = estimateTranscriptTokens(transcriptEntries);
    if (before < tokenLimit) return null;

    // §11.6 pre-flight: is there enough window to even bother trying?
    // Runs only when the caller passed the model id. Throws so the
    // caller's error handler can surface `compaction_impossible` —
    // silently returning null would drop the turn into an infinite
    // compaction-loop at the call site.
    if (model !== undefined) {
      this.assertCompactionFeasible(model);
    }

    const summaryText = await this.summarise(transcriptEntries);
    if (summaryText === null) {
      // Fail-open: Haiku failed / timed out. No boundary this turn.
      return null;
    }

    const after = estimateTextTokens(summaryText);

    // §11.6 post-flight: even after compaction, does the live budget
    // clear the minimum viable threshold? Typically redundant with the
    // pre-flight check (pre-flight rejects tiny windows by definition),
    // but protects against a Haiku summary that expanded past the
    // window anyway.
    if (model !== undefined) {
      const windowTokens = this.contextWindowResolver(model);
      const reserve = this.effectiveReserveTokens(model);
      const postBudget = windowTokens - reserve - after;
      if (postBudget < this.minViableBudgetTokens) {
        throw new CompactionImpossibleError({
          model,
          contextWindow: windowTokens,
          effectiveReserveTokens: reserve,
          effectiveBudgetTokens: postBudget,
          minViableBudgetTokens: this.minViableBudgetTokens,
        });
      }
    }

    const summaryHash = sha256Hex(summaryText);
    const createdAt = Date.now();
    const boundary: CompactionBoundaryEntry = {
      kind: "compaction_boundary",
      ts: createdAt,
      turnId: session.meta.sessionKey, // sessionKey as scope — no active turn at compaction time
      boundaryId: this.ulid(),
      beforeTokenCount: before,
      afterTokenCount: after,
      summaryHash,
      summaryText,
      createdAt,
    };
    await session.transcript.append(boundary);
    return boundary;
  }

  /**
   * §11.6 pre-flight. Throws `CompactionImpossibleError` if the model's
   * context window can't accommodate the reserve floor + minimum
   * viable live budget, even before a single token is spent on
   * transcript history. Shared between `maybeCompact` and any future
   * route-time model-swap guard.
   */
  assertCompactionFeasible(model: string): void {
    const windowTokens = this.contextWindowResolver(model);
    const reserve = this.effectiveReserveTokens(model);
    const headroom = windowTokens - reserve;
    if (headroom < this.minViableBudgetTokens) {
      throw new CompactionImpossibleError({
        model,
        contextWindow: windowTokens,
        effectiveReserveTokens: reserve,
        effectiveBudgetTokens: headroom,
        minViableBudgetTokens: this.minViableBudgetTokens,
      });
    }
  }

  /**
   * Rehydrate a transcript into LLM messages, collapsing everything
   * BEFORE the latest compaction boundary (inclusive of any earlier
   * boundaries) into a single synthetic system summary message per
   * boundary. Post-boundary entries replay as ordinary messages.
   *
   * When the transcript contains multiple boundaries, each boundary's
   * `summaryText` produces its own system message; entries in between
   * two boundaries are discarded (they were already absorbed into the
   * later boundary's summary). Only the entries AFTER the final
   * boundary replay verbatim.
   */
  buildMessagesFromTranscript(entries: readonly TranscriptEntry[]): LLMMessage[] {
    const sorted = [...entries].sort(sortEntries);

    // Find the last compaction boundary. Everything before it is
    // superseded by its summary; only that summary + post-boundary
    // entries survive. If no boundary, replay the whole transcript.
    let lastBoundaryIdx = -1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const entry = sorted[i];
      if (entry && isCompactionBoundary(entry)) {
        lastBoundaryIdx = i;
        break;
      }
    }

    const messages: LLMMessage[] = [];

    if (lastBoundaryIdx >= 0) {
      const boundary = sorted[lastBoundaryIdx] as CompactionBoundaryEntry;
      messages.push(renderBoundaryAsSystemMessage(boundary));
      for (let i = lastBoundaryIdx + 1; i < sorted.length; i++) {
        const entry = sorted[i];
        if (!entry) continue;
        const msg = transcriptEntryToMessage(entry);
        if (msg) messages.push(msg);
      }
      return messages;
    }

    for (const entry of sorted) {
      const msg = transcriptEntryToMessage(entry);
      if (msg) messages.push(msg);
    }
    return messages;
  }

  /**
   * Drive a single Haiku summarisation round-trip against the
   * pre-compaction transcript. Returns `null` on any failure so the
   * caller fails open (no boundary is written).
   */
  private async summarise(
    entries: readonly TranscriptEntry[],
  ): Promise<string | null> {
    const deadline = Date.now() + this.haikuDeadlineMs;
    const system = [
      "You compact a conversational transcript into a compact handoff",
      "summary for a successor assistant instance. Preserve:",
      "- Active task / goal.",
      "- Decisions already made.",
      "- Open questions / pending sub-tasks.",
      "- Files, ids, and numeric values the successor needs.",
      "Write 10-30 lines of dense prose. No preamble, no postamble.",
    ].join("\n");

    const userPayload = renderEntriesForSummary(entries).slice(0, 180_000);

    let output = "";
    try {
      const stream = this.llm.stream({
        model: this.summaryModel,
        system,
        messages: [{ role: "user", content: userPayload }],
        max_tokens: 1024,
        temperature: 0,
      });
      for await (const evt of stream) {
        if (Date.now() > deadline) return null;
        if (evt.kind === "text_delta") output += evt.delta;
        if (evt.kind === "error") return null;
        if (evt.kind === "message_end") break;
      }
    } catch {
      return null;
    }

    const trimmed = output.trim();
    if (trimmed.length === 0) return null;
    return trimmed;
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function sortEntries(a: TranscriptEntry, b: TranscriptEntry): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  // Deterministic tie-breaker: compaction_boundary sorts by boundaryId
  // (ULID — lex order == time order) so simultaneous boundaries pick
  // a stable winner.
  if (isCompactionBoundary(a) && isCompactionBoundary(b)) {
    return a.boundaryId < b.boundaryId ? -1 : a.boundaryId > b.boundaryId ? 1 : 0;
  }
  return 0;
}

function renderBoundaryAsSystemMessage(
  boundary: CompactionBoundaryEntry,
): LLMMessage {
  const iso = new Date(boundary.createdAt).toISOString();
  const content = `[Compaction boundary ${boundary.boundaryId} @ ${iso}]\n${boundary.summaryText}`;
  return { role: "user", content: [{ type: "text", text: content } as LLMContentBlock] };
}

function transcriptEntryToMessage(entry: TranscriptEntry): LLMMessage | null {
  if (entry.kind === "user_message") {
    return { role: "user", content: entry.text };
  }
  if (entry.kind === "assistant_text") {
    const block: LLMContentBlock = { type: "text", text: entry.text };
    return { role: "assistant", content: [block] };
  }
  return null;
}

function estimateTranscriptTokens(entries: readonly TranscriptEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "user_message" || entry.kind === "assistant_text") {
      total += estimateTextTokens(entry.text);
    } else if (entry.kind === "tool_call") {
      total += estimateTextTokens(JSON.stringify(entry.input ?? {}));
    } else if (entry.kind === "tool_result") {
      total += estimateTextTokens(entry.output ?? "");
    } else if (isCompactionBoundary(entry)) {
      total += entry.afterTokenCount;
    }
  }
  return total;
}

/**
 * Cheap char-based token estimate (~4 chars/token). Replaces a tiktoken
 * dependency for the threshold check — exact count is unnecessary
 * because `tokenLimit` is itself heuristic.
 */
function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function renderEntriesForSummary(entries: readonly TranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "user_message") {
      lines.push(`USER: ${entry.text}`);
    } else if (entry.kind === "assistant_text") {
      lines.push(`ASSISTANT: ${entry.text}`);
    } else if (entry.kind === "tool_call") {
      lines.push(`TOOL_CALL ${entry.name}: ${JSON.stringify(entry.input ?? {})}`);
    } else if (entry.kind === "tool_result") {
      lines.push(`TOOL_RESULT ${entry.status}: ${entry.output ?? ""}`);
    } else if (isCompactionBoundary(entry)) {
      lines.push(`PRIOR_BOUNDARY ${entry.boundaryId}: ${entry.summaryText}`);
    }
  }
  return lines.join("\n");
}

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
