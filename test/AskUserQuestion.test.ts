/**
 * AskUserQuestion tool unit tests (Phase 2e).
 */

import { describe, it, expect, vi } from "vitest";
import { makeAskUserQuestionTool } from "../src/tools/AskUserQuestion.js";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ToolContext,
} from "../src/Tool.js";

function makeCtx(
  askUserImpl: (q: AskUserQuestionInput) => Promise<AskUserQuestionOutput>,
  abortSignal?: AbortSignal,
): ToolContext {
  return {
    botId: "bot-1",
    sessionKey: "agent:main:app:default:1",
    turnId: "turn-1",
    workspaceRoot: "/tmp/ws",
    askUser: askUserImpl,
    emitProgress: () => {},
    emitAgentEvent: vi.fn(),
    abortSignal: abortSignal ?? new AbortController().signal,
    staging: {
      stageFileWrite: () => {},
      stageTranscriptAppend: () => {},
      stageAuditEvent: () => {},
    },
  };
}

describe("AskUserQuestion tool", () => {
  it("rejects input with no choices at validate()", () => {
    const tool = makeAskUserQuestionTool();
    const v = tool.validate?.({ question: "pick one", choices: [] });
    expect(typeof v).toBe("string");
  });

  it("rejects duplicate choice ids", () => {
    const tool = makeAskUserQuestionTool();
    const v = tool.validate?.({
      question: "pick",
      choices: [
        { id: "a", label: "A" },
        { id: "a", label: "AA" },
      ],
    });
    expect(v).toMatch(/duplicate/);
  });

  it("returns ok with the user's selected choice", async () => {
    const tool = makeAskUserQuestionTool();
    const ctx = makeCtx(async () => ({ selectedId: "yes" }));
    const result = await tool.execute(
      {
        question: "Proceed?",
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ selectedId: "yes" });
  });

  it("passes through freeText", async () => {
    const tool = makeAskUserQuestionTool();
    const ctx = makeCtx(async () => ({ freeText: "custom answer" }));
    const result = await tool.execute(
      {
        question: "Why?",
        choices: [{ id: "a", label: "A" }],
        allowFreeText: true,
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ freeText: "custom answer" });
  });

  it("aborts with status:aborted on timeout", async () => {
    const tool = makeAskUserQuestionTool({ timeoutMs: 20 });
    const ctx = makeCtx(() => new Promise(() => {}));
    const result = await tool.execute(
      {
        question: "hang forever",
        choices: [{ id: "x", label: "X" }],
      },
      ctx,
    );
    expect(result.status).toBe("aborted");
    expect(result.errorCode).toBe("ask_user_timeout");
  });

  it("aborts when the turn's abortSignal fires", async () => {
    const tool = makeAskUserQuestionTool({ timeoutMs: 10_000 });
    const ac = new AbortController();
    const ctx = makeCtx(() => new Promise(() => {}), ac.signal);
    const pending = tool.execute(
      { question: "q", choices: [{ id: "x", label: "X" }] },
      ctx,
    );
    ac.abort();
    const result = await pending;
    expect(result.status).toBe("aborted");
    expect(result.errorCode).toBe("ask_user_aborted");
  });
});
