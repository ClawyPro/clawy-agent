/**
 * ExitPlanMode tool unit tests (Phase 2e).
 */

import { describe, it, expect, vi } from "vitest";
import {
  makeExitPlanModeTool,
  type PlanModeController,
} from "../src/tools/ExitPlanMode.js";
import type { ToolContext } from "../src/Tool.js";

function makeCtx(emitAgentEvent: (e: unknown) => void): ToolContext {
  return {
    botId: "bot-1",
    sessionKey: "agent:main:app:default:1",
    turnId: "turn-1",
    workspaceRoot: "/tmp/ws",
    askUser: async () => ({}),
    emitProgress: () => {},
    emitAgentEvent,
    abortSignal: new AbortController().signal,
    staging: {
      stageFileWrite: () => {},
      stageTranscriptAppend: () => {},
      stageAuditEvent: () => {},
    },
  };
}

describe("ExitPlanMode tool", () => {
  it("rejects empty plan via validate()", () => {
    const tool = makeExitPlanModeTool(() => null);
    expect(tool.validate?.({ plan: "" })).toMatch(/plan/);
    expect(tool.validate?.({ plan: "   " })).toMatch(/plan/);
    expect(tool.validate?.({ plan: "real plan" })).toBeNull();
  });

  it("returns error when no plan-mode controller exists", async () => {
    const tool = makeExitPlanModeTool(() => null);
    const events: unknown[] = [];
    const result = await tool.execute(
      { plan: "1. Do a thing\n2. Do another" },
      makeCtx((e) => events.push(e)),
    );
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("no_controller");
    expect(events).toEqual([]);
  });

  it("errors when invoked outside of plan mode", async () => {
    const submitPlan = vi.fn(async () => ({
      planApproved: false as const,
      planId: "unused",
      requestId: "unused",
      state: "awaiting_approval" as const,
    }));
    const controller: PlanModeController = {
      isPlanMode: () => false,
      submitPlan,
    };
    const tool = makeExitPlanModeTool(() => controller);
    const result = await tool.execute(
      { plan: "just a plan" },
      makeCtx(() => {}),
    );
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("not_in_plan_mode");
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it("submits plan for approval and keeps plan mode active", async () => {
    let flag = true;
    const submitSpy = vi.fn(async (input: { turnId: string; plan: string; emitAgentEvent?: (e: unknown) => void }) => {
      input.emitAgentEvent?.({
        type: "plan_ready",
        planId: "plan-1",
        requestId: "req-1",
        state: "awaiting_approval",
        plan: input.plan,
      });
      return {
        planApproved: false as const,
        planId: "plan-1",
        requestId: "req-1",
        state: "awaiting_approval" as const,
      };
    });
    const controller: PlanModeController = {
      isPlanMode: () => flag,
      submitPlan: submitSpy,
    };
    const tool = makeExitPlanModeTool(() => controller);
    const events: unknown[] = [];
    const result = await tool.execute(
      { plan: "## Plan\n- step A\n- step B" },
      makeCtx((e) => events.push(e)),
    );
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({
      planApproved: false,
      planId: "plan-1",
      requestId: "req-1",
      state: "awaiting_approval",
    });
    expect(submitSpy).toHaveBeenCalledOnce();
    expect(events).toEqual([
      {
        type: "plan_ready",
        planId: "plan-1",
        requestId: "req-1",
        state: "awaiting_approval",
        plan: "## Plan\n- step A\n- step B",
      },
    ]);
    expect(flag).toBe(true);
  });
});
