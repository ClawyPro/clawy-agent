/**
 * Classifier fixture tests — ~20 sample inputs across the three
 * buckets. Inputs are fully synthetic.
 */

import { describe, expect, it } from "vitest";
import {
  classifyTurnMode,
  classifyTurnModeGated,
  hasSkipTddSignal,
} from "./classifier.js";

describe("classifyTurnMode — coding bucket", () => {
  const codingSamples: string[] = [
    "implement a new login handler with proper error handling",
    "fix the bug in src/auth/session.ts where tokens leak",
    "add a test for the retry logic in the fetchWithBackoff helper",
    "refactor the billing module to remove the duplicated state",
    "here's the failing test — ```ts\nexpect(x).toBe(1)\n```",
    "we're doing TDD — write a failing test first please",
    "build a React component that renders the user list",
    "create a Python class for the PDF extractor",
    "let's commit this and open a pull request",
    "fix this typescript error in src/Agent.ts",
  ];
  for (const sample of codingSamples) {
    it(`classifies coding: ${sample.slice(0, 40)}...`, () => {
      const r = classifyTurnMode(sample);
      expect(r.label).toBe("coding");
      expect(r.confidence).toBeGreaterThanOrEqual(0.4);
    });
  }
});

describe("classifyTurnMode — exploratory bucket", () => {
  const exploratorySamples: string[] = [
    "just trying a quick script to see if it works",
    "let me try a proof-of-concept first",
    "prototype something in a scratch file",
    "throwaway code — just experimenting with the API",
  ];
  for (const sample of exploratorySamples) {
    it(`classifies exploratory: ${sample.slice(0, 40)}...`, () => {
      const r = classifyTurnMode(sample);
      expect(r.label).toBe("exploratory");
    });
  }
});

describe("classifyTurnMode — other bucket", () => {
  const otherSamples: string[] = [
    "what is the capital of France?",
    "summarise the meeting notes from yesterday",
    "how does OAuth2 work?",
    "translate this to Korean: hello world",
    "tell me a joke",
    "what's the weather like tomorrow",
  ];
  for (const sample of otherSamples) {
    it(`classifies other: ${sample.slice(0, 40)}...`, () => {
      const r = classifyTurnMode(sample);
      expect(r.label).toBe("other");
    });
  }
});

describe("classifyTurnMode — edges", () => {
  it("empty string → other with confidence 1", () => {
    const r = classifyTurnMode("");
    expect(r.label).toBe("other");
    expect(r.confidence).toBe(1);
  });

  it("coding + exploratory mixed → coding wins (safe default)", () => {
    // "implement" (coding) + "prototype" (exploratory) — should stay coding
    // because we'd rather have TDD on when it might matter.
    const r = classifyTurnMode("implement a prototype login flow");
    expect(r.label).toBe("coding");
  });

  it("strong exploratory with weak coding → exploratory", () => {
    const r = classifyTurnMode(
      "just trying this as a prototype — throwaway experimenting in sandbox",
    );
    expect(r.label).toBe("exploratory");
  });
});

describe("classifyTurnModeGated — 0.6 floor demotes to other", () => {
  it("single weak coding signal → demoted to other", () => {
    // Only the "commit" verb matches; one out of many patterns.
    const r = classifyTurnModeGated("commit this change for me", 0.6);
    // confidence is boosted to ~0.54 for 1 hit / 7 — below 0.6 floor.
    expect(r.label).toBe("other");
  });

  it("strong coding signal → retained", () => {
    const r = classifyTurnModeGated(
      "implement a new React component with a failing test first",
      0.6,
    );
    expect(r.label).toBe("coding");
  });
});

describe("hasSkipTddSignal", () => {
  it("detects explicit skip verbs", () => {
    expect(hasSkipTddSignal("skip TDD this turn")).toBe(true);
    expect(hasSkipTddSignal("just do it without tests, okay?")).toBe(true);
    expect(hasSkipTddSignal("disable discipline for this patch")).toBe(true);
  });
  it("ignores unrelated mentions", () => {
    expect(hasSkipTddSignal("please add tests")).toBe(false);
    expect(hasSkipTddSignal("TDD is great")).toBe(false);
  });
});
