/**
 * Plan-mode constants / header detection (Phase 2e).
 */

import { describe, it, expect } from "vitest";
import { PLAN_MODE_HEADER_RE, PLAN_MODE_ALLOWED_TOOLS } from "../src/Turn.js";

describe("plan mode", () => {
  it("detects [PLAN_MODE: on] header anywhere in the message", () => {
    expect(PLAN_MODE_HEADER_RE.test("[PLAN_MODE: on]\nhello")).toBe(true);
    expect(PLAN_MODE_HEADER_RE.test("hi [plan_mode:on] please think first")).toBe(true);
    expect(PLAN_MODE_HEADER_RE.test("no plan mode here")).toBe(false);
  });

  it("exposes the expected read-only allow-list", () => {
    expect(PLAN_MODE_ALLOWED_TOOLS.has("FileRead")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Glob")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Grep")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("ExitPlanMode")).toBe(true);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("AskUserQuestion")).toBe(true);
    // Writers + shell MUST NOT be in plan mode.
    expect(PLAN_MODE_ALLOWED_TOOLS.has("FileWrite")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("FileEdit")).toBe(false);
    expect(PLAN_MODE_ALLOWED_TOOLS.has("Bash")).toBe(false);
  });
});
