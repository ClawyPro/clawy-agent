/**
 * Tests for preRefusalVerifierHook (Layer 3 meta-cognitive scaffolding).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  countInvestigationsThisTurn,
  matchesRefusal,
  preRefusalVerifierHook,
} from "./preRefusalVerifier.js";
import type { HookContext } from "../types.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";

function makeCtx(transcript: TranscriptEntry[] = []): HookContext {
  return {
    botId: "bot-test",
    userId: "user-test",
    sessionKey: "session-test",
    turnId: "turn-1",
    llm: {} as never,
    transcript,
    emit: vi.fn(),
    log: vi.fn(),
    abortSignal: new AbortController().signal,
    deadlineMs: 10_000,
  };
}

function makeArgs(overrides: Partial<{
  assistantText: string;
  retryCount: number;
  userMessage: string;
}> = {}) {
  return {
    assistantText: "",
    toolCallCount: 0,
    toolReadHappened: false,
    userMessage: "Do I have the Apptronik contract files?",
    retryCount: 0,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.CORE_AGENT_PRE_REFUSAL_VERIFY;
});

describe("preRefusalVerifierHook", () => {
  it("declares name, point, priority 85, blocking", () => {
    expect(preRefusalVerifierHook.name).toBe("builtin:pre-refusal-verifier");
    expect(preRefusalVerifierHook.point).toBe("beforeCommit");
    expect(preRefusalVerifierHook.priority).toBe(85);
    expect(preRefusalVerifierHook.blocking).toBe(true);
  });

  it("blocks when draft matches refusal pattern and no investigation tools used", async () => {
    const args = makeArgs({
      assistantText: "Sorry, I don't have that file in my workspace.",
      retryCount: 0,
    });
    const result = await preRefusalVerifierHook.handler(args, makeCtx([]));
    if (result?.action !== "block") throw new Error("expected block");
    expect(result.reason).toContain("[RETRY:PRE_REFUSAL_VERIFY]");
    expect(result.reason).toContain("Glob");
    expect(result.reason).toContain("Grep");
    expect(result.reason).toContain("FileRead");
  });

  it("allows when draft matches refusal BUT investigation tools ran this turn", async () => {
    const transcript: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: 1,
        turnId: "turn-1",
        toolUseId: "tu-1",
        name: "Glob",
        input: { pattern: "**/*.html" },
      },
    ];
    const args = makeArgs({
      assistantText: "I checked and I cannot find that file in workspace.",
    });
    const result = await preRefusalVerifierHook.handler(args, makeCtx(transcript));
    expect(result).toEqual({ action: "continue" });
  });

  it("allows when draft has no refusal pattern", async () => {
    const args = makeArgs({
      assistantText: "Here is the summary you requested. Everything looks fine.",
    });
    const result = await preRefusalVerifierHook.handler(args, makeCtx([]));
    expect(result).toEqual({ action: "continue" });
  });

  it("fails open when retryCount >= MAX_RETRIES (1)", async () => {
    const args = makeArgs({
      assistantText: "KB에 해당 내용이 저장되어 있지 않습니다.",
      retryCount: 1,
    });
    const ctx = makeCtx([]);
    const result = await preRefusalVerifierHook.handler(args, ctx);
    expect(result).toEqual({ action: "continue" });
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("retry budget exhausted"),
      expect.any(Object),
    );
  });

  it("matches Korean refusal variants — 확인 불가 / 찾을 수 없", async () => {
    expect(matchesRefusal("해당 파일은 확인 불가합니다.")).toBe(true);
    expect(matchesRefusal("해당 내용을 찾을 수 없습니다.")).toBe(true);
    expect(matchesRefusal("KB에 해당 계약서가 저장되어 있지 않아서 답변 드릴 수 없습니다.")).toBe(true);
    expect(matchesRefusal("작업이 완료되었습니다.")).toBe(false);
  });

  it("matches English refusal variants — I don't / cannot verify / unable to confirm", async () => {
    expect(matchesRefusal("I don't have that information.")).toBe(true);
    expect(matchesRefusal("I cannot verify the existence of that file.")).toBe(true);
    expect(matchesRefusal("I'm unable to confirm whether that document exists.")).toBe(true);
    expect(matchesRefusal("No record of that contract.")).toBe(true);
    expect(matchesRefusal("Everything is ready and looking good.")).toBe(false);
  });

  it("respects CORE_AGENT_PRE_REFUSAL_VERIFY=off", async () => {
    process.env.CORE_AGENT_PRE_REFUSAL_VERIFY = "off";
    const args = makeArgs({
      assistantText: "I don't have that file in my workspace.",
    });
    const result = await preRefusalVerifierHook.handler(args, makeCtx([]));
    expect(result).toEqual({ action: "continue" });
  });

  it("only counts tool_calls from the current turn", () => {
    const transcript: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: 1,
        turnId: "turn-0-prev",
        toolUseId: "tu-0",
        name: "Glob",
        input: {},
      },
      {
        kind: "tool_call",
        ts: 2,
        turnId: "turn-1",
        toolUseId: "tu-1",
        name: "FileRead",
        input: {},
      },
      {
        kind: "tool_call",
        ts: 3,
        turnId: "turn-1",
        toolUseId: "tu-2",
        name: "UnrelatedTool",
        input: {},
      },
    ];
    expect(countInvestigationsThisTurn(transcript, "turn-1")).toBe(1);
    expect(countInvestigationsThisTurn(transcript, "turn-0-prev")).toBe(1);
    expect(countInvestigationsThisTurn(transcript, "turn-2-missing")).toBe(0);
  });

  it("no-ops on empty assistantText", async () => {
    const args = makeArgs({ assistantText: "" });
    const result = await preRefusalVerifierHook.handler(args, makeCtx([]));
    expect(result).toEqual({ action: "continue" });
  });
});
