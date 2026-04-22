/**
 * SlashCommandRegistry + matchSlashCommand tests.
 *
 * Covers the matching contract:
 *  - trimmed leading/trailing whitespace
 *  - exact-token match (`/compact` yes, `/compacting` no)
 *  - args preservation across separators
 *  - case sensitivity (lowercase only in v1)
 *  - unknown slash commands return null (caller falls through to LLM)
 *  - alias dispatch
 *  - duplicate registration fails loudly
 */

import { describe, it, expect } from "vitest";
import {
  SlashCommandRegistry,
  matchSlashCommand,
  type SlashCommand,
} from "./registry.js";

function noop(): Promise<void> {
  return Promise.resolve();
}

function makeCmd(name: string, aliases?: string[]): SlashCommand {
  return aliases ? { name, aliases, handler: noop } : { name, handler: noop };
}

describe("SlashCommandRegistry", () => {
  it("registers a command and resolves it by name", () => {
    const r = new SlashCommandRegistry();
    const cmd = makeCmd("/foo");
    r.register(cmd);
    expect(r.resolve("/foo")).toBe(cmd);
  });

  it("resolves a command via alias", () => {
    const r = new SlashCommandRegistry();
    const cmd = makeCmd("/compact", ["/compress"]);
    r.register(cmd);
    expect(r.resolve("/compress")).toBe(cmd);
    expect(r.resolve("/compact")).toBe(cmd);
  });

  it("throws on duplicate name", () => {
    const r = new SlashCommandRegistry();
    r.register(makeCmd("/foo"));
    expect(() => r.register(makeCmd("/foo"))).toThrow(/already registered/);
  });

  it("throws on alias colliding with existing name", () => {
    const r = new SlashCommandRegistry();
    r.register(makeCmd("/foo"));
    expect(() => r.register(makeCmd("/bar", ["/foo"]))).toThrow(
      /already registered/,
    );
  });

  it("lists unique commands (no alias duplication)", () => {
    const r = new SlashCommandRegistry();
    r.register(makeCmd("/compact", ["/compress"]));
    r.register(makeCmd("/status"));
    expect(r.list()).toHaveLength(2);
  });
});

describe("matchSlashCommand", () => {
  const registry = new SlashCommandRegistry();
  registry.register(makeCmd("/compact", ["/compress"]));
  registry.register(makeCmd("/reset"));
  registry.register(makeCmd("/status"));

  it("matches a bare slash command", () => {
    const m = matchSlashCommand("/compact", registry);
    expect(m?.command.name).toBe("/compact");
    expect(m?.args).toBe("");
  });

  it("trims surrounding whitespace before matching", () => {
    const m = matchSlashCommand("  /compact  ", registry);
    expect(m?.command.name).toBe("/compact");
  });

  it("does NOT match a prefix of a registered command", () => {
    // `/compacting` shares a prefix with `/compact` but is not the
    // same token — treat as a normal LLM turn.
    expect(matchSlashCommand("/compacting", registry)).toBeNull();
  });

  it("splits args after the first whitespace", () => {
    const m = matchSlashCommand("/reset yes please", registry);
    expect(m?.command.name).toBe("/reset");
    expect(m?.args).toBe("yes please");
  });

  it("returns null for unknown slash commands (fall-through)", () => {
    expect(matchSlashCommand("/unknown", registry)).toBeNull();
  });

  it("returns null for non-slash text", () => {
    expect(matchSlashCommand("hello world", registry)).toBeNull();
    expect(matchSlashCommand("", registry)).toBeNull();
    expect(matchSlashCommand("   ", registry)).toBeNull();
  });

  it("is case-sensitive (v1 — lowercase only)", () => {
    expect(matchSlashCommand("/COMPACT", registry)).toBeNull();
    expect(matchSlashCommand("/Compact", registry)).toBeNull();
    expect(matchSlashCommand("/compact", registry)).not.toBeNull();
  });

  it("resolves aliases", () => {
    const m = matchSlashCommand("/compress", registry);
    expect(m?.command.name).toBe("/compact");
  });
});
