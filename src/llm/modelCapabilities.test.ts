/**
 * T4-17 — Model capability registry tests.
 *
 * Covers:
 *   - getCapability for known + unknown models
 *   - computeUsd math for a known model + unknown-model fallback
 *   - shouldEnableThinkingByDefault for opus (true) + haiku (false)
 *   - MODEL_CAPABILITIES contains the expected ids
 */

import { describe, it, expect } from "vitest";
import {
  MODEL_CAPABILITIES,
  getCapability,
  computeUsd,
  shouldEnableThinkingByDefault,
} from "./modelCapabilities.js";

describe("getCapability", () => {
  it("returns the full record for a known model", () => {
    const cap = getCapability("claude-opus-4-7");
    expect(cap).not.toBeNull();
    expect(cap).toEqual({
      id: "claude-opus-4-7",
      supportsThinking: true,
      maxOutputTokens: 32_000,
      contextWindow: 900_000,
      inputUsdPerMtok: 15,
      outputUsdPerMtok: 75,
    });
  });

  it("returns null for an unknown model", () => {
    expect(getCapability("unknown-model-9")).toBeNull();
  });

  it("contains the expected model ids", () => {
    expect(MODEL_CAPABILITIES["claude-opus-4-7"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-opus-4-6"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-sonnet-4-6"]).toBeDefined();
    expect(MODEL_CAPABILITIES["claude-haiku-4-5-20251001"]).toBeDefined();
  });
});

describe("computeUsd", () => {
  it("computes USD correctly for a known model (Opus 4.7: $15 in / $75 out per Mtok)", () => {
    // 1M in × $15 + 1M out × $75 = $90
    expect(computeUsd("claude-opus-4-7", 1_000_000, 1_000_000)).toBeCloseTo(
      90,
      6,
    );
    // 12k in + 3k out = 0.18 + 0.225 = 0.405
    expect(computeUsd("claude-opus-4-7", 12_000, 3_000)).toBeCloseTo(0.405, 6);
  });

  it("returns 0 for unknown model (fail-open)", () => {
    expect(computeUsd("claude-mystery-9", 1_000_000, 1_000_000)).toBe(0);
    expect(computeUsd("", 100, 100)).toBe(0);
  });

  it("computes USD correctly for Haiku ($1 in / $5 out)", () => {
    // 1M in × $1 + 1M out × $5 = $6
    expect(
      computeUsd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000),
    ).toBeCloseTo(6, 6);
  });
});

describe("shouldEnableThinkingByDefault", () => {
  it("returns true for opus (extended thinking supported)", () => {
    expect(shouldEnableThinkingByDefault("claude-opus-4-7")).toBe(true);
    expect(shouldEnableThinkingByDefault("claude-opus-4-6")).toBe(true);
  });

  it("returns true for sonnet", () => {
    expect(shouldEnableThinkingByDefault("claude-sonnet-4-6")).toBe(true);
  });

  it("returns false for haiku (no extended thinking)", () => {
    expect(shouldEnableThinkingByDefault("claude-haiku-4-5-20251001")).toBe(
      false,
    );
  });

  it("returns false for unknown models (fail-closed on thinking)", () => {
    expect(shouldEnableThinkingByDefault("unknown-model")).toBe(false);
  });
});
