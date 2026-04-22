/**
 * stopConditions unit tests — T3-14 (Port E).
 *
 * Covers:
 *  1. No tasks with iterationState → noop.
 *  2. user_stop sentinel present → stops.
 *  3. lastScore >= target_score → stops.
 *  4. plateau_window rounds below threshold delta → stops.
 *  5. max_iter reached → stops.
 *  6. circuit_breaker: 3 failures in a row → stops.
 *  7. Multiple stop conditions true simultaneously → precedence order
 *     (user_stop > circuit_breaker > max_iter > target_met > plateau),
 *     single session_stop event emitted.
 *
 * Plus a handful of edge-case checks to lock the contract (hook
 * metadata, parseStopConditionsBlock robustness, already-stopped
 * tasks are skipped, atomic write preserves non-matching tasks).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  makeStopConditionsHook,
  evaluateStop,
  extractStopConditionsBlock,
  parseStopConditionsBlock,
  STOP_PRECEDENCE,
  DEFAULT_STOP_CONFIG,
  type StopConditionsConfig,
} from "./stopConditions.js";
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

function withState(
  id: string,
  state: Partial<IterationState>,
): TaskBoardEntry {
  const baseState: IterationState = {
    round: 1,
    step: "executing",
    attempts: 0,
    startedAt: 1,
    updatedAt: 1,
    ...state,
  };
  return {
    id,
    title: id,
    description: id,
    status: "in_progress",
    createdAt: 1,
    metadata: { iterationState: baseState },
  };
}

function cfg(partial: Partial<StopConditionsConfig> = {}): StopConditionsConfig {
  return { ...DEFAULT_STOP_CONFIG, ...partial };
}

async function runHookWith(
  workspaceRoot: string,
  sessionKey: string,
  config: StopConditionsConfig,
  sentinelExists = false,
): Promise<{
  emitted: AgentEvent[];
  logs: Array<{ level: string; msg: string; data?: object }>;
  file: string;
}> {
  const { ctx, emitted, logs } = makeCtx(sessionKey);
  const sentinelPath = () => path.join(workspaceRoot, ".stop-session");
  if (sentinelExists) {
    await fs.writeFile(sentinelPath(), "stop", "utf8");
  }
  const hook = makeStopConditionsHook({
    workspaceRoot,
    loadConfig: async () => config,
    sentinelPath,
  });
  await hook.handler(
    {
      userMessage: "u",
      assistantText: "a",
      status: "committed",
    },
    ctx,
  );
  const file = taskFilePath(sessionsDirFor(workspaceRoot), sessionKey);
  return { emitted, logs, file };
}

describe("stopConditions hook — registration metadata", () => {
  it("registers as afterTurnEnd priority 90 non-blocking", () => {
    const hook = makeStopConditionsHook({ workspaceRoot: "/tmp" });
    expect(hook.name).toBe("builtin:stop-conditions");
    expect(hook.point).toBe("afterTurnEnd");
    expect(hook.priority).toBe(90);
    expect(hook.blocking).toBe(false);
  });

  it("precedence order is user_stop > circuit_breaker > max_iter > target_met > plateau", () => {
    expect(STOP_PRECEDENCE).toEqual([
      "user_stop",
      "circuit_breaker",
      "max_iter",
      "target_met",
      "plateau",
    ]);
  });
});

describe("stopConditions — pure evaluator", () => {
  it("returns null when no condition met", () => {
    const state: IterationState = {
      round: 1,
      step: "executing",
      attempts: 0,
      startedAt: 1,
      updatedAt: 1,
      lastScore: 0.5,
    };
    expect(evaluateStop(state, cfg({ target_score: 0.95 }), false)).toBeNull();
  });

  it("target_met requires target_score configured", () => {
    const state: IterationState = {
      round: 1,
      step: "executing",
      attempts: 0,
      startedAt: 1,
      updatedAt: 1,
      lastScore: 0.99,
    };
    // No target_score in cfg.
    expect(evaluateStop(state, cfg(), false)).toBeNull();
    expect(evaluateStop(state, cfg({ target_score: 0.9 }), false)).toBe("target_met");
  });
});

describe("stopConditions hook — end-to-end", () => {
  it("(1) no tasks with iterationState → no-op, no emits, no writes", async () => {
    const workspaceRoot = await tmpDir("stop-noop-");
    const sessionKey = "sess-noop";
    // Case A: no board at all.
    const run1 = await runHookWith(workspaceRoot, sessionKey, cfg());
    expect(run1.emitted).toEqual([]);

    // Case B: board exists but task has no iterationState.
    const plain: TaskBoardEntry = {
      id: "t_plain",
      title: "plain",
      description: "no iter",
      status: "pending",
      createdAt: 1,
    };
    await seedBoard(workspaceRoot, sessionKey, [plain]);
    const run2 = await runHookWith(workspaceRoot, sessionKey, cfg());
    expect(run2.emitted).toEqual([]);
    // Board unchanged.
    const board = await readBoard(run2.file);
    expect(board).toHaveLength(1);
    expect(board[0]?.metadata).toBeUndefined();
  });

  it("(2) user_stop sentinel present → stops with reason=user_stop", async () => {
    const workspaceRoot = await tmpDir("stop-user-");
    const sessionKey = "sess-user";
    const task = withState("t_a", { round: 2, lastScore: 0.3 });
    await seedBoard(workspaceRoot, sessionKey, [task]);

    const { emitted, file } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg(),
      /* sentinelExists */ true,
    );

    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop).toBeDefined();
    if (stop && stop.type === "session_stop") {
      expect(stop.reason).toBe("user_stop");
      expect(stop.taskId).toBe("t_a");
      expect(stop.round).toBe(2);
      expect(stop.lastScore).toBe(0.3);
    }

    const board = await readBoard(file);
    const state = board[0]?.metadata?.["iterationState"] as IterationState;
    expect(state.step).toBe("stopped");
    expect(state.extra?.["stoppedReason"]).toBe("user_stop");
  });

  it("(3) lastScore >= target_score → stops with reason=target_met", async () => {
    const workspaceRoot = await tmpDir("stop-target-");
    const sessionKey = "sess-target";
    const task = withState("t_t", { round: 4, lastScore: 0.98 });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted, file } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ target_score: 0.95 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "target_met",
    );
    const board = await readBoard(file);
    const state = board[0]?.metadata?.["iterationState"] as IterationState;
    expect(state.step).toBe("stopped");
  });

  it("(4) plateau_window rounds below threshold delta → stops with reason=plateau", async () => {
    const workspaceRoot = await tmpDir("stop-plateau-");
    const sessionKey = "sess-plateau";
    const task = withState("t_p", {
      round: 6,
      lastScore: 0.5,
      extra: {
        scoreHistory: [0.49, 0.495, 0.5, 0.5, 0.5, 0.5],
      },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ plateau_window: 5, plateau_threshold: 0.01 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "plateau",
    );
  });

  it("(4b) plateau NOT reached when delta exceeds threshold", async () => {
    const workspaceRoot = await tmpDir("stop-no-plateau-");
    const sessionKey = "sess-no-plateau";
    const task = withState("t_p2", {
      round: 6,
      lastScore: 0.8,
      extra: {
        scoreHistory: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ plateau_window: 5, plateau_threshold: 0.01 }),
    );
    expect(emitted.filter((e) => e.type === "session_stop")).toEqual([]);
  });

  it("(5) max_iter reached → stops with reason=max_iter", async () => {
    const workspaceRoot = await tmpDir("stop-maxiter-");
    const sessionKey = "sess-maxiter";
    const task = withState("t_m", { round: 50 });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted, file } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ max_iter: 50 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "max_iter",
    );
    const board = await readBoard(file);
    const state = board[0]?.metadata?.["iterationState"] as IterationState;
    expect(state.step).toBe("stopped");
  });

  it("(6) circuit_breaker: 3 consecutive 'failed' steps → stops", async () => {
    const workspaceRoot = await tmpDir("stop-cb-");
    const sessionKey = "sess-cb";
    const task = withState("t_cb", {
      round: 10,
      extra: {
        stepHistory: ["running", "failed", "failed", "failed"],
      },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ circuit_breaker: 3 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "circuit_breaker",
    );
  });

  it("(6b) circuit_breaker NOT reached when failures are non-consecutive", async () => {
    const workspaceRoot = await tmpDir("stop-cb-no-");
    const sessionKey = "sess-cb-no";
    const task = withState("t_cb2", {
      round: 10,
      extra: {
        stepHistory: ["failed", "ok", "failed", "failed"],
      },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ circuit_breaker: 3 }),
    );
    expect(emitted.filter((e) => e.type === "session_stop")).toEqual([]);
  });

  it("(7) multiple conditions true simultaneously → precedence wins, single emit", async () => {
    const workspaceRoot = await tmpDir("stop-multi-");
    const sessionKey = "sess-multi";
    // All five conditions simultaneously true for one task.
    // user_stop: sentinel present (outermost precedence).
    // circuit_breaker: last 3 steps "failed".
    // max_iter: round >= 50.
    // target_met: lastScore >= 0.95.
    // plateau: scoreHistory[-5:] flat.
    const task = withState("t_all", {
      round: 100,
      lastScore: 0.99,
      extra: {
        stepHistory: ["failed", "failed", "failed"],
        scoreHistory: [0.99, 0.99, 0.99, 0.99, 0.99],
      },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({
        target_score: 0.95,
        max_iter: 50,
        circuit_breaker: 3,
        plateau_window: 5,
        plateau_threshold: 0.01,
      }),
      /* sentinelExists */ true,
    );
    const stopEvents = emitted.filter((e) => e.type === "session_stop");
    // Single emit — not five.
    expect(stopEvents).toHaveLength(1);
    const first = stopEvents[0];
    expect(first && first.type === "session_stop" ? first.reason : null).toBe(
      "user_stop",
    );
  });

  it("(7b) precedence — circuit_breaker > max_iter when no user_stop", async () => {
    const workspaceRoot = await tmpDir("stop-multi-cb-");
    const sessionKey = "sess-multi-cb";
    const task = withState("t_cb_mi", {
      round: 200,
      extra: { stepHistory: ["failed", "failed", "failed"] },
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ max_iter: 50, circuit_breaker: 3 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "circuit_breaker",
    );
  });

  it("(7c) precedence — max_iter > target_met when no user_stop / circuit_breaker", async () => {
    const workspaceRoot = await tmpDir("stop-mi-tm-");
    const sessionKey = "sess-mi-tm";
    const task = withState("t_mi_tm", { round: 55, lastScore: 0.99 });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ target_score: 0.95, max_iter: 50 }),
    );
    const stop = emitted.find((e) => e.type === "session_stop");
    expect(stop && stop.type === "session_stop" ? stop.reason : null).toBe(
      "max_iter",
    );
  });

  it("already-stopped tasks are skipped on subsequent turns", async () => {
    const workspaceRoot = await tmpDir("stop-already-");
    const sessionKey = "sess-already";
    const task = withState("t_done", {
      round: 51,
      step: "stopped",
      lastScore: 0.99,
    });
    await seedBoard(workspaceRoot, sessionKey, [task]);
    const { emitted } = await runHookWith(
      workspaceRoot,
      sessionKey,
      cfg({ max_iter: 50, target_score: 0.9 }),
    );
    expect(emitted.filter((e) => e.type === "session_stop")).toEqual([]);
  });

  it("swallows errors (corrupt board) and logs a warn", async () => {
    const workspaceRoot = await tmpDir("stop-err-");
    const sessionKey = "sess-err";
    const task = withState("t_bad", { round: 99 });
    const file = await seedBoard(workspaceRoot, sessionKey, [task]);
    await fs.writeFile(file, "{{not json", "utf8");
    const { ctx, emitted, logs } = makeCtx(sessionKey);
    const hook = makeStopConditionsHook({
      workspaceRoot,
      loadConfig: async () => cfg({ max_iter: 50 }),
      sentinelPath: (r) => path.join(r, ".stop-session"),
    });
    // Should not throw.
    await expect(
      hook.handler(
        { userMessage: "u", assistantText: "a", status: "committed" },
        ctx,
      ),
    ).resolves.toBeUndefined();
    expect(emitted.filter((e) => e.type === "session_stop")).toEqual([]);
    const warn = logs.find((l) => l.level === "warn" && l.msg.includes("failed"));
    expect(warn).toBeDefined();
  });
});

describe("stopConditions — config parsing", () => {
  it("extracts the stop_conditions block from YAML", () => {
    const yaml = [
      "name: test",
      "stop_conditions:",
      "  plateau_window: 7",
      "  plateau_threshold: 0.05",
      "  target_score: 0.9",
      "  max_iter: 25",
      "  circuit_breaker: 2",
      "other_key:",
      "  foo: bar",
    ].join("\n");
    const block = extractStopConditionsBlock(yaml);
    expect(block).not.toBeNull();
    const parsed = parseStopConditionsBlock(block ?? "");
    expect(parsed.plateau_window).toBe(7);
    expect(parsed.plateau_threshold).toBeCloseTo(0.05);
    expect(parsed.target_score).toBeCloseTo(0.9);
    expect(parsed.max_iter).toBe(25);
    expect(parsed.circuit_breaker).toBe(2);
  });

  it("missing stop_conditions block falls back to defaults", () => {
    const parsed = parseStopConditionsBlock("");
    expect(parsed).toEqual(DEFAULT_STOP_CONFIG);
  });
});
