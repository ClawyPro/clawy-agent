/**
 * Unit tests for the inline task notification beforeLLMCall hook (#81).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildNotificationMessage,
  makeInlineTaskNotifierHook,
  renderNotification,
} from "./inlineTaskNotifier.js";
import type { HookContext } from "../types.js";
import type { LLMMessage } from "../../transport/LLMClient.js";
import type { TaskNotification } from "../../tasks/BackgroundTaskRegistry.js";

function makeCtx(sessionKey: string): HookContext {
  return {
    botId: "bot-test",
    userId: "user-test",
    sessionKey,
    turnId: "turn-1",
    llm: {} as never,
    transcript: [],
    emit: vi.fn(),
    log: vi.fn(),
    abortSignal: new AbortController().signal,
    deadlineMs: 10_000,
  };
}

const baseArgs = {
  messages: [
    { role: "user", content: [{ type: "text", text: "please continue" }] },
  ] as LLMMessage[],
  tools: [],
  system: "you are a bot",
  iteration: 1,
};

function note(overrides: Partial<TaskNotification>): TaskNotification {
  return {
    taskId: overrides.taskId ?? "task-x",
    sessionKey: overrides.sessionKey ?? "s1",
    kind: overrides.kind ?? "spawn",
    summary: overrides.summary ?? "spawn finished",
    ts: overrides.ts ?? 1_000,
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
  };
}

describe("renderNotification", () => {
  it("renders taskId/kind/summary with no output", () => {
    const xml = renderNotification(
      note({ taskId: "t1", kind: "cron", summary: "fired cron" }),
    );
    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("<task-id>t1</task-id>");
    expect(xml).toContain("<kind>cron</kind>");
    expect(xml).toContain("<summary>fired cron</summary>");
    expect(xml).not.toContain("<output>");
    expect(xml).toContain("</task-notification>");
  });

  it("renders output when present", () => {
    const xml = renderNotification(
      note({ taskId: "t2", kind: "agent", output: "hello world" }),
    );
    expect(xml).toContain("<output>hello world</output>");
  });

  it("truncates output longer than 4KB", () => {
    const big = "a".repeat(5 * 1024);
    const xml = renderNotification(note({ output: big }));
    expect(xml).toContain("truncated");
    // Rough length check: the rendered block stays bounded.
    expect(xml.length).toBeLessThan(big.length);
  });
});

describe("buildNotificationMessage", () => {
  it("returns null for empty input", () => {
    expect(buildNotificationMessage([])).toBeNull();
  });

  it("produces a single user-role message with one block per notification", () => {
    const msg = buildNotificationMessage([
      note({ taskId: "a", kind: "spawn" }),
      note({ taskId: "b", kind: "cron" }),
      note({ taskId: "c", kind: "agent" }),
    ]);
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("user");
    const blocks = msg?.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(1);
    const text = blocks[0]?.text ?? "";
    expect(text.match(/<task-notification>/g)?.length).toBe(3);
    expect(text).toContain("<task-id>a</task-id>");
    expect(text).toContain("<task-id>b</task-id>");
    expect(text).toContain("<task-id>c</task-id>");
    expect(text).toContain("<kind>spawn</kind>");
    expect(text).toContain("<kind>cron</kind>");
    expect(text).toContain("<kind>agent</kind>");
  });
});

describe("makeInlineTaskNotifierHook", () => {
  it("declares name, point, priority 4, non-blocking", () => {
    const hook = makeInlineTaskNotifierHook({
      agent: { drainForSession: () => [] },
    });
    expect(hook.name).toBe("builtin:inline-task-notifier");
    expect(hook.point).toBe("beforeLLMCall");
    expect(hook.priority).toBe(4);
    expect(hook.blocking).toBe(false);
  });

  it("continues unchanged when no notifications pending", async () => {
    const hook = makeInlineTaskNotifierHook({
      agent: { drainForSession: () => [] },
    });
    const result = await hook.handler(baseArgs, makeCtx("s1"));
    expect(result).toEqual({ action: "continue" });
  });

  it("appends a single synthetic user message for one notification", async () => {
    const drained: TaskNotification[] = [
      note({ taskId: "t-single", kind: "spawn", output: "ok" }),
    ];
    const hook = makeInlineTaskNotifierHook({
      agent: { drainForSession: () => drained },
    });
    const ctx = makeCtx("s1");
    const result = await hook.handler(baseArgs, ctx);

    expect(result?.action).toBe("replace");
    if (result?.action !== "replace") throw new Error("expected replace");
    expect(result.value.messages).toHaveLength(2); // 1 original + 1 synthetic
    const injected = result.value.messages[1];
    expect(injected?.role).toBe("user");
    const blocks = injected?.content as Array<{ type: string; text: string }>;
    expect(blocks[0]?.text).toContain("<task-id>t-single</task-id>");
    expect(blocks[0]?.text).toContain("<output>ok</output>");
    expect(ctx.log).toHaveBeenCalledWith(
      "info",
      "[inline-task-notifier] injected notifications",
      expect.objectContaining({ count: 1 }),
    );
  });

  it("batches multiple notifications into one synthetic message", async () => {
    const drained: TaskNotification[] = [
      note({ taskId: "n1", kind: "spawn" }),
      note({ taskId: "n2", kind: "cron" }),
      note({ taskId: "n3", kind: "agent" }),
    ];
    const hook = makeInlineTaskNotifierHook({
      agent: { drainForSession: () => drained },
    });
    const result = await hook.handler(baseArgs, makeCtx("s1"));
    expect(result?.action).toBe("replace");
    if (result?.action !== "replace") throw new Error("expected replace");
    expect(result.value.messages).toHaveLength(2); // batched into one
    const blocks = result.value.messages[1]?.content as Array<{
      type: string;
      text: string;
    }>;
    const text = blocks[0]?.text ?? "";
    expect(text.match(/<task-notification>/g)?.length).toBe(3);
  });

  it("drains the queue (agent invoked once per call)", async () => {
    const agent = { drainForSession: vi.fn(() => [note({})]) };
    const hook = makeInlineTaskNotifierHook({ agent });
    await hook.handler(baseArgs, makeCtx("s1"));
    expect(agent.drainForSession).toHaveBeenCalledTimes(1);
    expect(agent.drainForSession).toHaveBeenCalledWith("s1");
  });

  it("supports all three kinds (cron/spawn/agent) without discriminating", async () => {
    for (const kind of ["cron", "spawn", "agent"] as const) {
      const hook = makeInlineTaskNotifierHook({
        agent: { drainForSession: () => [note({ kind, taskId: `t-${kind}` })] },
      });
      const result = await hook.handler(baseArgs, makeCtx("s1"));
      expect(result?.action).toBe("replace");
      if (result?.action !== "replace") throw new Error("expected replace");
      const blocks = result.value.messages[1]?.content as Array<{
        type: string;
        text: string;
      }>;
      expect(blocks[0]?.text).toContain(`<kind>${kind}</kind>`);
    }
  });

  it("fails open when drainForSession throws", async () => {
    const hook = makeInlineTaskNotifierHook({
      agent: {
        drainForSession: () => {
          throw new Error("boom");
        },
      },
    });
    const ctx = makeCtx("s1");
    const result = await hook.handler(baseArgs, ctx);
    expect(result).toEqual({ action: "continue" });
    expect(ctx.log).toHaveBeenCalledWith(
      "warn",
      "[inline-task-notifier] drain failed; turn continues",
      expect.any(Object),
    );
  });
});
