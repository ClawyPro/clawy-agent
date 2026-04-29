import { describe, expect, it } from "vitest";
import {
  ExecutionContractStore,
  buildSpawnWorkOrderPrompt,
  classifyExecutionControl,
  completionClaimNeedsContractVerification,
  shouldInjectExecutionContract,
} from "./ExecutionContract.js";

describe("ExecutionContractStore", () => {
  it("extracts task state as a first-class object instead of relying on transcript prose", () => {
    const store = new ExecutionContractStore({ now: () => 123 });

    store.startTurn({
      userMessage: [
        "월간 리포트를 만들어줘.",
        "<task_contract>",
        "<constraints><item>한국어로 작성</item><item>표 포함</item></constraints>",
        "<acceptance_criteria><item>요약 섹션 포함</item><item>xlsx 파일 생성</item></acceptance_criteria>",
        "<verification_mode>full</verification_mode>",
        "</task_contract>",
      ].join("\n"),
    });

    expect(store.snapshot()).toMatchObject({
      taskState: {
        goal: "월간 리포트를 만들어줘.",
        constraints: ["한국어로 작성", "표 포함"],
        acceptanceCriteria: ["요약 섹션 포함", "xlsx 파일 생성"],
        verificationMode: "full",
        currentPlan: [],
        completedSteps: [],
        blockers: [],
      },
    });
  });

  it("records deterministic verification evidence on the contract", () => {
    const store = new ExecutionContractStore({ now: () => 456 });

    store.recordVerificationEvidence({
      source: "beforeCommit",
      command: "npm test",
      status: "passed",
      detail: "12 tests passed",
    });

    expect(store.snapshot().taskState.verificationEvidence).toEqual([
      {
        source: "beforeCommit",
        command: "npm test",
        status: "passed",
        detail: "12 tests passed",
        recordedAt: 456,
      },
    ]);
  });

  it("keeps simple file understanding turns on the light path", () => {
    const store = new ExecutionContractStore({ now: () => 789 });

    store.startTurn({
      userMessage: "WSJ 파이프라인 뭐하는건지 알려줘",
    });

    const snapshot = store.snapshot();
    expect(snapshot.control).toEqual({
      mode: "light",
      reason: "simple_file_understanding",
    });
    expect(shouldInjectExecutionContract(snapshot)).toBe(false);
  });

  it("keeps existing file delivery turns on the light path", () => {
    const store = new ExecutionContractStore({ now: () => 790 });

    store.startTurn({
      userMessage: "여기서 파일로 줘",
    });

    expect(store.snapshot().control).toEqual({
      mode: "light",
      reason: "deliver_existing_file",
    });
  });

  it("uses heavy control for state-changing document generation", () => {
    expect(classifyExecutionControl("리포트를 docx 파일로 만들어줘")).toEqual({
      mode: "heavy",
      reason: "state_changing_or_risky_action",
    });
  });
});

describe("completionClaimNeedsContractVerification", () => {
  it("requires evidence before completion claims when acceptance criteria exist", () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>테스트 통과</item></acceptance_criteria></task_contract>",
    });

    expect(
      completionClaimNeedsContractVerification(
        store.snapshot(),
        "완료했습니다. 테스트도 통과했습니다.",
      ),
    ).toBe(true);

    store.recordVerificationEvidence({
      source: "beforeCommit",
      status: "passed",
      detail: "npm test passed",
    });

    expect(
      completionClaimNeedsContractVerification(
        store.snapshot(),
        "완료했습니다. 테스트도 통과했습니다.",
      ),
    ).toBe(false);
  });

  it("does not carry old acceptance criteria into a later light read/explain turn", () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>테스트 통과</item></acceptance_criteria></task_contract>",
    });
    store.startTurn({
      userMessage: "WSJ 파이프라인 뭐하는건지 알려줘",
    });

    expect(store.snapshot().taskState.acceptanceCriteria).toEqual(["테스트 통과"]);
    expect(store.snapshot().control.mode).toBe("light");
    expect(
      completionClaimNeedsContractVerification(
        store.snapshot(),
        "설명 완료했습니다.",
      ),
    ).toBe(false);
  });
});

describe("buildSpawnWorkOrderPrompt", () => {
  it("wraps child prompts with explicit work order and acceptance criteria", () => {
    const store = new ExecutionContractStore({ now: () => 1 });
    store.startTurn({
      userMessage:
        "<task_contract><acceptance_criteria><item>파일 경로 보고</item></acceptance_criteria></task_contract>",
    });

    const prompt = buildSpawnWorkOrderPrompt({
      parent: store.snapshot(),
      childPrompt: "문서 작성 부분을 맡아줘.",
      persona: "writer",
      allowedTools: ["FileWrite"],
    });

    expect(prompt).toContain("<work_order>");
    expect(prompt).toContain("<acceptance_criteria>");
    expect(prompt).toContain("파일 경로 보고");
    expect(prompt).toContain("문서 작성 부분을 맡아줘.");
    expect(prompt).toContain("Do not modify files outside your assigned scope");
  });
});
