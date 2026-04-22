/**
 * T1-06 — Session budget + costUsd unit tests.
 *
 * Covers:
 *   - computeUsd math for a known model
 *   - computeUsd unknown-model fallback (returns 0)
 *   - Session accumulates over multiple turns
 *   - Budget exceeded by turns (reason=turns)
 *   - Budget exceeded by cost (reason=cost)
 *   - Under-budget happy path
 */

import { describe, it, expect } from "vitest";
import {
  Session,
  DEFAULT_MAX_TURNS_PER_SESSION,
  type SessionMeta,
} from "./Session.js";
import type { Agent, AgentConfig } from "./Agent.js";
import type { TokenUsage } from "./util/types.js";
import {
  computeUsd,
  MODEL_CAPABILITIES,
} from "./llm/modelCapabilities.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): Agent {
  const config: AgentConfig = {
    botId: "bot-test",
    userId: "user-test",
    workspaceRoot: "/tmp/core-agent-test-budget",
    gatewayToken: "test",
    apiProxyUrl: "http://localhost",
    chatProxyUrl: "http://localhost",
    redisUrl: "redis://localhost",
    model: "claude-opus-4-7",
    ...overrides,
  };
  // Minimal stub — Session only reads `.config` + `.sessionsDir` at
  // construction time (for Transcript), so we can avoid instantiating
  // the real Agent (which spins up ToolRegistry + LLMClient + hooks).
  const stub = {
    config,
    sessionsDir: "/tmp/core-agent-test-budget/sessions",
  } as unknown as Agent;
  return stub;
}

function makeSession(agent: Agent): Session {
  const now = Date.now();
  const meta: SessionMeta = {
    sessionKey: "agent:main:app:general:1",
    botId: agent.config.botId,
    channel: { type: "app", channelId: "general" },
    createdAt: now,
    lastActivityAt: now,
  };
  return new Session(meta, agent);
}

function usage(
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): TokenUsage {
  return { inputTokens, outputTokens, costUsd };
}

describe("computeUsd", () => {
  it("computes USD correctly for a known model (Opus 4.7: $15 in / $75 out per Mtok)", () => {
    // 1,000,000 input tokens × $15 = $15
    // 1,000,000 output tokens × $75 = $75
    // Total = $90
    expect(computeUsd("claude-opus-4-7", 1_000_000, 1_000_000)).toBeCloseTo(
      90,
      6,
    );
    // Smaller realistic numbers: 12k in + 3k out
    // = (12000/1e6)*15 + (3000/1e6)*75 = 0.18 + 0.225 = 0.405
    expect(computeUsd("claude-opus-4-7", 12_000, 3_000)).toBeCloseTo(0.405, 6);
  });

  it("returns 0 for unknown model (fail-open)", () => {
    expect(computeUsd("claude-mystery-9", 1_000_000, 1_000_000)).toBe(0);
    expect(computeUsd("", 100, 100)).toBe(0);
  });

  it("capability registry contains the expected model ids", () => {
    expect(MODEL_CAPABILITIES["claude-opus-4-6"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-haiku-4-5-20251001"]).toBeDefined();
  });
});

describe("Session budget", () => {
  it("accumulates usage across multiple turns", () => {
    const session = makeSession(makeAgent());
    session.recordTurnUsage(usage(1_000, 500, 0.05));
    session.recordTurnUsage(usage(2_000, 800, 0.12));
    const stats = session.budgetStats();
    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(3_000);
    expect(stats.outputTokens).toBe(1_300);
    expect(stats.costUsd).toBeCloseTo(0.17, 6);
  });

  it("exceeded=true with reason=turns when cumulativeTurns reaches maxTurns", () => {
    const session = makeSession(makeAgent({ maxTurnsPerSession: 3 }));
    for (let i = 0; i < 3; i++) {
      session.recordTurnUsage(usage(10, 10, 0.0001));
    }
    const result = session.budgetExceeded();
    expect(result.exceeded).toBe(true);
    expect(result.reason).toBe("turns");
  });

  it("cost no longer triggers budget exceeded (api-proxy is the gate)", () => {
    const session = makeSession(
      makeAgent({ maxTurnsPerSession: 100, maxCostUsdPerSession: 1 }),
    );
    session.recordTurnUsage(usage(100, 100, 0.6));
    session.recordTurnUsage(usage(100, 100, 0.6));
    // Cost exceeds maxCostUsd=1, but budget check no longer enforces cost.
    const result = session.budgetExceeded();
    expect(result.exceeded).toBe(false);
  });

  it("under budget → exceeded=false, no reason", () => {
    const session = makeSession(makeAgent());
    session.recordTurnUsage(usage(1_000, 500, 0.01));
    const result = session.budgetExceeded();
    expect(result.exceeded).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("defaults from AgentConfig when unset (1000 turns, Infinity cost)", () => {
    const session = makeSession(makeAgent());
    expect(session.maxTurns).toBe(DEFAULT_MAX_TURNS_PER_SESSION);
    expect(session.maxCostUsd).toBe(Infinity);
  });

  it("uses AgentConfig overrides when provided", () => {
    const session = makeSession(
      makeAgent({ maxTurnsPerSession: 7, maxCostUsdPerSession: 3.5 }),
    );
    expect(session.maxTurns).toBe(7);
    expect(session.maxCostUsd).toBe(3.5);
  });
});
