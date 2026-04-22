/**
 * TypingTicker unit tests — verifies immediate + periodic fires,
 * deterministic stop(), and failure resilience. No real timers /
 * network used; setInterval + clearInterval + adapter.sendTyping
 * are all stubbed for determinism.
 */

import { describe, it, expect, vi } from "vitest";
import { startTypingTicker } from "./TypingTicker.js";

/**
 * Build a fake `setInterval` / `clearInterval` pair whose callback
 * can be manually triggered via `tick()`. Matches the Node global
 * timer contract the ticker depends on.
 */
function makeFakeTimer(): {
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (handle: number | NodeJS.Timeout) => void;
  tick: () => void;
  cleared: boolean;
  intervalMs: number | null;
} {
  let registered: (() => void) | null = null;
  const state = {
    cleared: false,
    intervalMs: null as number | null,
  };
  return {
    setInterval: ((fn: () => void, ms: number) => {
      registered = fn;
      state.intervalMs = ms;
      return 1 as number;
    }) as (fn: () => void, ms: number) => number,
    clearInterval: ((_handle: number | NodeJS.Timeout) => {
      state.cleared = true;
    }) as (handle: number | NodeJS.Timeout) => void,
    tick: (): void => {
      if (registered) registered();
    },
    get cleared() {
      return state.cleared;
    },
    get intervalMs() {
      return state.intervalMs;
    },
  };
}

describe("startTypingTicker", () => {
  it("fires sendTyping immediately and again on every interval tick", async () => {
    const calls: string[] = [];
    const adapter = {
      sendTyping: async (chatId: string) => {
        calls.push(chatId);
      },
    };
    const timer = makeFakeTimer();
    const stop = startTypingTicker({
      adapter,
      chatId: "42",
      intervalMs: 4000,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    // Immediate fire is scheduled via Promise.resolve().then — flush
    // microtasks so we can observe it.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["42"]);
    expect(timer.intervalMs).toBe(4000);

    timer.tick();
    await Promise.resolve();
    await Promise.resolve();
    timer.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["42", "42", "42"]);

    stop();
    expect(timer.cleared).toBe(true);
  });

  it("stop() is idempotent and prevents further sendTyping calls", async () => {
    const calls: string[] = [];
    const adapter = {
      sendTyping: async (chatId: string) => {
        calls.push(chatId);
      },
    };
    const timer = makeFakeTimer();
    const stop = startTypingTicker({
      adapter,
      chatId: "x",
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);

    stop();
    stop(); // second call: must not throw, must not re-clear
    // Even if the timer fires post-stop (race), the internal guard
    // drops the call.
    timer.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);
  });

  it("sendTyping rejections do not propagate (turn must not die)", async () => {
    const adapter = {
      sendTyping: async () => {
        throw new Error("telegram dead");
      },
    };
    const timer = makeFakeTimer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startTypingTicker({
      adapter,
      chatId: "x",
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Subsequent ticks keep firing despite the rejection.
    timer.tick();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });

  it("missing chatId short-circuits without scheduling an interval", async () => {
    let sendCount = 0;
    const adapter = {
      sendTyping: async () => {
        sendCount++;
      },
    };
    const timer = makeFakeTimer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = startTypingTicker({
      adapter,
      chatId: "",
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    await Promise.resolve();
    expect(sendCount).toBe(0);
    expect(timer.intervalMs).toBeNull(); // setInterval never called
    expect(warn).toHaveBeenCalled();
    expect(() => stop()).not.toThrow(); // returned stop() is a no-op
    warn.mockRestore();
  });
});
