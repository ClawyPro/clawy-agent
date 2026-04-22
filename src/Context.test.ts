/**
 * Context / multi-context (T4-19 §7.10) — Session-scope tests.
 *
 * Exercises the Context class + Session's contexts map behaviour:
 * default bootstrap, create/list/switch/delete, persistence round-trip
 * via meta index file, and rejection of last-context deletion.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONTEXT_ID,
  loadMetaIndex,
  metaIndexPath,
} from "./Context.js";
import type { Session } from "./Session.js";
import { Session as SessionCtor } from "./Session.js";

function makeAgentStub(sessionsDir: string): {
  sessionsDir: string;
  config: { maxTurnsPerSession: number; maxCostUsdPerSession: number };
  nextTurnId: () => string;
  registerTurn: () => void;
  unregisterTurn: () => void;
} {
  return {
    sessionsDir,
    config: { maxTurnsPerSession: 50, maxCostUsdPerSession: 10 },
    nextTurnId: () => "t_test_0",
    registerTurn: () => { /* no-op stub */ },
    unregisterTurn: () => { /* no-op stub */ },
  };
}

function makeSession(sessionsDir: string, sessionKey: string): Session {
  const agent = makeAgentStub(sessionsDir);
  // Session only reads a subset of Agent — stub is sufficient for these
  // tests. Cast through unknown to satisfy TS since we aren't building
  // a full Agent.
  return new SessionCtor(
    {
      sessionKey,
      botId: "bot-test",
      channel: { type: "app", channelId: "ch" },
      persona: "main",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    },
    agent as unknown as ConstructorParameters<typeof SessionCtor>[1],
  );
}

describe("Context / multi-context", () => {
  let sessionsDir: string;
  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-test-"));
  });
  afterEach(async () => {
    await fs.rm(sessionsDir, { recursive: true, force: true });
  });

  it("bootstraps a default context on construction", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const list = await s.listContexts();
    expect(list).toHaveLength(1);
    expect(list[0]?.contextId).toBe(DEFAULT_CONTEXT_ID);
    expect(list[0]?.archived).toBe(false);
    // Active == default.
    expect(s.getActiveContext().meta.contextId).toBe(DEFAULT_CONTEXT_ID);
  });

  it("createContext registers a new context + persists meta index", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const fresh = await s.createContext({ title: "Research thread" });
    expect(fresh.meta.title).toBe("Research thread");
    expect(fresh.meta.archived).toBe(false);
    const list = await s.listContexts();
    expect(list).toHaveLength(2);
    // Persisted to disk.
    const onDisk = await loadMetaIndex(sessionsDir, "agent:main:app:x:0");
    expect(onDisk).not.toBeNull();
    expect(onDisk?.contexts.map((c) => c.title)).toContain("Research thread");
  });

  it("each context gets its own transcript file", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const other = await s.createContext({ title: "Side chat" });
    const defaultPath = s.getActiveContext().transcript.filePath;
    const otherPath = other.transcript.filePath;
    expect(defaultPath).not.toBe(otherPath);
    expect(defaultPath.endsWith(".jsonl")).toBe(true);
    expect(otherPath.endsWith(`__${other.meta.contextId}.jsonl`)).toBe(true);
  });

  it("switchContext changes the active context", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const other = await s.createContext({ title: "Work B" });
    expect(s.getActiveContext().meta.contextId).toBe(DEFAULT_CONTEXT_ID);
    await s.switchContext(other.meta.contextId);
    expect(s.getActiveContext().meta.contextId).toBe(other.meta.contextId);
    // Session.transcript facade now points at the other context's file.
    expect(s.transcript.filePath).toBe(other.transcript.filePath);
  });

  it("refuses to delete the last non-archived context", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    await expect(s.deleteContext(DEFAULT_CONTEXT_ID)).rejects.toThrow(
      /last non-archived/,
    );
  });

  it("deletes a non-default context and falls back to default on active", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const other = await s.createContext({ title: "Bug tracking" });
    await s.switchContext(other.meta.contextId);
    expect(s.getActiveContext().meta.contextId).toBe(other.meta.contextId);
    await s.deleteContext(other.meta.contextId);
    expect(s.getActiveContext().meta.contextId).toBe(DEFAULT_CONTEXT_ID);
    const list = await s.listContexts();
    expect(list.find((c) => c.contextId === other.meta.contextId)).toBeUndefined();
  });

  it("meta index round-trips across Session re-construction", async () => {
    const sessionKey = "agent:main:app:y:0";
    const s1 = makeSession(sessionsDir, sessionKey);
    await s1.createContext({ title: "Persistent thread" });
    // Re-open.
    const s2 = makeSession(sessionsDir, sessionKey);
    const list = await s2.listContexts();
    expect(list).toHaveLength(2);
    expect(list.some((c) => c.title === "Persistent thread")).toBe(true);
  });

  it("patchContext updates title + archived + systemPromptAddendum", async () => {
    const s = makeSession(sessionsDir, "agent:main:app:x:0");
    const c = await s.createContext({ title: "draft" });
    const updated = await s.patchContext(c.meta.contextId, {
      title: "final",
      archived: true,
      systemPromptAddendum: "Use formal tone.",
    });
    expect(updated.title).toBe("final");
    expect(updated.archived).toBe(true);
    expect(updated.systemPromptAddendum).toBe("Use formal tone.");
    // Meta file reflects.
    const onDisk = await loadMetaIndex(sessionsDir, "agent:main:app:x:0");
    expect(onDisk?.contexts.find((x) => x.contextId === c.meta.contextId)?.archived).toBe(true);
  });

  it("metaIndexPath yields stable filename per sessionKey", () => {
    const p1 = metaIndexPath(sessionsDir, "agent:main:app:x:0");
    const p2 = metaIndexPath(sessionsDir, "agent:main:app:x:0");
    expect(p1).toBe(p2);
    expect(p1.endsWith(".meta.json")).toBe(true);
  });
});
