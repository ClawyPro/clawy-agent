/**
 * Built-in beforeTurnStart sweeper — T3-13 (Port D from OMC).
 *
 * Design reference:
 * - `docs/plans/2026-04-19-core-agent-phase-3-plan.md` §5 / T3-13.
 * - `docs/notes/2026-04-19-omc-self-improve-port-analysis.md` Port D.
 *
 * Long-running loops persist their progress on
 * `TaskBoardEntry.metadata.iterationState` (see `TaskBoard.IterationState`).
 * When a pod restarts mid-loop the iterationState still says
 * `step="executing"` but the physical workspace references it pointed
 * to may no longer exist. This sweeper runs at priority 10 on
 * `beforeTurnStart` — very early, before the LLM sees anything — and
 * reconciles iterationState against filesystem reality.
 *
 * Reconciliation rule:
 * - If the entry has `iterationState.extra.workspaceRefs: string[]`
 *   and ANY of those paths are missing, mark the step as `stale` and
 *   emit a `rule_check` AgentEvent with ruleId=`iteration-state-stale`.
 *   The audit event carries `{ taskId, prevStep }` as structured data
 *   via the `detail` field.
 *
 * Non-blocking / fail-open: any error (board unreadable, path resolve
 * failure, write error) is caught and logged — the sweep NEVER aborts
 * the turn. This mirrors the broader "memory is nice-to-have" pattern
 * used for memoryInjector (T1-01).
 *
 * Scope: sweeps ONLY the current session's board, identified by
 * `ctx.sessionKey`. Cross-session state is out of scope for this hook.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RegisteredHook, HookContext } from "../types.js";
import {
  readBoard,
  writeBoard,
  taskFilePath,
  type TaskBoardEntry,
  type IterationState,
} from "../../tools/TaskBoard.js";

/** Per-entry copy of the iteration state plus bookkeeping for the sweep. */
interface ReadIterationStateResult {
  /** Task id. */
  taskId: string;
  /** Parsed iteration state (never null for entries returned here). */
  state: IterationState;
}

/** Step values that are considered "in progress" and therefore reconcilable. */
const IN_PROGRESS_STEPS: ReadonlySet<string> = new Set([
  "in_progress",
  "executing",
  "running",
  "active",
]);

/** Marker value applied to `iterationState.step` on staleness detection. */
const STALE_MARKER = "stale";

/**
 * Typed reader — mirrors `readIterationStateFromEntry` in TaskBoard.ts
 * but scoped to the sweeper so it remains independent if the helper
 * signature changes.
 */
function parseIterationState(entry: TaskBoardEntry): IterationState | null {
  const meta = entry.metadata;
  if (!meta || typeof meta !== "object") return null;
  const raw = (meta as Record<string, unknown>)["iterationState"];
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const round = typeof obj["round"] === "number" ? (obj["round"] as number) : null;
  const step = typeof obj["step"] === "string" ? (obj["step"] as string) : null;
  const attempts =
    typeof obj["attempts"] === "number" ? (obj["attempts"] as number) : null;
  const startedAt =
    typeof obj["startedAt"] === "number" ? (obj["startedAt"] as number) : null;
  const updatedAt =
    typeof obj["updatedAt"] === "number" ? (obj["updatedAt"] as number) : null;
  if (round === null || step === null || attempts === null || startedAt === null || updatedAt === null) {
    return null;
  }
  const out: IterationState = { round, step, attempts, startedAt, updatedAt };
  if (typeof obj["strategy"] === "string") out.strategy = obj["strategy"] as string;
  if (typeof obj["lastScore"] === "number") out.lastScore = obj["lastScore"] as number;
  if (typeof obj["approachFamily"] === "string") {
    out.approachFamily = obj["approachFamily"] as string;
  }
  if (obj["extra"] && typeof obj["extra"] === "object" && !Array.isArray(obj["extra"])) {
    out.extra = { ...(obj["extra"] as Record<string, unknown>) };
  }
  return out;
}

/**
 * Extract a workspace-ref path list from `state.extra.workspaceRefs` if
 * present. Only string entries are returned — non-strings are silently
 * dropped.
 */
function extractWorkspaceRefs(state: IterationState): string[] {
  const extra = state.extra;
  if (!extra || typeof extra !== "object") return [];
  const raw = extra["workspaceRefs"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Resolve a workspace-ref path against the workspace root. Absolute
 * paths are left alone; relative ones are joined under the workspace.
 */
function resolveRef(workspaceRoot: string | undefined, ref: string): string {
  if (path.isAbsolute(ref)) return ref;
  if (!workspaceRoot) return ref;
  return path.join(workspaceRoot, ref);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface IterationStateSweeperOptions {
  /** Workspace root — used to build the sessions directory path and
   * to resolve relative `workspaceRefs` entries. */
  workspaceRoot: string;
}

/**
 * Find entries whose iterationState step is considered "in progress"
 * and therefore candidates for reconciliation. Returns parsed states
 * inline so callers don't re-parse.
 */
function collectInProgress(
  tasks: readonly TaskBoardEntry[],
): ReadIterationStateResult[] {
  const out: ReadIterationStateResult[] = [];
  for (const t of tasks) {
    const state = parseIterationState(t);
    if (!state) continue;
    if (!IN_PROGRESS_STEPS.has(state.step)) continue;
    out.push({ taskId: t.id, state });
  }
  return out;
}

export function makeIterationStateSweeperHook(
  opts: IterationStateSweeperOptions,
): RegisteredHook<"beforeTurnStart"> {
  const sessionsDir = path.join(opts.workspaceRoot, "core-agent", "sessions");
  return {
    name: "builtin:iteration-state-sweeper",
    point: "beforeTurnStart",
    priority: 10,
    blocking: false,
    timeoutMs: 2_000,
    handler: async (_args, ctx: HookContext) => {
      try {
        const file = taskFilePath(sessionsDir, ctx.sessionKey);
        const tasks = await readBoard(file);
        if (tasks.length === 0) return { action: "continue" };

        const candidates = collectInProgress(tasks);
        if (candidates.length === 0) return { action: "continue" };

        let anyStale = false;
        const updated: TaskBoardEntry[] = [];
        for (const t of tasks) {
          const hit = candidates.find((c) => c.taskId === t.id);
          if (!hit) {
            updated.push(t);
            continue;
          }
          const refs = extractWorkspaceRefs(hit.state);
          // No refs -> nothing to reconcile against -> leave it alone.
          if (refs.length === 0) {
            updated.push(t);
            continue;
          }
          let missing = false;
          for (const ref of refs) {
            const abs = resolveRef(opts.workspaceRoot, ref);
            // eslint-disable-next-line no-await-in-loop
            if (!(await pathExists(abs))) {
              missing = true;
              break;
            }
          }
          if (!missing) {
            updated.push(t);
            continue;
          }

          const prevStep = hit.state.step;
          const nextState: IterationState = {
            ...hit.state,
            step: STALE_MARKER,
            updatedAt: Date.now(),
          };
          const nextMetadata: Record<string, unknown> = {
            ...(t.metadata ?? {}),
            iterationState: nextState,
          };
          updated.push({ ...t, metadata: nextMetadata });
          anyStale = true;

          // Emit audit event + structured log.
          ctx.emit({
            type: "rule_check",
            ruleId: "iteration-state-stale",
            verdict: "violation",
            detail: `taskId=${t.id} prevStep=${prevStep}`,
          });
          ctx.log("warn", "[iterationStateSweeper] iteration_state_stale", {
            taskId: t.id,
            prevStep,
          });
        }

        if (anyStale) {
          await writeBoard(file, updated);
        }
        return { action: "continue" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Best-effort — never abort a turn on sweep failure.
        ctx.log("warn", "[iterationStateSweeper] failed", { error: msg });
        return { action: "continue" };
      }
    },
  };
}
