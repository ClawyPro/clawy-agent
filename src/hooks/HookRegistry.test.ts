/**
 * HookRegistry.test — covers the CC P0-1 `if:` filter wired into
 * runPre and runPost. Permission-decision coverage lives in
 * permissionDecision.test.ts.
 */

import { describe, it, expect } from "vitest";
import { HookRegistry } from "./HookRegistry.js";
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

function toolHook(
  name: string,
  handler: HookHandler<"beforeToolUse">,
  ifRule?: string,
): RegisteredHook<"beforeToolUse"> {
  return {
    name,
    point: "beforeToolUse",
    handler,
    priority: 100,
    blocking: true,
    timeoutMs: 1_000,
    ...(ifRule !== undefined ? { if: ifRule } : {}),
  };
}

const bashArgs = {
  toolName: "Bash",
  toolUseId: "tu-1",
  input: { command: "git status" },
};
const writeArgs = {
  toolName: "FileWrite",
  toolUseId: "tu-2",
  input: { file_path: "src/foo.ts", content: "hi" },
};

describe("HookRegistry.runPre with if:", () => {
  it("runs hook when no if: rule set (legacy behaviour)", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register(
      toolHook("legacy", async () => {
        called = true;
        return { action: "continue" };
      }),
    );
    const { ctx } = makeCtx();
    await reg.runPre("beforeToolUse", bashArgs, ctx);
    expect(called).toBe(true);
  });

  it("skips hook when if: does not match toolName", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register(
      toolHook(
        "bash-only",
        async () => {
          called = true;
          return { action: "continue" };
        },
        "Bash",
      ),
    );
    const { ctx } = makeCtx();
    await reg.runPre("beforeToolUse", writeArgs, ctx);
    expect(called).toBe(false);
  });

  it("runs hook when if: matches toolName", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register(
      toolHook(
        "bash-only",
        async () => {
          called = true;
          return { action: "continue" };
        },
        "Bash",
      ),
    );
    const { ctx } = makeCtx();
    await reg.runPre("beforeToolUse", bashArgs, ctx);
    expect(called).toBe(true);
  });

  it("runs hook when if: arg glob matches", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register(
      toolHook(
        "git-ops",
        async () => {
          called = true;
          return { action: "continue" };
        },
        "Bash(git *)",
      ),
    );
    const { ctx } = makeCtx();
    await reg.runPre("beforeToolUse", bashArgs, ctx);
    expect(called).toBe(true);
  });

  it("skips hook when if: arg glob fails", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register(
      toolHook(
        "git-ops",
        async () => {
          called = true;
          return { action: "continue" };
        },
        "Bash(git *)",
      ),
    );
    const { ctx } = makeCtx();
    await reg.runPre(
      "beforeToolUse",
      { toolName: "Bash", toolUseId: "x", input: { command: "rm -rf /" } },
      ctx,
    );
    expect(called).toBe(false);
  });

  it("malformed if: logs warn once and skips hook", async () => {
    const reg = new HookRegistry();
    let called = 0;
    reg.register(
      toolHook(
        "broken",
        async () => {
          called += 1;
          return { action: "continue" };
        },
        "",
      ),
    );
    const { ctx, logs } = makeCtx();
    await reg.runPre("beforeToolUse", bashArgs, ctx);
    await reg.runPre("beforeToolUse", bashArgs, ctx);
    expect(called).toBe(0);
    const warns = logs.filter((l) => l.level === "warn");
    expect(warns.length).toBe(1);
  });

  it("does not invoke askUser when if: filters out a permission hook", async () => {
    const reg = new HookRegistry();
    let asked = 0;
    reg.register(
      toolHook(
        "asker",
        async () => ({
          action: "permission_decision",
          decision: "ask",
          reason: "?",
        }),
        "FileWrite",
      ),
    );
    const askUser = async (): Promise<AskUserQuestionOutput> => {
      asked += 1;
      return { selectedId: "approve" };
    };
    const { ctx } = makeCtx(askUser);
    const outcome = await reg.runPre("beforeToolUse", bashArgs, ctx);
    expect(asked).toBe(0);
    expect(outcome.action).toBe("continue");
  });
});

describe("HookRegistry.runPost with if:", () => {
  it("filters post-hooks by if:", async () => {
    const reg = new HookRegistry();
    let called = false;
    reg.register({
      name: "after-bash-only",
      point: "afterToolUse",
      priority: 100,
      blocking: false,
      timeoutMs: 1_000,
      if: "Bash",
      handler: async () => {
        called = true;
      },
    });
    const { ctx } = makeCtx();
    await reg.runPost(
      "afterToolUse",
      {
        toolName: "FileWrite",
        toolUseId: "x",
        input: {},
        result: { output: "" } as unknown as import("../Tool.js").ToolResult,
      },
      ctx,
    );
    expect(called).toBe(false);
  });
});
