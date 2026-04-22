/**
 * deferralBlocker.test — pin the pattern matcher + retry/fail-open
 * semantics. Integration with the full hook chain is covered by the
 * beforeCommit suite; here we exercise the exported helpers directly.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  DEFERRAL_PATTERNS,
  countWorkToolsThisTurn,
  makeDeferralBlockerHook,
  matchesDeferral,
} from "./deferralBlocker.js";

const origEnv = { ...process.env };
afterEach(() => {
  process.env = { ...origEnv };
});

describe("matchesDeferral", () => {
  it("korean: '완료되면 결과 보내드릴게요'", () => {
    expect(matchesDeferral("완료되면 결과 보내드릴게요")).toBe(true);
  });
  it("korean: '결과를 보내드리겠습니다'", () => {
    expect(matchesDeferral("분석 끝나면 결과를 보내드리겠습니다.")).toBe(true);
  });
  it("korean: '5분 후 결과 드릴게요'", () => {
    expect(matchesDeferral("5분 후 결과 드릴게요")).toBe(true);
  });
  it("korean: '잠시만요' / '조금만 기다려'", () => {
    expect(matchesDeferral("잠시만요 기다려주세요")).toBe(true);
    expect(matchesDeferral("조금만 기다려주시면 됩니다")).toBe(true);
  });
  it("english: \"I'll send the results when done\"", () => {
    expect(
      matchesDeferral("I'll send the results when done."),
    ).toBe(true);
  });
  it("english: \"results will be available shortly\"", () => {
    expect(matchesDeferral("Results will be available shortly.")).toBe(true);
  });
  it("english: 'check back'", () => {
    expect(matchesDeferral("Please check back in a few minutes.")).toBe(true);
  });
  it("does NOT fire on plain completed answer", () => {
    expect(
      matchesDeferral("Analysis: 아메리카노 224건, 매출 777,550원."),
    ).toBe(false);
  });
  it("does NOT fire on empty", () => {
    expect(matchesDeferral("")).toBe(false);
  });
});

describe("countWorkToolsThisTurn", () => {
  const mk = (kind: string, turnId: string, name?: string) => ({
    kind,
    turnId,
    name,
  });

  it("counts SpawnAgent + Bash + FileWrite for the current turn", () => {
    const t = [
      mk("tool_call", "t1", "SpawnAgent"),
      mk("tool_call", "t1", "Bash"),
      mk("tool_call", "t1", "FileWrite"),
      mk("tool_call", "t1", "FileRead"), // not a work tool
      mk("tool_call", "t2", "SpawnAgent"), // other turn
    ];
    expect(countWorkToolsThisTurn(t, "t1")).toBe(3);
  });
  it("returns 0 when no entries this turn", () => {
    expect(countWorkToolsThisTurn([], "t1")).toBe(0);
  });
});

describe("deferralBlocker env gate", () => {
  it("off returns continue without matching", () => {
    process.env.CORE_AGENT_DEFERRAL_BLOCKER = "off";
    const hook = makeDeferralBlockerHook();
    const emit = (_e: unknown): void => undefined;
    const log = (_: unknown, __: unknown, ___?: unknown): void => undefined;
    const result = hook.handler(
      { assistantText: "완료되면 결과 보내드릴게요", retryCount: 0 } as unknown as Parameters<
        typeof hook.handler
      >[0],
      {
        turnId: "t1",
        sessionKey: "s",
        emit,
        log,
        transcript: [],
      } as unknown as Parameters<typeof hook.handler>[1],
    );
    return (result as Promise<{ action: string }>).then((r) => {
      expect(r.action).toBe("continue");
    });
  });
});

describe("DEFERRAL_PATTERNS sanity", () => {
  it("has ≥ 8 patterns", () => {
    expect(DEFERRAL_PATTERNS.length).toBeGreaterThanOrEqual(8);
  });
});
