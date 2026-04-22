/**
 * Discipline hook tests — beforeToolUse TDD violation + afterTurnEnd reminder.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookContext } from "../types.js";
import type { LLMClient } from "../../transport/LLMClient.js";
import type { AgentEvent } from "../../transport/SseWriter.js";
import type { Discipline } from "../../Session.js";
import { DEFAULT_DISCIPLINE } from "../../discipline/config.js";
import {
  makeDisciplineBeforeToolUseHook,
  makeDisciplineAfterTurnEndHook,
  type DisciplineAgent,
  type DisciplineSessionCounter,
} from "./disciplineHook.js";

function makeCtx(sessionKey: string): {
  ctx: HookContext;
  emitted: AgentEvent[];
  logs: Array<{ level: string; msg: string; data?: object }>;
} {
  const emitted: AgentEvent[] = [];
  const logs: Array<{ level: string; msg: string; data?: object }> = [];
  const ctx: HookContext = {
    botId: "bot-test",
    userId: "user-test",
    sessionKey,
    turnId: "turn-disc",
    llm: {} as unknown as LLMClient,
    transcript: [],
    emit: (e) => emitted.push(e),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    abortSignal: new AbortController().signal,
    deadlineMs: 5_000,
  };
  return { ctx, emitted, logs };
}

function makeDelegate(
  discipline: Discipline,
  counter: DisciplineSessionCounter,
): DisciplineAgent {
  return {
    getSessionDiscipline: () => discipline,
    getSessionCounter: () => counter,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "disc-hook-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("discipline beforeToolUse", () => {
  it("no-op when discipline is off (requireCommit=off)", async () => {
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      { toolName: "FileWrite", toolUseId: "t1", input: { path: "src/foo.ts" } },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
  });

  it("no-op for non-FileWrite/FileEdit tools", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      requireCommit: "hard",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      { toolName: "Bash", toolUseId: "t1", input: { cmd: "ls" } },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
  });

  it("soft mode — emits violation audit but does not block", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      requireCommit: "soft",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx, emitted } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "FileWrite",
        toolUseId: "t1",
        input: { path: "src/foo.ts", content: "x" },
      },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
    expect(counter.sourceMutations).toBe(1);
    expect(counter.dirtyFilesSinceCommit).toBe(1);
    expect(emitted.some((e) => (e as { detail?: string }).detail?.startsWith("tdd_violation"))).toBe(true);
  });

  it("hard mode — blocks with clear reason when no test exists", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      requireCommit: "hard",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "FileWrite",
        toolUseId: "t1",
        input: { path: "src/foo.ts", content: "x" },
      },
      ctx,
    );
    expect(r).toMatchObject({ action: "block" });
    if (r && r.action === "block") {
      expect(r.reason).toContain("TDD violation");
    }
  });

  it("allows source edit when a matching test file exists", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      requireCommit: "hard",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    await fs.mkdir(path.join(tmp, "src"), { recursive: true });
    await fs.writeFile(path.join(tmp, "src/foo.test.ts"), "test", "utf8");
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "FileWrite",
        toolUseId: "t1",
        input: { path: "src/foo.ts", content: "x" },
      },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
    expect(counter.sourceMutations).toBe(1);
  });

  it("CommitCheckpoint → permission_decision:deny when discipline is off", async () => {
    // Kevin's A/A/A rule #3 — CommitCheckpoint is always registered
    // but the discipline beforeToolUse hook denies the call when the
    // session's discipline is off, surfacing a clean permission_denied
    // at tool_end for observability.
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx, emitted } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "CommitCheckpoint",
        toolUseId: "t1",
        input: { message: "x" },
      },
      ctx,
    );
    expect(r).toMatchObject({
      action: "permission_decision",
      decision: "deny",
    });
    if (r && r.action === "permission_decision") {
      expect(r.reason).toContain("discipline disabled");
    }
    expect(
      emitted.some(
        (e) => (e as { detail?: string }).detail === "discipline disabled",
      ),
    ).toBe(true);
  });

  it("CommitCheckpoint → continue when discipline.git is on", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      git: true,
      requireCommit: "soft",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "CommitCheckpoint",
        toolUseId: "t1",
        input: { message: "x" },
      },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
  });

  it("editing a test file counts as testMutations, not source", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      requireCommit: "hard",
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 0,
      testMutations: 0,
      dirtyFilesSinceCommit: 0,
    };
    const hook = makeDisciplineBeforeToolUseHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx } = makeCtx("s1");
    const r = await hook.handler(
      {
        toolName: "FileWrite",
        toolUseId: "t1",
        input: { path: "src/foo.test.ts", content: "x" },
      },
      ctx,
    );
    expect(r).toEqual({ action: "continue" });
    expect(counter.testMutations).toBe(1);
    expect(counter.sourceMutations).toBe(0);
  });
});

describe("discipline afterTurnEnd reminder", () => {
  it("no reminder below threshold", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      git: true,
      requireCommit: "soft",
      maxChangesBeforeCommit: 10,
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 2,
      testMutations: 0,
      dirtyFilesSinceCommit: 5,
    };
    const hook = makeDisciplineAfterTurnEndHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx, emitted } = makeCtx("s1");
    await hook.handler(
      { userMessage: "hi", assistantText: "ok", status: "committed" },
      ctx,
    );
    expect(emitted).toHaveLength(0);
  });

  it("emits discipline_reminder at threshold", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      git: true,
      requireCommit: "soft",
      maxChangesBeforeCommit: 5,
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 3,
      testMutations: 0,
      dirtyFilesSinceCommit: 7,
    };
    const hook = makeDisciplineAfterTurnEndHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx, emitted } = makeCtx("s1");
    await hook.handler(
      { userMessage: "hi", assistantText: "ok", status: "committed" },
      ctx,
    );
    expect(
      emitted.some((e) =>
        (e as { detail?: string }).detail?.startsWith("discipline_reminder"),
      ),
    ).toBe(true);
  });

  it("no reminder when git is off", async () => {
    const discipline: Discipline = {
      ...DEFAULT_DISCIPLINE,
      tdd: true,
      git: false,
      requireCommit: "soft",
      maxChangesBeforeCommit: 1,
    };
    const counter: DisciplineSessionCounter = {
      sourceMutations: 10,
      testMutations: 0,
      dirtyFilesSinceCommit: 10,
    };
    const hook = makeDisciplineAfterTurnEndHook({
      workspaceRoot: tmp,
      agent: makeDelegate(discipline, counter),
    });
    const { ctx, emitted } = makeCtx("s1");
    await hook.handler(
      { userMessage: "hi", assistantText: "ok", status: "committed" },
      ctx,
    );
    expect(emitted).toHaveLength(0);
  });
});
