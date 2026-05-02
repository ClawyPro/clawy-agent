import { describe, expect, it } from "vitest";
import { ExecutionContractStore } from "../../execution/ExecutionContract.js";
import {
  judgeDeterministicEvidence,
  makeDeterministicEvidenceVerifierHook,
  parseDeterministicEvidenceVerdict,
} from "./deterministicEvidenceVerifier.js";
import type { HookContext } from "../types.js";
import type { LLMClient } from "../../transport/LLMClient.js";

function mockLlm(text: string): LLMClient {
  return {
    stream: () =>
      (async function* () {
        yield { kind: "text_delta" as const, delta: text };
        yield { kind: "message_end" as const };
      })(),
  } as unknown as LLMClient;
}

function ctx(store: ExecutionContractStore, llmText = "PASS"): HookContext {
  return {
    botId: "bot",
    userId: "user",
    sessionKey: "session",
    turnId: "turn-1",
    llm: mockLlm(llmText),
    transcript: [],
    emit: () => {},
    log: () => {},
    agentModel: "gpt-5.5",
    abortSignal: new AbortController().signal,
    deadlineMs: 10_000,
    executionContract: store,
  };
}

function addRequirement(store: ExecutionContractStore): string {
  const requirementId = "det_turn-1_1";
  store.recordDeterministicRequirement({
    requirementId,
    turnId: "turn-1",
    source: "llm_classifier",
    status: "active",
    kinds: ["calculation"],
    reason: "Needs exact average.",
    suggestedTools: ["Clock", "DateRange", "Calculation"],
    acceptanceCriteria: ["Use deterministic arithmetic."],
  });
  return requirementId;
}

describe("parseDeterministicEvidenceVerdict", () => {
  it("parses supported verdicts and defaults to pass", () => {
    expect(parseDeterministicEvidenceVerdict("PASS")).toBe("PASS");
    expect(parseDeterministicEvidenceVerdict("MISSING_EVIDENCE")).toBe("MISSING_EVIDENCE");
    expect(parseDeterministicEvidenceVerdict("CONTRADICTS_EVIDENCE")).toBe("CONTRADICTS_EVIDENCE");
    expect(parseDeterministicEvidenceVerdict("UNCLEAR")).toBe("UNCLEAR");
    expect(parseDeterministicEvidenceVerdict("wat")).toBe("PASS");
  });
});

describe("judgeDeterministicEvidence", () => {
  it("uses an LLM judge to compare the draft against structured evidence", async () => {
    const verdict = await judgeDeterministicEvidence({
      llm: mockLlm("CONTRADICTS_EVIDENCE"),
      model: "gpt-5.5",
      userMessage: "평균 알려줘",
      assistantText: "평균은 12입니다.",
      requirements: [],
      evidence: [
        {
          evidenceId: "ev_1",
          requirementIds: ["det_1"],
          toolName: "Calculation",
          kind: "calculation",
          status: "passed",
          inputSummary: "average revenue",
          output: { result: 10 },
          assertions: ["result=10"],
          resources: [],
          recordedAt: 1,
        },
      ],
    });

    expect(verdict).toBe("CONTRADICTS_EVIDENCE");
  });
});

describe("deterministic evidence verifier hook", () => {
  it("blocks final answers for active deterministic requirements without evidence", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({ userMessage: "최근 30일 평균 매출 알려줘" });
    addRequirement(store);
    const hook = makeDeterministicEvidenceVerifierHook();

    const result = await hook.handler(
      {
        assistantText: "최근 30일 평균 매출은 10만원입니다.",
        toolCallCount: 0,
        toolReadHappened: false,
        userMessage: "최근 30일 평균 매출 알려줘",
        retryCount: 0,
      },
      ctx(store),
    );

    expect(result).toMatchObject({ action: "block" });
    expect(result && "reason" in result ? result.reason : "").toContain("Clock");
    expect(result && "reason" in result ? result.reason : "").toContain("Calculation");
  });

  it("allows answers when deterministic evidence exists and the LLM judge passes it", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({ userMessage: "최근 30일 평균 매출 알려줘" });
    const requirementId = addRequirement(store);
    store.recordDeterministicEvidence({
      evidenceId: "det_ev_1",
      requirementIds: [requirementId],
      toolName: "Calculation",
      kind: "calculation",
      status: "passed",
      inputSummary: "average revenue",
      output: { result: 100_000, numericCount: 30 },
      assertions: ["result=100000", "numeric_count=30"],
      resources: ["sales-db"],
    });
    const hook = makeDeterministicEvidenceVerifierHook();

    const result = await hook.handler(
      {
        assistantText: "최근 30일 평균 매출은 100,000원입니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "최근 30일 평균 매출 알려줘",
        retryCount: 0,
      },
      ctx(store, "PASS"),
    );

    expect(result).toEqual({ action: "continue" });
    expect(
      store.snapshot().taskState.deterministicEvidence.some(
        (record) => record.kind === "verification" && record.status === "passed",
      ),
    ).toBe(true);
  });

  it("blocks answers that contradict deterministic evidence", async () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({ userMessage: "최근 30일 평균 매출 알려줘" });
    const requirementId = addRequirement(store);
    store.recordDeterministicEvidence({
      evidenceId: "det_ev_1",
      requirementIds: [requirementId],
      toolName: "Calculation",
      kind: "calculation",
      status: "passed",
      inputSummary: "average revenue",
      output: { result: 100_000, numericCount: 30 },
      assertions: ["result=100000", "numeric_count=30"],
      resources: ["sales-db"],
    });
    const hook = makeDeterministicEvidenceVerifierHook();

    const result = await hook.handler(
      {
        assistantText: "최근 30일 평균 매출은 120,000원입니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "최근 30일 평균 매출 알려줘",
        retryCount: 0,
      },
      ctx(store, "CONTRADICTS_EVIDENCE"),
    );

    expect(result).toMatchObject({ action: "block" });
  });
});
