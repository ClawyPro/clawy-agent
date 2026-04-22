/**
 * Workspace unit tests — focused on agent_rules injection (USER-RULES.md).
 *
 * Covers:
 *   - loadIdentity returns userRules when USER-RULES.md exists
 *   - loadIdentity returns userRules=undefined when file missing or empty
 *   - loadIdentity truncates oversized content at USER_RULES_MAX_CHARS
 *   - renderIdentitySystem appends <agent_rules> block after identity
 *   - renderIdentitySystem omits the block when userRules is empty/absent
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Workspace,
  renderIdentitySystem,
  USER_RULES_MAX_CHARS,
} from "./Workspace.js";

describe("Workspace.loadIdentity — USER-RULES.md", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-rules-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns userRules when USER-RULES.md exists with content", async () => {
    await fs.writeFile(
      path.join(root, "USER-RULES.md"),
      "# User-Defined Agent Rules\n\n- Always reply in Korean\n",
      "utf8",
    );
    const ws = new Workspace(root);
    const id = await ws.loadIdentity();
    expect(id.userRules).toBeDefined();
    expect(id.userRules).toContain("Always reply in Korean");
  });

  it("returns userRules=undefined when the file is missing", async () => {
    const ws = new Workspace(root);
    const id = await ws.loadIdentity();
    expect(id.userRules).toBeUndefined();
  });

  it("returns userRules=undefined when the file is whitespace-only", async () => {
    await fs.writeFile(path.join(root, "USER-RULES.md"), "   \n\n", "utf8");
    const ws = new Workspace(root);
    const id = await ws.loadIdentity();
    expect(id.userRules).toBeUndefined();
  });

  it("truncates content exceeding USER_RULES_MAX_CHARS", async () => {
    const oversized = "x".repeat(USER_RULES_MAX_CHARS + 500);
    await fs.writeFile(path.join(root, "USER-RULES.md"), oversized, "utf8");
    const ws = new Workspace(root);
    const id = await ws.loadIdentity();
    expect(id.userRules).toBeDefined();
    expect(id.userRules?.endsWith("\n[truncated]")).toBe(true);
    // Body chars = MAX; trailing marker adds its own length.
    const body = id.userRules!.slice(0, -"\n[truncated]".length);
    expect(body.length).toBe(USER_RULES_MAX_CHARS);
  });
});

describe("renderIdentitySystem — <agent_rules> block", () => {
  it("appends <agent_rules>…</agent_rules> after identity sections", () => {
    const out = renderIdentitySystem({
      identity: "I am a bot",
      userRules: "- Always reply in Korean",
    });
    expect(out).toContain("# IDENTITY");
    expect(out).toContain("<agent_rules>");
    expect(out).toContain("- Always reply in Korean");
    expect(out).toContain("</agent_rules>");
    // Ordering: <agent_rules> must appear AFTER the identity section.
    const identityIdx = out.indexOf("# IDENTITY");
    const rulesIdx = out.indexOf("<agent_rules>");
    expect(rulesIdx).toBeGreaterThan(identityIdx);
  });

  it("omits the block when userRules is empty", () => {
    const out = renderIdentitySystem({
      identity: "hello",
      userRules: "   ",
    });
    expect(out).not.toContain("<agent_rules>");
  });

  it("omits the block when userRules is undefined", () => {
    const out = renderIdentitySystem({ identity: "hello" });
    expect(out).not.toContain("<agent_rules>");
  });

  it("renders <agent_rules> block on its own when identity is absent", () => {
    const out = renderIdentitySystem({ userRules: "rule 1" });
    expect(out).toContain("<agent_rules>\nrule 1\n</agent_rules>");
  });
});
