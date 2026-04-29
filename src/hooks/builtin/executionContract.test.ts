import { describe, expect, it } from "vitest";
import { ExecutionContractStore } from "../../execution/ExecutionContract.js";
import {
  makeExecutionContractPromptHook,
  makeExecutionContractVerifierHook,
} from "./executionContract.js";
import type { HookContext } from "../types.js";

function ctxWithStore(store: ExecutionContractStore): HookContext {
  return {
    botId: "bot",
    userId: "user",
    sessionKey: "session",
    turnId: "turn",
    llm: {} as HookContext["llm"],
    transcript: [],
    emit: () => {},
    log: () => {},
    agentModel: "gpt-5.4",
    abortSignal: new AbortController().signal,
    deadlineMs: 1000,
    executionContract: store,
  };
}

describe("executionContract prompt hook", () => {
  it("injects current task state into the first LLM call only", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>파일 생성</item></acceptance_criteria></task_contract>",
    });
    const hook = makeExecutionContractPromptHook();

    const out = await hook.handler(
      { messages: [], tools: [], system: "base", iteration: 0 },
      ctxWithStore(store),
    );

    expect(out).toMatchObject({ action: "replace" });
    expect(out && "value" in out ? out.value.system : "").toContain(
      "<execution_contract",
    );
    expect(out && "value" in out ? out.value.system : "").toContain("파일 생성");

    const skipped = await hook.handler(
      { messages: [], tools: [], system: "base", iteration: 1 },
      ctxWithStore(store),
    );
    expect(skipped).toEqual({ action: "continue" });
  });

  it("does not inject contract state for simple file understanding turns", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage: "WSJ 파이프라인 뭐하는건지 알려줘",
    });
    const hook = makeExecutionContractPromptHook();

    const out = await hook.handler(
      { messages: [], tools: [], system: "base", iteration: 0 },
      ctxWithStore(store),
    );

    expect(out).toEqual({ action: "continue" });
  });
});

describe("executionContract verifier hook", () => {
  it("blocks completion claims until contract verification evidence exists", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>테스트 통과</item></acceptance_criteria></task_contract>",
    });
    const hook = makeExecutionContractVerifierHook();

    const blocked = await hook.handler(
      {
        assistantText: "완료했습니다. 테스트도 통과했습니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "작업해줘",
        retryCount: 0,
      },
      ctxWithStore(store),
    );

    expect(blocked).toMatchObject({ action: "block" });

    store.recordVerificationEvidence({
      source: "beforeCommit",
      status: "passed",
      detail: "npm test passed",
    });
    const allowed = await hook.handler(
      {
        assistantText: "완료했습니다. 테스트도 통과했습니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "작업해줘",
        retryCount: 0,
      },
      ctxWithStore(store),
    );

    expect(allowed).toEqual({ action: "continue" });
  });

  it("does not block a later light read/explain turn because of an older contract", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>테스트 통과</item></acceptance_criteria></task_contract>",
    });
    store.startTurn({
      userMessage: "WSJ 파이프라인 뭐하는건지 알려줘",
    });
    const hook = makeExecutionContractVerifierHook();

    const allowed = await hook.handler(
      {
        assistantText: "내용 설명 완료했습니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "WSJ 파이프라인 뭐하는건지 알려줘",
        retryCount: 0,
      },
      ctxWithStore(store),
    );

    expect(allowed).toEqual({ action: "continue" });
  });
});
