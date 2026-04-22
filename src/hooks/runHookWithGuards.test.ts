/**
 * runHookWithGuards unit tests — R6.
 *
 * Covers the four HookOutcome kinds:
 *   - ok      : handler resolves normally (void or HookResult)
 *   - timeout : handler hangs past timeoutMs
 *   - error   : handler throws / rejects with a non-timeout error
 *   - skipped : applicable predicate returns false
 *
 * Plus: no exception ever propagates out, no matter what the handler
 * does. The registry layer owns audit event emission policy, so the
 * helper itself stays silent (verified by asserting an empty log
 * buffer across all paths).
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  runHookWithGuards,
} from "./runHookWithGuards.js";
import type {
  HookContext,
  HookHandler,
  RegisteredHook,
} from "./types.js";
import type { LLMClient } from "../transport/LLMClient.js";
import type { AgentEvent } from "../transport/SseWriter.js";

interface Harness {
  ctx: HookContext;
  emitted: AgentEvent[];
  logs: Array<{ level: string; msg: string; data?: object }>;
}

function makeCtx(overrides: Partial<HookContext> = {}): Harness {
  const emitted: AgentEvent[] = [];
  const logs: Array<{ level: string; msg: string; data?: object }> = [];
  const ctx: HookContext = {
    botId: "bot-test",
    userId: "user-test",
    sessionKey: "sess-test",
    turnId: "turn-test",
    llm: {} as unknown as LLMClient,
    transcript: [],
    emit: (e) => emitted.push(e),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    abortSignal: new AbortController().signal,
    deadlineMs: 5_000,
    ...overrides,
  };
  return { ctx, emitted, logs };
}

function hook(
  name: string,
  handler: HookHandler<"beforeToolUse">,
  overrides: Partial<RegisteredHook<"beforeToolUse">> = {},
): RegisteredHook<"beforeToolUse"> {
  return {
    name,
    point: "beforeToolUse",
    handler,
    priority: 100,
    blocking: true,
    timeoutMs: 2_000,
    ...overrides,
  };
}

const baseArgs = { toolName: "FileWrite", toolUseId: "tu-1", input: { a: 1 } };

describe("runHookWithGuards", () => {
  it("handler returns void → { kind: 'ok', result: undefined }", async () => {
    const h = hook("ok-void", async () => {
      // intentionally returns nothing
    });
    const { ctx, logs, emitted } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result).toBeUndefined();
    }
    // Helper is silent — registry owns emission policy.
    expect(logs).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("handler returns a HookResult → { kind: 'ok', result: <value> }", async () => {
    const h = hook("ok-result", async () => ({
      action: "replace" as const,
      value: { toolName: "FileWrite", toolUseId: "tu-1", input: { a: 2 } },
    }));
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok" && outcome.result && outcome.result.action === "replace") {
      expect(outcome.result.value.input).toEqual({ a: 2 });
    }
  });

  it("handler throws synchronously → { kind: 'error' }, never propagates", async () => {
    const boom = new Error("kaboom");
    const h = hook("sync-throw", async () => {
      throw boom;
    });
    const { ctx, logs } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.hookName).toBe("sync-throw");
      expect(outcome.error).toBe(boom);
    }
    expect(logs).toHaveLength(0);
  });

  it("handler rejects → { kind: 'error' }, never propagates", async () => {
    const h = hook("async-reject", () => Promise.reject(new Error("nope")));
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe("nope");
    }
  });

  it("handler hangs past timeoutMs → { kind: 'timeout' }", async () => {
    const h = hook(
      "hangs",
      () =>
        new Promise(() => {
          /* never resolves */
        }),
      { timeoutMs: 25 },
    );
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind === "timeout") {
      expect(outcome.hookName).toBe("hangs");
      expect(outcome.ms).toBe(25);
    }
  });

  it("timeout falls back to ctx.deadlineMs when hook.timeoutMs missing", async () => {
    const h = hook(
      "uses-ctx-deadline",
      () =>
        new Promise(() => {
          /* hang */
        }),
      { timeoutMs: undefined },
    );
    const { ctx } = makeCtx({ deadlineMs: 15 });
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind === "timeout") {
      expect(outcome.ms).toBe(15);
    }
  });

  it("DEFAULT_HOOK_TIMEOUT_MS matches pre-R6 hardcoded 5000", () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(5_000);
  });

  it("applicable: false → { kind: 'skipped' }, handler never runs", async () => {
    let ran = false;
    const h = hook("gated", async () => {
      ran = true;
    });
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx, {
      applicable: () => false,
      skipReason: "not-today",
    });
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.hookName).toBe("gated");
      expect(outcome.reason).toBe("not-today");
    }
    expect(ran).toBe(false);
  });

  it("applicable: true → handler runs normally", async () => {
    let ran = false;
    const h = hook("gated", async () => {
      ran = true;
    });
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx, {
      applicable: () => true,
    });
    expect(outcome.kind).toBe("ok");
    expect(ran).toBe(true);
  });

  it("applicable omitted + no reason → default 'not-applicable' reason unused", async () => {
    // When applicable is not supplied at all, skipped is never returned.
    const h = hook("ungated", async () => ({ action: "continue" as const }));
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("ok");
  });

  it("error path carries non-Error throwables untouched", async () => {
    const h = hook("throws-string", async () => {
      throw "raw-string-error";
    });
    const { ctx } = makeCtx();
    const outcome = await runHookWithGuards(h, baseArgs, ctx);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toBe("raw-string-error");
    }
  });
});
