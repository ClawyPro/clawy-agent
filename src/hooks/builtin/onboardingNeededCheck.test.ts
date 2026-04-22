/**
 * Unit tests for the onboarding-needed-check beforeTurnStart hook.
 * Design ref: docs/plans/2026-04-20-superpowers-plugin-design.md design #2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DECLINE_RE,
  ONBOARDING_NUDGE_TEXT,
  isOnboardingSteerEnabled,
  looksLikeDecline,
  makeOnboardingNeededCheckHook,
  shouldSkipNudge,
} from "./onboardingNeededCheck.js";
import type { HookContext } from "../types.js";
import type { Session, SessionMeta } from "../../Session.js";

function makeCtx(sessionKey = "s1"): HookContext {
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

function stubSession(
  overrides: Partial<SessionMeta> = {},
  turns = 0,
): Session {
  const meta: SessionMeta = {
    sessionKey: "s1",
    botId: "bot-test",
    channel: { type: "telegram", channelId: "1" },
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
  return {
    meta,
    budgetStats: () => ({
      turns,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }),
  } as unknown as Session;
}

describe("looksLikeDecline", () => {
  it("matches common declines", () => {
    expect(looksLikeDecline("no")).toBe(true);
    expect(looksLikeDecline("not now")).toBe(true);
    expect(looksLikeDecline("later")).toBe(true);
    expect(looksLikeDecline("skip")).toBe(true);
    expect(looksLikeDecline("나중에")).toBe(true);
    expect(looksLikeDecline("안 할래")).toBe(true);
  });

  it("does not match affirmative text", () => {
    expect(looksLikeDecline("yes please")).toBe(false);
    expect(looksLikeDecline("sure")).toBe(false);
    expect(looksLikeDecline("")).toBe(false);
  });

  it("exposes a regex", () => {
    expect(DECLINE_RE.test("no thanks")).toBe(true);
  });
});

describe("isOnboardingSteerEnabled", () => {
  it("default is on", () => {
    expect(isOnboardingSteerEnabled(undefined)).toBe(true);
  });
  it("explicit off disables", () => {
    expect(isOnboardingSteerEnabled("off")).toBe(false);
  });
});

describe("shouldSkipNudge", () => {
  it("skips when already onboarded", () => {
    expect(shouldSkipNudge(stubSession({ onboarded: true }))).toBe(true);
  });
  it("skips when declines >= 2", () => {
    expect(shouldSkipNudge(stubSession({ onboardingDeclines: 2 }))).toBe(true);
  });
  it("skips when session already has committed turns", () => {
    expect(shouldSkipNudge(stubSession({}, /*turns=*/ 3))).toBe(true);
  });
  it("does NOT skip on a fresh first-turn non-onboarded session", () => {
    expect(shouldSkipNudge(stubSession({}))).toBe(false);
  });
});

describe("makeOnboardingNeededCheckHook", () => {
  const prevEnv = process.env.CORE_AGENT_ONBOARDING_STEER;
  beforeEach(() => {
    delete process.env.CORE_AGENT_ONBOARDING_STEER;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CORE_AGENT_ONBOARDING_STEER;
    else process.env.CORE_AGENT_ONBOARDING_STEER = prevEnv;
  });

  it("declares name, point, priority, non-blocking", () => {
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => undefined },
    });
    expect(hook.name).toBe("builtin:onboarding-needed-check");
    expect(hook.point).toBe("beforeTurnStart");
    expect(hook.priority).toBe(6);
    expect(hook.blocking).toBe(false);
  });

  it("emits onboarding_nudge on a first-turn non-onboarded session", async () => {
    const session = stubSession({});
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => session },
    });
    const ctx = makeCtx();
    const result = await hook.handler(
      { userMessage: "help me plan my day" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(ctx.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "onboarding_nudge",
        text: ONBOARDING_NUDGE_TEXT,
      }),
    );
  });

  it("skips when session.meta.onboarded=true", async () => {
    const session = stubSession({ onboarded: true });
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => session },
    });
    const ctx = makeCtx();
    const result = await hook.handler(
      { userMessage: "help me plan my day" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("skips when declines has reached 2", async () => {
    const session = stubSession({ onboardingDeclines: 2 });
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => session },
    });
    const ctx = makeCtx();
    const result = await hook.handler(
      { userMessage: "another request" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("increments declines counter on decline reply", async () => {
    const session = stubSession({ onboardingDeclines: 1 });
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => session },
    });
    const ctx = makeCtx();
    const result = await hook.handler(
      { userMessage: "not now, later" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(session.meta.onboardingDeclines).toBe(2);
    // A decline message is not a nudge signal.
    expect(ctx.emit).not.toHaveBeenCalled();
  });

  it("skips entirely when env gate is off", async () => {
    process.env.CORE_AGENT_ONBOARDING_STEER = "off";
    const session = stubSession({});
    const hook = makeOnboardingNeededCheckHook({
      agent: { getSession: () => session },
    });
    const ctx = makeCtx();
    const result = await hook.handler(
      { userMessage: "help me plan my day" },
      ctx,
    );
    expect(result).toEqual({ action: "continue" });
    expect(ctx.emit).not.toHaveBeenCalled();
  });
});
