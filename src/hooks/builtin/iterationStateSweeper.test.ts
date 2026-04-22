/**
 * iterationStateSweeper unit tests — T3-13 (Port D).
 *
 * Covers: noop when no in-progress state, stale-detection with audit
 * emission, and error swallowing (sweeper MUST never abort a turn).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeIterationStateSweeperHook } from "./iterationStateSweeper.js";
import {
  readBoard,
  writeBoard,
  taskFilePath,
  type TaskBoardEntry,
  type IterationState,
} from "../../tools/TaskBoard.js";
import type { HookContext } from "../types.js";
import type { LLMClient } from "../../transport/LLMClient.js";
import type { AgentEvent } from "../../transport/SseWriter.js";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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
    turnId: "turn-test",
    llm: {} as unknown as LLMClient,
    transcript: [],
    emit: (e) => emitted.push(e),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    abortSignal: new AbortController().signal,
    deadlineMs: 5_000,
  };
  return { ctx, emitted, logs };
}

function sessionsDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, "core-agent", "sessions");
}

async function seedBoard(
  workspaceRoot: string,
  sessionKey: string,
  tasks: TaskBoardEntry[],
): Promise<string> {
  const sessionsDir = sessionsDirFor(workspaceRoot);
  const file = taskFilePath(sessionsDir, sessionKey);
  await writeBoard(file, tasks);
  return file;
}

describe("iterationStateSweeper hook", () => {
  it("no tasks with iteration state → no-op, no events, no writes", async () => {
    const workspaceRoot = await tmpDir("sweep-noop-");
    const sessionKey = "sess-noop";
    const hook = makeIterationStateSweeperHook({ workspaceRoot });
    const { ctx, emitted, logs } = makeCtx(sessionKey);

    // Case A — no board at all.
    const result = await hook.handler({ userMessage: "hi" }, ctx);
    expect(result).toEqual({ action: "continue" });
    expect(emitted).toEqual([]);
    expect(logs.filter((l) => l.level === "warn")).toEqual([]);

    // Case B — board exists but zero iterationState + zero in-progress.
    const task: TaskBoardEntry = {
      id: "t_plain",
      title: "plain",
      description: "no iteration",
      status: "pending",
      createdAt: Date.now(),
    };
    await seedBoard(workspaceRoot, sessionKey, [task]);

    const result2 = await hook.handler({ userMessage: "hi" }, ctx);
    expect(result2).toEqual({ action: "continue" });
    expect(emitted).toEqual([]);
  });

  it("in-progress task with missing workspaceRef → step=stale + audit event", async () => {
    const workspaceRoot = await tmpDir("sweep-stale-");
    const sessionKey = "sess-stale";

    // Create a REAL file we DON'T reference so we know the resolver
    // is actually doing a stat.
    await fs.writeFile(path.join(workspaceRoot, "exists.md"), "real", "utf8");

    const state: IterationState = {
      round: 3,
      step: "executing",
      attempts: 5,
      startedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      extra: { workspaceRefs: ["src/vanished.md", "exists.md"] },
    };
    const task: TaskBoardEntry = {
      id: "t_in_progress",
      title: "loop",
      description: "a long-running loop",
      status: "in_progress",
      createdAt: Date.now(),
      metadata: { iterationState: state },
    };
    const file = await seedBoard(workspaceRoot, sessionKey, [task]);

    const hook = makeIterationStateSweeperHook({ workspaceRoot });
    const { ctx, emitted, logs } = makeCtx(sessionKey);
    const result = await hook.handler({ userMessage: "go" }, ctx);
    expect(result).toEqual({ action: "continue" });

    // Audit event emitted.
    const stale = emitted.find(
      (e) => e.type === "rule_check" && e.ruleId === "iteration-state-stale",
    );
    expect(stale).toBeDefined();
    expect(stale?.type === "rule_check" ? stale.verdict : null).toBe("violation");
    expect(stale?.type === "rule_check" ? stale.detail ?? "" : "").toContain(
      "prevStep=executing",
    );
    expect(stale?.type === "rule_check" ? stale.detail ?? "" : "").toContain(
      "taskId=t_in_progress",
    );

    // Structured log emitted.
    const logHit = logs.find((l) => l.msg.includes("iteration_state_stale"));
    expect(logHit).toBeDefined();

    // Board now shows step="stale".
    const board = await readBoard(file);
    const entry = board.find((t) => t.id === "t_in_progress");
    expect(entry).toBeDefined();
    const nextState = entry?.metadata?.["iterationState"] as IterationState | undefined;
    expect(nextState?.step).toBe("stale");
    expect(nextState?.round).toBe(3);
    expect(nextState?.attempts).toBe(5);
    // extra is preserved
    expect(nextState?.extra).toEqual({ workspaceRefs: ["src/vanished.md", "exists.md"] });
  });

  it("error during sweep is swallowed (never aborts the turn)", async () => {
    const workspaceRoot = await tmpDir("sweep-err-");
    const sessionKey = "sess-err";

    // Seed a real board, then replace its file contents with garbage
    // so readBoard() throws during the sweep.
    const task: TaskBoardEntry = {
      id: "t_x",
      title: "x",
      description: "x",
      status: "in_progress",
      createdAt: Date.now(),
      metadata: {
        iterationState: {
          round: 1,
          step: "executing",
          attempts: 0,
          startedAt: 1,
          updatedAt: 1,
          extra: { workspaceRefs: ["does-not-exist.md"] },
        },
      },
    };
    const file = await seedBoard(workspaceRoot, sessionKey, [task]);
    // Corrupt the board to force a JSON.parse throw in readBoard.
    await fs.writeFile(file, "{{not json", "utf8");

    const hook = makeIterationStateSweeperHook({ workspaceRoot });
    const { ctx, emitted, logs } = makeCtx(sessionKey);
    const result = await hook.handler({ userMessage: "go" }, ctx);

    // Never blocks.
    expect(result).toEqual({ action: "continue" });

    // Logged as warn, no audit events emitted for staleness.
    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("failed"));
    expect(warn).toBeDefined();
    const stale = emitted.find(
      (e) => e.type === "rule_check" && e.ruleId === "iteration-state-stale",
    );
    expect(stale).toBeUndefined();
  });

  it("in-progress task with all workspaceRefs present → no stale marker", async () => {
    const workspaceRoot = await tmpDir("sweep-alive-");
    const sessionKey = "sess-alive";
    await fs.writeFile(path.join(workspaceRoot, "a.md"), "A", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "b.md"), "B", "utf8");

    const state: IterationState = {
      round: 1,
      step: "executing",
      attempts: 0,
      startedAt: 1,
      updatedAt: 1,
      extra: { workspaceRefs: ["a.md", "b.md"] },
    };
    const task: TaskBoardEntry = {
      id: "t_live",
      title: "live",
      description: "still alive",
      status: "in_progress",
      createdAt: 1,
      metadata: { iterationState: state },
    };
    const file = await seedBoard(workspaceRoot, sessionKey, [task]);

    const hook = makeIterationStateSweeperHook({ workspaceRoot });
    const { ctx, emitted } = makeCtx(sessionKey);
    await hook.handler({ userMessage: "go" }, ctx);

    const board = await readBoard(file);
    const entry = board.find((t) => t.id === "t_live");
    const nextState = entry?.metadata?.["iterationState"] as IterationState | undefined;
    expect(nextState?.step).toBe("executing");
    const stale = emitted.find(
      (e) => e.type === "rule_check" && e.ruleId === "iteration-state-stale",
    );
    expect(stale).toBeUndefined();
  });

  it("hook is registered at point=beforeTurnStart with priority 10 non-blocking", () => {
    const hook = makeIterationStateSweeperHook({ workspaceRoot: "/tmp" });
    expect(hook.name).toBe("builtin:iteration-state-sweeper");
    expect(hook.point).toBe("beforeTurnStart");
    expect(hook.priority).toBe(10);
    expect(hook.blocking).toBe(false);
  });
});
