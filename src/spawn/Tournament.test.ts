/**
 * Tournament unit tests — pure logic over the tournament core.
 *
 * These tests stub `prepareSpawnDir` + `runChild` + `scoreChild` so we
 * can verify the orchestration (rank / merge / concurrency / cleanup)
 * without any LLM or filesystem wiring. Integration coverage of the
 * full SpawnAgent path lives in `tools/SpawnAgent.test.ts`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Workspace } from "../storage/Workspace.js";
import {
  mergeWinner,
  rankVariants,
  runTournament,
  selectWinnerText,
  type PreparedVariant,
  type TournamentContext,
  type TournamentVariantResult,
} from "./Tournament.js";

function stubCtx(overrides: Partial<TournamentContext> = {}): TournamentContext & {
  events: unknown[];
  audit: Array<{ event: string; data?: Record<string, unknown> }>;
} {
  const events: unknown[] = [];
  const audit: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    workspaceRoot: "/tmp/does-not-matter",
    turnId: "turn_test",
    stageAuditEvent(event, data) {
      audit.push({ event, data });
    },
    emitAgentEvent(evt) {
      events.push(evt);
    },
    events,
    audit,
    ...overrides,
  };
}

async function fakePrepareSpawnDir(
  root: string,
  taskId: string,
): Promise<{ spawnDir: string; spawnWorkspace: Workspace }> {
  const spawnDir = path.join(root, ".spawn", taskId);
  await fs.mkdir(spawnDir, { recursive: true });
  return { spawnDir, spawnWorkspace: new Workspace(spawnDir) };
}

describe("Tournament — pure ranking helpers", () => {
  it("rankVariants sorts by score DESC, ties by variantIndex ASC", () => {
    const variants: TournamentVariantResult[] = [
      { variantIndex: 0, score: 10, finalText: "a", spawnDir: "/a" },
      { variantIndex: 1, score: 30, finalText: "b", spawnDir: "/b" },
      { variantIndex: 2, score: 20, finalText: "c", spawnDir: "/c" },
      { variantIndex: 3, score: 30, finalText: "d", spawnDir: "/d" }, // tie with idx 1
    ];
    const ranked = rankVariants(variants);
    expect(ranked.map((r) => r.variantIndex)).toEqual([1, 3, 2, 0]);
  });

  it("rankVariants is pure — does not mutate input", () => {
    const variants: TournamentVariantResult[] = [
      { variantIndex: 0, score: 10, finalText: "a", spawnDir: "/a" },
      { variantIndex: 1, score: 20, finalText: "b", spawnDir: "/b" },
    ];
    const snapshot = variants.map((v) => v.variantIndex);
    rankVariants(variants);
    expect(variants.map((v) => v.variantIndex)).toEqual(snapshot);
  });

  it("mergeWinner returns first ranked finalText; empty -> ''", () => {
    const ranked: TournamentVariantResult[] = [
      { variantIndex: 2, score: 99, finalText: "winner", spawnDir: "/c" },
      { variantIndex: 0, score: 50, finalText: "runner-up", spawnDir: "/a" },
    ];
    expect(mergeWinner(ranked)).toBe("winner");
    expect(mergeWinner([])).toBe("");
  });

  it("selectWinnerText returns winnerIndex + text in one call", () => {
    const variants: TournamentVariantResult[] = [
      { variantIndex: 0, score: 20, finalText: "zero", spawnDir: "/a" },
      { variantIndex: 1, score: 50, finalText: "one", spawnDir: "/b" },
      { variantIndex: 2, score: 30, finalText: "two", spawnDir: "/c" },
    ];
    expect(selectWinnerText(variants)).toEqual({
      winnerIndex: 1,
      finalText: "one",
    });
    expect(selectWinnerText([])).toEqual({ winnerIndex: -1, finalText: "" });
  });
});

describe("Tournament — runTournament orchestration", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tournament-"));
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("runs 3 variants, scores them, picks highest", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    const result = await runTournament({
      variants: 3,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep: PreparedVariant) {
        return { finalText: `variant-${prep.variantIndex}` };
      },
      async scoreChild(prep) {
        return { score: (prep.variantIndex + 1) * 10 };
      },
    });
    expect(result.mode).toBe("tournament");
    expect(result.winnerIndex).toBe(2);
    expect(result.variants.map((v) => v.score)).toEqual([10, 20, 30]);
    expect(result.variants.map((v) => v.finalText)).toEqual([
      "variant-0",
      "variant-1",
      "variant-2",
    ]);
    // spawn_dirs were created with the expected naming.
    for (const v of result.variants) {
      expect(v.spawnDir).toMatch(/\.spawn\/turn_test\.tournament-\d$/);
      await expect(fs.access(v.spawnDir)).resolves.toBeUndefined();
    }
  });

  it("emits tournament_result event with winnerIndex", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    await runTournament({
      variants: 2,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        return { finalText: `v${prep.variantIndex}` };
      },
      async scoreChild(prep) {
        return { score: prep.variantIndex === 0 ? 5 : 100 };
      },
    });
    const evt = ctx.events.find(
      (e): e is { type: string; winnerIndex: number } =>
        (e as { type?: unknown }).type === "tournament_result",
    );
    expect(evt).toBeDefined();
    expect(evt?.winnerIndex).toBe(1);
  });

  it("scorer warning → stageAuditEvent breadcrumb", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    await runTournament({
      variants: 2,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        return { finalText: `v${prep.variantIndex}` };
      },
      async scoreChild(prep) {
        if (prep.variantIndex === 1) return { score: 0, warning: "bad rubric" };
        return { score: 10 };
      },
    });
    const w = ctx.audit.find((a) => a.event === "tournament_scorer_warning");
    expect(w).toBeDefined();
    expect(w?.data?.variantIndex).toBe(1);
    expect(w?.data?.warning).toBe("bad rubric");
  });

  it("runChild throwing yields 'error: <msg>' finalText (does not abort tournament)", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    const result = await runTournament({
      variants: 2,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        if (prep.variantIndex === 0) throw new Error("boom");
        return { finalText: "ok" };
      },
      async scoreChild() {
        return { score: 0 };
      },
    });
    expect(result.variants[0]!.finalText).toBe("error: boom");
    expect(result.variants[1]!.finalText).toBe("ok");
  });

  it("concurrency=1 yields strict sequential execution", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    const order: string[] = [];
    await runTournament({
      variants: 3,
      concurrency: 1,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        order.push(`start-${prep.variantIndex}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end-${prep.variantIndex}`);
        return { finalText: `v${prep.variantIndex}` };
      },
      async scoreChild() {
        return { score: 1 };
      },
    });
    expect(order).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
    ]);
  });

  it("cleanup_losers=true removes non-winner spawnDirs; winner retained", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    const result = await runTournament({
      variants: 3,
      cleanup_losers: true,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        return { finalText: `v${prep.variantIndex}` };
      },
      async scoreChild(prep) {
        return { score: prep.variantIndex === 1 ? 100 : 10 };
      },
    });
    expect(result.winnerIndex).toBe(1);
    // Winner retained.
    await expect(fs.access(result.variants[1]!.spawnDir)).resolves.toBeUndefined();
    // Losers removed.
    await expect(fs.access(result.variants[0]!.spawnDir)).rejects.toBeDefined();
    await expect(fs.access(result.variants[2]!.spawnDir)).rejects.toBeDefined();
  });

  it("cleanup_losers=false (default) retains all spawnDirs", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    const result = await runTournament({
      variants: 2,
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild(prep) {
        return { finalText: `v${prep.variantIndex}` };
      },
      async scoreChild(prep) {
        return { score: prep.variantIndex };
      },
    });
    for (const v of result.variants) {
      await expect(fs.access(v.spawnDir)).resolves.toBeUndefined();
    }
  });

  it("concurrency is capped at TOURNAMENT_MAX_CONCURRENCY", async () => {
    const ctx = stubCtx({ workspaceRoot: tmpRoot });
    let inflight = 0;
    let peak = 0;
    await runTournament({
      variants: 5,
      concurrency: 999, // should be capped to 5
      ctx,
      prepareSpawnDir: fakePrepareSpawnDir,
      async runChild() {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return { finalText: "x" };
      },
      async scoreChild() {
        return { score: 1 };
      },
    });
    expect(peak).toBeLessThanOrEqual(5);
  });
});
