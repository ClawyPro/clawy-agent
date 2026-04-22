/**
 * T2-07 — permission_decision branch on beforeToolUse.
 *
 * Directly exercises HookRegistry.runPre with synthetic hooks so the
 * test doesn't need to stand up Session/Turn. askUser is stubbed per
 * test — resolving, rejecting, or hanging — to cover the approve /
 * deny / ask × (user approves | user declines | timeout) matrix.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry, permissionConfig } from "./HookRegistry.js";
import type { HookContext, HookHandler, RegisteredHook } from "./types.js";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
} from "../Tool.js";
import type { LLMClient } from "../transport/LLMClient.js";
import type { AgentEvent } from "../transport/SseWriter.js";

interface TestCtxHarness {
  ctx: HookContext;
  emitted: AgentEvent[];
  logs: Array<{ level: string; msg: string; data?: object }>;
}

function makeCtx(
  askUser?: (q: AskUserQuestionInput) => Promise<AskUserQuestionOutput>,
): TestCtxHarness {
  const emitted: AgentEvent[] = [];
  const logs: Array<{ level: string; msg: string; data?: object }> = [];
  const ctx: HookContext = {
    botId: "bot-test",
    userId: "user-test",
    sessionKey: "session-test",
    turnId: "turn-test",
    llm: {} as unknown as LLMClient,
    transcript: [],
    emit: (e) => emitted.push(e),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    abortSignal: new AbortController().signal,
    deadlineMs: 5_000,
    ...(askUser ? { askUser } : {}),
  };
  return { ctx, emitted, logs };
}

function hook(
  name: string,
  handler: HookHandler<"beforeToolUse">,
): RegisteredHook<"beforeToolUse"> {
  return {
    name,
    point: "beforeToolUse",
    handler,
    priority: 100,
    blocking: true,
    timeoutMs: 2_000,
  };
}

const baseArgs = { toolName: "FileWrite", toolUseId: "tu-1", input: { a: 1 } };

describe("T2-07 permission_decision", () => {
  it("approve → continue (tool would execute)", async () => {
    const reg = new HookRegistry();
    reg.register(
      hook("approver", async () => ({
        action: "permission_decision",
        decision: "approve",
      })),
    );
    const { ctx } = makeCtx();
    const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
    expect(outcome.action).toBe("continue");
    if (outcome.action === "continue") {
      expect(outcome.args).toEqual(baseArgs);
    }
  });

  it("deny → block with [PERMISSION:DENY]", async () => {
    const reg = new HookRegistry();
    reg.register(
      hook("denier", async () => ({
        action: "permission_decision",
        decision: "deny",
        reason: "FileWrite not allowed here",
      })),
    );
    const { ctx } = makeCtx();
    const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
    expect(outcome.action).toBe("block");
    if (outcome.action === "block") {
      expect(outcome.reason).toContain("[PERMISSION:DENY]");
      expect(outcome.reason).toContain("FileWrite not allowed here");
    }
  });

  it("ask + user approves → continue + rule_check ok emitted", async () => {
    const reg = new HookRegistry();
    reg.register(
      hook("asker", async () => ({
        action: "permission_decision",
        decision: "ask",
        reason: "Proceed with FileWrite?",
      })),
    );
    const askUser = async (
      _input: AskUserQuestionInput,
    ): Promise<AskUserQuestionOutput> => ({ selectedId: "approve" });
    const { ctx, emitted } = makeCtx(askUser);
    const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
    expect(outcome.action).toBe("continue");
    const audit = emitted.find(
      (e) => e.type === "rule_check" && e.ruleId === "permission-decision",
    );
    expect(audit).toBeDefined();
    if (audit && audit.type === "rule_check") {
      expect(audit.verdict).toBe("ok");
      expect(audit.detail).toContain("user_approved");
    }
  });

  it("ask + user declines → block with [PERMISSION:USER_DENIED]", async () => {
    const reg = new HookRegistry();
    reg.register(
      hook("asker", async () => ({
        action: "permission_decision",
        decision: "ask",
      })),
    );
    const askUser = async (): Promise<AskUserQuestionOutput> => ({
      selectedId: "deny",
    });
    const { ctx, emitted } = makeCtx(askUser);
    const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
    expect(outcome.action).toBe("block");
    if (outcome.action === "block") {
      expect(outcome.reason).toContain("[PERMISSION:USER_DENIED]");
    }
    const audit = emitted.find(
      (e) => e.type === "rule_check" && e.ruleId === "permission-decision",
    );
    expect(audit).toBeDefined();
    if (audit && audit.type === "rule_check") {
      expect(audit.verdict).toBe("violation");
    }
  });

  it("ask + askUser times out → block with [PERMISSION:TIMEOUT]", async () => {
    const prev = permissionConfig.askTimeoutMs;
    permissionConfig.askTimeoutMs = 50;
    try {
      const reg = new HookRegistry();
      reg.register(
        hook("asker", async () => ({
          action: "permission_decision",
          decision: "ask",
        })),
      );
      // askUser never resolves — forces the timeout branch.
      const askUser = (): Promise<AskUserQuestionOutput> =>
        new Promise<AskUserQuestionOutput>(() => {
          /* hang */
        });
      const { ctx } = makeCtx(askUser);
      const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
      expect(outcome.action).toBe("block");
      if (outcome.action === "block") {
        expect(outcome.reason).toContain("[PERMISSION:TIMEOUT]");
      }
    } finally {
      permissionConfig.askTimeoutMs = prev;
    }
  });

  it("multiple hooks: first deny halts chain, second never runs", async () => {
    const reg = new HookRegistry();
    let secondRan = false;
    reg.register(
      hook("first-denier", async () => ({
        action: "permission_decision",
        decision: "deny",
        reason: "policy violation",
      })),
    );
    reg.register({
      ...hook("second", async () => {
        secondRan = true;
        return { action: "continue" };
      }),
      priority: 200,
    });
    const { ctx } = makeCtx();
    const outcome = await reg.runPre("beforeToolUse", baseArgs, ctx);
    expect(outcome.action).toBe("block");
    if (outcome.action === "block") {
      expect(outcome.reason).toContain("[PERMISSION:DENY]");
    }
    expect(secondRan).toBe(false);
  });
});
