/**
 * Built-in afterTurnEnd stop-condition hook — T3-14 (Port E from OMC).
 *
 * Design reference:
 * - `docs/plans/2026-04-19-core-agent-phase-3-plan.md` §5 / T3-14.
 * - `docs/notes/2026-04-19-omc-self-improve-port-analysis.md` Port E.
 *
 * Evaluates 5 stop conditions against every TaskBoard entry that carries
 * structured `iterationState`. Decisions are made by the runtime — NOT
 * by the model — so a tuning loop can't game its own plateau metric by
 * self-reporting. When a condition fires the hook:
 *   1. Emits a `session_stop` AgentEvent with reason + taskId + round.
 *   2. Writes the same payload as a structured log (audit trail).
 *   3. Patches the task's iterationState so `step = "stopped"`. Future
 *      turns see the terminal state and can short-circuit.
 *
 * Conditions (see `agent.config.yaml → stop_conditions:`):
 *   - user_stop          — a `{workspaceRoot}/.stop-session` sentinel
 *                          file exists (operator / user escape hatch).
 *   - target_met         — lastScore >= target_score (if configured).
 *   - plateau            — last `plateau_window` rounds' score-deltas
 *                          are all below `plateau_threshold`.
 *   - max_iter           — round >= max_iter.
 *   - circuit_breaker    — last N rounds' `step` are all "failed".
 *
 * Precedence (when multiple conditions hold for one task, the FIRST in
 * this order wins — deterministic, documented, single `session_stop`
 * emitted per task per turn):
 *
 *     user_stop > circuit_breaker > max_iter > target_met > plateau
 *
 * The rationale:
 *   - user_stop  : operator override beats everything.
 *   - circuit_breaker: repeated failure beats budget expiry because the
 *     failure diagnosis is more actionable than "out of rounds".
 *   - max_iter   : hard budget beats "we hit target" so a loop that both
 *     converged and burnt its budget reports the budget (safer default
 *     — an explicit budget cap shouldn't be hidden by convergence).
 *   - target_met : success report beats plateau (if we hit the target,
 *     that's the positive outcome).
 *   - plateau    : last resort.
 *
 * ## Score / step history approach
 *
 * Plateau + circuit_breaker need recent-round history. Two options
 * existed:
 *   (a) Re-derive history by scanning the turn transcript or TaskBoard
 *       audit log. Expensive, fragile, couples the hook to transcript
 *       internals.
 *   (b) Keep history INLINE on `iterationState.extra.scoreHistory` +
 *       `iterationState.extra.stepHistory`. Cheap, self-contained,
 *       caller only needs to append when bumping the state.
 *
 * We take (b) — the simpler path. History is stored under
 * `iterationState.extra` (already an open-ended `Record<string,
 * unknown>` — see TaskBoard.IterationState). The hook is tolerant: if
 * history is missing it still evaluates target_met / max_iter /
 * user_stop, and treats the history-requiring conditions as "not
 * enough data yet" (never firing). Length is capped at `plateau_window`
 * + 2 when the hook detects appendable history to avoid unbounded
 * growth. The hook itself never appends history — that's the caller's
 * responsibility (typically the skill or tool bumping iterationState).
 *
 * ## Non-blocking contract
 *
 * The hook NEVER blocks a turn. It's `afterTurnEnd` priority 90 (late)
 * and returns `{ action: "continue" }` in every branch, including on
 * error. Any failure is logged and swallowed. The `session_stop`
 * AgentEvent is informational — downstream consumers decide whether to
 * act (e.g. UI surfaces a "Stopped" badge; the orchestrator chooses to
 * skip future turns for this task).
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

/** Reason taxonomy — kept in sync with the `session_stop` AgentEvent. */
export type StopReason =
  | "user_stop"
  | "circuit_breaker"
  | "max_iter"
  | "target_met"
  | "plateau";

/** Deterministic precedence — earlier entries win ties. */
export const STOP_PRECEDENCE: readonly StopReason[] = [
  "user_stop",
  "circuit_breaker",
  "max_iter",
  "target_met",
  "plateau",
];

/** Terminal step value written onto `iterationState.step` when a stop fires. */
export const STOPPED_STEP = "stopped";

/** Failure step value consulted by the circuit-breaker rule. */
export const FAILED_STEP = "failed";

/** Default sentinel filename relative to workspaceRoot — user_stop signal. */
const USER_STOP_SENTINEL_REL = ".stop-session";

/** Default configuration. Overridden per-bot by `agent.config.yaml`. */
export interface StopConditionsConfig {
  /** Number of recent rounds considered for plateau detection. */
  plateau_window: number;
  /** Minimum |delta| between consecutive scores that counts as progress. */
  plateau_threshold: number;
  /** If set, `lastScore >= target_score` triggers target_met. */
  target_score?: number;
  /** Hard round ceiling per task. */
  max_iter: number;
  /** N consecutive "failed" steps trigger circuit_breaker. */
  circuit_breaker: number;
}

export const DEFAULT_STOP_CONFIG: StopConditionsConfig = {
  plateau_window: 5,
  plateau_threshold: 0.01,
  // 2026-04-20 0.17.1: 50 → 200 for Claude Code parity.
  max_iter: 200,
  circuit_breaker: 3,
};

export interface StopConditionsOptions {
  workspaceRoot: string;
  /** Override the default config loader (used by tests). */
  loadConfig?: (workspaceRoot: string) => Promise<StopConditionsConfig>;
  /** Override the sentinel path resolver (used by tests). */
  sentinelPath?: (workspaceRoot: string) => string;
}

/**
 * Parse `iterationState` off a TaskBoardEntry, defensively.
 * Kept local (mirrors `iterationStateSweeper.parseIterationState`) so
 * this hook stays independent of sweeper internals.
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
  if (
    round === null ||
    step === null ||
    attempts === null ||
    startedAt === null ||
    updatedAt === null
  ) {
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

/** Extract a numeric history array from `state.extra[key]`. Non-numeric entries dropped. */
function extractNumberHistory(state: IterationState, key: string): number[] {
  const extra = state.extra;
  if (!extra || typeof extra !== "object") return [];
  const raw = extra[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** Extract a string history array from `state.extra[key]`. Non-string entries dropped. */
function extractStringHistory(state: IterationState, key: string): string[] {
  const extra = state.extra;
  if (!extra || typeof extra !== "object") return [];
  const raw = extra[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

async function sentinelExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultLoadConfig(
  workspaceRoot: string,
): Promise<StopConditionsConfig> {
  const configPath = path.join(workspaceRoot, "agent.config.yaml");
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { ...DEFAULT_STOP_CONFIG };
  }
  // Lightweight parser — avoids pulling a YAML dep at this layer. The
  // stop_conditions block only contains scalar key:value pairs so a
  // small regex-based parser is enough. The sealedFiles hook uses the
  // `yaml` package; we intentionally avoid it here to keep this hook
  // zero-dep and easier to unit test with plain strings.
  const block = extractStopConditionsBlock(raw);
  if (!block) return { ...DEFAULT_STOP_CONFIG };
  return parseStopConditionsBlock(block);
}

export function extractStopConditionsBlock(yaml: string): string | null {
  const lines = yaml.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^stop_conditions\s*:\s*$/.test(line)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Stop at the next top-level key (zero indent, ends with colon).
    if (/^\S.*:/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

export function parseStopConditionsBlock(block: string): StopConditionsConfig {
  const cfg: StopConditionsConfig = { ...DEFAULT_STOP_CONFIG };
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^#\s][^#]*?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? "";
    const rawVal = (m[2] ?? "").trim();
    const num = Number(rawVal);
    if (!Number.isFinite(num)) continue;
    if (key === "plateau_window") cfg.plateau_window = Math.max(1, Math.floor(num));
    else if (key === "plateau_threshold") cfg.plateau_threshold = Math.max(0, num);
    else if (key === "target_score") cfg.target_score = num;
    else if (key === "max_iter") cfg.max_iter = Math.max(1, Math.floor(num));
    else if (key === "circuit_breaker") cfg.circuit_breaker = Math.max(1, Math.floor(num));
  }
  return cfg;
}

export interface StopEvaluation {
  taskId: string;
  reason: StopReason;
  round: number;
  lastScore?: number;
}

/**
 * Given a single task's iterationState + config + user_stop presence,
 * return the stop reason (if any) honoring STOP_PRECEDENCE. Pure
 * function — no I/O, no side effects — for unit-testability.
 */
export function evaluateStop(
  state: IterationState,
  cfg: StopConditionsConfig,
  userStop: boolean,
): StopReason | null {
  // Precedence order encoded here MUST match STOP_PRECEDENCE.
  if (userStop) return "user_stop";

  // circuit_breaker — look at stepHistory tail.
  const stepHist = extractStringHistory(state, "stepHistory");
  if (stepHist.length >= cfg.circuit_breaker) {
    const tail = stepHist.slice(-cfg.circuit_breaker);
    if (tail.every((s) => s === FAILED_STEP)) return "circuit_breaker";
  }

  // max_iter — current round >= budget.
  if (state.round >= cfg.max_iter) return "max_iter";

  // target_met — only when target_score configured AND lastScore present.
  if (
    typeof cfg.target_score === "number" &&
    typeof state.lastScore === "number" &&
    state.lastScore >= cfg.target_score
  ) {
    return "target_met";
  }

  // plateau — need at least `plateau_window` scored rounds. Compute
  // the deltas between consecutive scores in the tail; plateau means
  // every delta is within threshold.
  const scoreHist = extractNumberHistory(state, "scoreHistory");
  if (scoreHist.length >= cfg.plateau_window) {
    const tail = scoreHist.slice(-cfg.plateau_window);
    let allFlat = true;
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1];
      const b = tail[i];
      if (a === undefined || b === undefined) {
        allFlat = false;
        break;
      }
      if (Math.abs(b - a) >= cfg.plateau_threshold) {
        allFlat = false;
        break;
      }
    }
    if (allFlat) return "plateau";
  }

  return null;
}

export function makeStopConditionsHook(
  opts: StopConditionsOptions,
): RegisteredHook<"afterTurnEnd"> {
  const sessionsDir = path.join(opts.workspaceRoot, "core-agent", "sessions");
  const loadConfig = opts.loadConfig ?? defaultLoadConfig;
  const sentinelPath =
    opts.sentinelPath ??
    ((root: string) => path.join(root, USER_STOP_SENTINEL_REL));

  return {
    name: "builtin:stop-conditions",
    point: "afterTurnEnd",
    priority: 90,
    blocking: false,
    timeoutMs: 3_000,
    handler: async (_args, ctx: HookContext) => {
      try {
        const file = taskFilePath(sessionsDir, ctx.sessionKey);
        const tasks = await readBoard(file);
        if (tasks.length === 0) return;

        // Collect every candidate (task carrying iterationState that
        // isn't already stopped). Tasks in terminal state are skipped
        // to avoid re-firing session_stop every subsequent turn.
        const candidates: Array<{ entry: TaskBoardEntry; state: IterationState }> = [];
        for (const t of tasks) {
          const s = parseIterationState(t);
          if (!s) continue;
          if (s.step === STOPPED_STEP) continue;
          candidates.push({ entry: t, state: s });
        }
        if (candidates.length === 0) return;

        const cfg = await loadConfig(opts.workspaceRoot);
        const userStop = await sentinelExists(sentinelPath(opts.workspaceRoot));

        let anyChange = false;
        const nextTasks: TaskBoardEntry[] = [];
        for (const t of tasks) {
          const hit = candidates.find((c) => c.entry.id === t.id);
          if (!hit) {
            nextTasks.push(t);
            continue;
          }
          const reason = evaluateStop(hit.state, cfg, userStop);
          if (!reason) {
            nextTasks.push(t);
            continue;
          }

          // Emit AgentEvent (single emit per task per turn — the hit
          // is resolved via STOP_PRECEDENCE inside evaluateStop).
          const evtPayload = {
            type: "session_stop" as const,
            taskId: t.id,
            reason,
            round: hit.state.round,
            ...(typeof hit.state.lastScore === "number"
              ? { lastScore: hit.state.lastScore }
              : {}),
          };
          ctx.emit(evtPayload);
          // Structured log — stands in as the audit event.
          ctx.log("info", "[stopConditions] session_stop", {
            taskId: t.id,
            reason,
            round: hit.state.round,
            ...(typeof hit.state.lastScore === "number"
              ? { lastScore: hit.state.lastScore }
              : {}),
          });

          // Patch iterationState → step="stopped", preserving extra.
          const nextState: IterationState = {
            ...hit.state,
            step: STOPPED_STEP,
            updatedAt: Date.now(),
          };
          if (hit.state.extra !== undefined) {
            nextState.extra = { ...hit.state.extra, stoppedReason: reason };
          } else {
            nextState.extra = { stoppedReason: reason };
          }
          const nextMetadata: Record<string, unknown> = {
            ...(t.metadata ?? {}),
            iterationState: nextState,
          };
          nextTasks.push({ ...t, metadata: nextMetadata });
          anyChange = true;
        }

        if (anyChange) {
          await writeBoard(file, nextTasks);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.log("warn", "[stopConditions] failed", { error: msg });
      }
    },
  };
}
