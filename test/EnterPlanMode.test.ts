import { describe, expect, it, vi } from "vitest";
import {
  makeEnterPlanModeTool,
  type PlanModeEntryController,
} from "../src/tools/EnterPlanMode.js";
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

describe("EnterPlanMode tool", () => {
  it("enters plan mode through the lifecycle controller", async () => {
    const enterPlanMode = vi.fn(async () => ({
      planMode: true as const,
      previousMode: "auto" as const,
      state: "entered" as const,
    }));
    const controller: PlanModeEntryController = { enterPlanMode };
    const tool = makeEnterPlanModeTool(() => controller);
    const events: unknown[] = [];

    const result = await tool.execute({}, makeCtx((event) => events.push(event)));

    expect(result.status).toBe("ok");
    expect(result.output).toEqual({
      planMode: true,
      previousMode: "auto",
      state: "entered",
    });
    expect(enterPlanMode).toHaveBeenCalledWith({ turnId: "turn-1" });
    expect(events).toEqual([
      { type: "plan_lifecycle", state: "entered", previousMode: "auto" },
    ]);
  });

  it("errors when no controller is registered", async () => {
    const tool = makeEnterPlanModeTool(() => null);
    const result = await tool.execute({}, makeCtx(() => {}));
    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("no_controller");
  });
});
