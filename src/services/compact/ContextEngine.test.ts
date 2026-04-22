/**
 * ContextEngine tests (T1-02).
 *
 * Covers the six cases required by docs/plans/2026-04-19-core-agent-phase-3-plan.md §3 T1-02:
 *   1. No boundary → entries replay as-is.
 *   2. One boundary → pre-boundary collapsed to synthetic summary, post-boundary normal.
 *   3. Two boundaries → latest summary wins; earlier boundary + its post entries dropped.
 *   4. maybeCompact under threshold → no boundary written, returns null.
 *   5. maybeCompact over threshold with working Haiku → boundary created with sha256 hash.
 *   6. maybeCompact with failing Haiku → fail open, returns null, no boundary.
 */

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  ContextEngine,
  CompactionImpossibleError,
  RESERVE_TOKEN_CAP_FRACTION,
  type CompactionBoundaryEntry,
} from "./ContextEngine.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";
import type {
  LLMClient,
  LLMEvent,
  LLMStreamRequest,
} from "../../transport/LLMClient.js";
import type { Session } from "../../Session.js";

// ── Mocks ──────────────────────────────────────────────────────────────

interface MockLLM {
  client: LLMClient;
  calls: LLMStreamRequest[];
}

function mockLLM(
  responder: (req: LLMStreamRequest) => LLMEvent[] | Error,
): MockLLM {
  const calls: LLMStreamRequest[] = [];
  async function* stream(
    req: LLMStreamRequest,
  ): AsyncGenerator<LLMEvent, void, void> {
    calls.push(req);
    const result = responder(req);
    if (result instanceof Error) throw result;
    for (const evt of result) yield evt;
  }
  // Only `stream` is used by ContextEngine — cast is intentional.
  const client = { stream } as unknown as LLMClient;
  return { client, calls };
}

interface FakeTranscript {
  appended: TranscriptEntry[];
  append: (entry: TranscriptEntry) => Promise<void>;
}

function fakeTranscript(): FakeTranscript {
  const appended: TranscriptEntry[] = [];
  return {
    appended,
    append: async (entry: TranscriptEntry) => {
      appended.push(entry);
    },
  };
}

function fakeSession(
  sessionKey = "agent:main:test:1",
): { session: Session; transcript: FakeTranscript } {
  const transcript = fakeTranscript();
  const session = {
    meta: { sessionKey },
    transcript,
  } as unknown as Session;
  return { session, transcript };
}

// ── Fixtures ───────────────────────────────────────────────────────────

function userEntry(turnId: string, text: string, ts = 1_000): TranscriptEntry {
  return { kind: "user_message", ts, turnId, text };
}

function assistantEntry(
  turnId: string,
  text: string,
  ts = 2_000,
): TranscriptEntry {
  return { kind: "assistant_text", ts, turnId, text };
}

function boundaryEntry(
  boundaryId: string,
  summaryText: string,
  ts: number,
): CompactionBoundaryEntry {
  return {
    kind: "compaction_boundary",
    ts,
    turnId: "agent:main:test:1",
    boundaryId,
    beforeTokenCount: 10_000,
    afterTokenCount: 200,
    summaryHash: crypto.createHash("sha256").update(summaryText).digest("hex"),
    summaryText,
    createdAt: ts,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ContextEngine.buildMessagesFromTranscript", () => {
  it("replays all entries as-is when no compaction boundary exists", () => {
    const { client } = mockLLM(() => []);
    const engine = new ContextEngine(client);

    const entries: TranscriptEntry[] = [
      userEntry("t1", "hello", 1_000),
      assistantEntry("t1", "world", 2_000),
      userEntry("t2", "again", 3_000),
    ];

    const messages = engine.buildMessagesFromTranscript(entries);
    expect(messages.length).toBe(3);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("hello");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[2]?.content).toBe("again");
  });

  it("collapses pre-boundary entries into a single synthetic summary message", () => {
    const { client } = mockLLM(() => []);
    const engine = new ContextEngine(client);

    const entries: TranscriptEntry[] = [
      userEntry("t1", "old-user", 1_000),
      assistantEntry("t1", "old-assistant", 2_000),
      boundaryEntry("01HB1", "SUMMARY-OF-T1", 3_000),
      userEntry("t2", "new-user", 4_000),
      assistantEntry("t2", "new-assistant", 5_000),
    ];

    const messages = engine.buildMessagesFromTranscript(entries);
    expect(messages.length).toBe(3);
    // [0] is the synthetic summary.
    const summary = messages[0];
    expect(summary).toBeDefined();
    const summaryContent = Array.isArray(summary!.content)
      ? summary!.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : summary!.content;
    expect(summaryContent).toContain("[Compaction boundary 01HB1");
    expect(summaryContent).toContain("SUMMARY-OF-T1");
    // [1] + [2] are post-boundary entries in order.
    expect(messages[1]?.content).toBe("new-user");
    expect(messages[2]?.role).toBe("assistant");
  });

  it("collapses to only the latest boundary summary when multiple boundaries exist", () => {
    const { client } = mockLLM(() => []);
    const engine = new ContextEngine(client);

    const entries: TranscriptEntry[] = [
      userEntry("t1", "oldest-user", 1_000),
      boundaryEntry("01HB1", "SUMMARY-1", 2_000),
      userEntry("t2", "between-user", 3_000),
      assistantEntry("t2", "between-assistant", 4_000),
      boundaryEntry("01HB2", "SUMMARY-2", 5_000),
      userEntry("t3", "latest-user", 6_000),
    ];

    const messages = engine.buildMessagesFromTranscript(entries);
    expect(messages.length).toBe(2);
    const summaryContent = Array.isArray(messages[0]!.content)
      ? messages[0]!.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : (messages[0]!.content as string);
    expect(summaryContent).toContain("01HB2");
    expect(summaryContent).toContain("SUMMARY-2");
    // Earlier summary is dropped (it was absorbed into SUMMARY-2's context).
    expect(summaryContent).not.toContain("SUMMARY-1");
    expect(messages[1]?.content).toBe("latest-user");
  });
});

describe("ContextEngine.maybeCompact", () => {
  it("does not compact below the token threshold", async () => {
    const { client, calls } = mockLLM(() => [
      { kind: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const engine = new ContextEngine(client);
    const { session, transcript } = fakeSession();

    const entries: TranscriptEntry[] = [
      userEntry("t1", "short message", 1_000),
    ];

    const result = await engine.maybeCompact(session, entries, /*tokenLimit*/ 1_000_000);
    expect(result).toBeNull();
    expect(transcript.appended.length).toBe(0);
    expect(calls.length).toBe(0); // no Haiku call when under threshold
  });

  it("creates a boundary with sha256 hash when Haiku succeeds", async () => {
    const summaryPayload = "compact summary of everything that happened";
    const { client, calls } = mockLLM(() => [
      { kind: "text_delta", blockIndex: 0, delta: summaryPayload },
      { kind: "message_end", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const engine = new ContextEngine(client);
    const { session, transcript } = fakeSession();

    // 20_000-char user message ≈ 5_000 tokens at 4 chars/token heuristic.
    const bigText = "x".repeat(20_000);
    const entries: TranscriptEntry[] = [userEntry("t1", bigText, 1_000)];

    const boundary = await engine.maybeCompact(session, entries, /*tokenLimit*/ 1_000);
    expect(boundary).not.toBeNull();
    expect(boundary!.kind).toBe("compaction_boundary");
    expect(boundary!.summaryText).toBe(summaryPayload);
    expect(boundary!.summaryHash).toBe(
      crypto.createHash("sha256").update(summaryPayload).digest("hex"),
    );
    expect(boundary!.beforeTokenCount).toBeGreaterThanOrEqual(1_000);
    expect(boundary!.afterTokenCount).toBeLessThan(boundary!.beforeTokenCount);
    expect(transcript.appended.length).toBe(1);
    expect(transcript.appended[0]).toBe(boundary);
    expect(calls.length).toBe(1);
  });

  it("fails open (returns null, no boundary) when Haiku errors out", async () => {
    const { client } = mockLLM(() => new Error("haiku upstream down"));
    const engine = new ContextEngine(client);
    const { session, transcript } = fakeSession();

    const bigText = "y".repeat(20_000);
    const entries: TranscriptEntry[] = [userEntry("t1", bigText, 1_000)];

    const result = await engine.maybeCompact(session, entries, /*tokenLimit*/ 1_000);
    expect(result).toBeNull();
    expect(transcript.appended.length).toBe(0);
  });
});

// ── Gap §11.6 — reserve-token floor capped to model context window ─────

describe("ContextEngine §11.6 reserve-token floor (model-aware)", () => {
  it("caps reserveTokens to RESERVE_TOKEN_CAP_FRACTION × contextWindow on a 16k model", () => {
    const { client } = mockLLM(() => []);
    // Caller requests a 40k reserve (sized for 200k-window Sonnet/Opus),
    // but the router hands the turn to a hypothetical 16k-window model.
    // The engine must cap the reserve at 20% × 16k = 3.2k, not honour
    // the configured 40k (which would exceed the whole window).
    const engine = new ContextEngine(client, {
      reserveTokens: 40_000,
      contextWindowResolver: (m) => (m === "tiny-16k" ? 16_000 : 200_000),
    });

    const effective = engine.effectiveReserveTokens("tiny-16k");
    expect(effective).toBe(Math.floor(16_000 * RESERVE_TOKEN_CAP_FRACTION));
    expect(effective).toBe(3_200);
    expect(effective).toBeLessThan(40_000);

    // Sanity: on a normal 200k model the configured 40k wins (40k <
    // 20% × 200k = 40k — ties go to the configured value via `min`).
    expect(engine.effectiveReserveTokens("big-200k")).toBe(40_000);
  });

  it("compacts successfully when transcript overflows a 16k window that still clears the min-viable budget", async () => {
    const summaryPayload = "mid";
    const { client } = mockLLM(() => [
      { kind: "text_delta", blockIndex: 0, delta: summaryPayload },
      { kind: "message_end", stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } },
    ]);
    const engine = new ContextEngine(client, {
      // With a 16k window, reserve is capped to 3_200 and minViable
      // defaults to 5_000. Headroom = 16_000 − 3_200 = 12_800 ≥ 5_000
      // so the pre-flight passes and the boundary is written.
      reserveTokens: 40_000,
      minViableBudgetTokens: 5_000,
      contextWindowResolver: () => 16_000,
    });
    const { session, transcript } = fakeSession();

    // tokenLimit is the MessageBuilder-style "start compacting" threshold
    // (≈ 75% of window). We pass a transcript well over it to force the
    // compaction path.
    const tokenLimit = Math.floor(16_000 * 0.75); // 12_000
    const bigText = "z".repeat(60_000); // ~15k tokens at 4 chars/tok
    const entries: TranscriptEntry[] = [userEntry("t1", bigText, 1_000)];

    const boundary = await engine.maybeCompact(
      session,
      entries,
      tokenLimit,
      "tiny-16k",
    );
    expect(boundary).not.toBeNull();
    expect(boundary!.summaryText).toBe(summaryPayload);
    expect(transcript.appended.length).toBe(1);
  });

  it("throws CompactionImpossibleError (§11.6) when the routed model's window is below the min-viable budget", async () => {
    const { client, calls } = mockLLM(() => [
      { kind: "text_delta", blockIndex: 0, delta: "won't-get-here" },
      { kind: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const engine = new ContextEngine(client, {
      // Hypothetical 2k-window edge: after capping reserve to 20% × 2k
      // = 400, headroom = 2_000 − 400 = 1_600 < minViable 5_000 →
      // compaction is impossible, so maybeCompact must throw BEFORE
      // calling Haiku (and the error must carry the diagnostic fields).
      reserveTokens: 40_000,
      minViableBudgetTokens: 5_000,
      contextWindowResolver: () => 2_000,
    });
    const { session, transcript } = fakeSession();

    const entries: TranscriptEntry[] = [userEntry("t1", "x".repeat(10_000), 1_000)];

    await expect(
      engine.maybeCompact(session, entries, /*tokenLimit*/ 100, "tiny-2k"),
    ).rejects.toBeInstanceOf(CompactionImpossibleError);

    // Re-throw to inspect fields; maybeCompact is deterministic so a
    // second call carries the same payload.
    let captured: CompactionImpossibleError | null = null;
    try {
      await engine.maybeCompact(session, entries, /*tokenLimit*/ 100, "tiny-2k");
    } catch (err) {
      captured = err as CompactionImpossibleError;
    }
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("tiny-2k");
    expect(captured!.contextWindow).toBe(2_000);
    expect(captured!.effectiveReserveTokens).toBe(400);
    expect(captured!.effectiveBudgetTokens).toBe(1_600);
    expect(captured!.minViableBudgetTokens).toBe(5_000);

    // No boundary written, no Haiku call (pre-flight rejected).
    expect(transcript.appended.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("assertCompactionFeasible exposes the §11.6 gate for route-time checks", () => {
    const { client } = mockLLM(() => []);
    const engine = new ContextEngine(client, {
      reserveTokens: 40_000,
      minViableBudgetTokens: 5_000,
      contextWindowResolver: (m) => (m === "tiny-2k" ? 2_000 : 200_000),
    });

    // Large window → feasible (no throw).
    expect(() => engine.assertCompactionFeasible("big-200k")).not.toThrow();

    // Tiny window → throws the tagged error so Session.runTurn can
    // emit the compaction_impossible SSE event before the turn even
    // starts executing tools.
    expect(() => engine.assertCompactionFeasible("tiny-2k")).toThrow(
      CompactionImpossibleError,
    );
  });

  it("model-less maybeCompact preserves legacy behaviour (29d8da97 boundary semantics untouched)", async () => {
    // Existing callers that pass no model id must keep their current
    // behaviour: no §11.6 check, boundaries still written on overflow.
    const summaryPayload = "legacy summary";
    const { client } = mockLLM(() => [
      { kind: "text_delta", blockIndex: 0, delta: summaryPayload },
      { kind: "message_end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const engine = new ContextEngine(client, {
      // Even with a resolver that would otherwise declare 2k
      // impossible, omitting `model` must skip the check entirely.
      minViableBudgetTokens: 5_000,
      contextWindowResolver: () => 2_000,
    });
    const { session, transcript } = fakeSession();

    const bigText = "q".repeat(20_000);
    const entries: TranscriptEntry[] = [userEntry("t1", bigText, 1_000)];

    const boundary = await engine.maybeCompact(
      session,
      entries,
      /*tokenLimit*/ 1_000,
      // no model arg
    );
    expect(boundary).not.toBeNull();
    expect(transcript.appended.length).toBe(1);
  });
});
