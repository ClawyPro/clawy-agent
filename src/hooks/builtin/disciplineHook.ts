/**
 * Built-in Discipline hooks (docs/plans/2026-04-20-coding-discipline-design.md).
 *
 * Two hooks fire under one toggle:
 *   - `beforeToolUse` — for FileWrite/FileEdit on source-pattern files,
 *     check whether a sibling test file exists. Emit `tdd_violation`
 *     audit event when it doesn't; hard-block when
 *     `requireCommit === "hard"`.
 *   - `afterTurnEnd` — count files mutated on disk so the next turn's
 *     discipline block can surface the number. Emits
 *     `discipline_reminder` when the count ≥ maxChangesBeforeCommit.
 *
 * Session access: the hook ctx exposes sessionKey only, so the Agent
 * passes a delegate (mirroring the autoApproval pattern) that can
 * look up the live Session.meta.discipline + a session-scoped counter
 * of file mutations observed this session.
 *
 * Fail-open: any error inside the hook (filesystem, delegate returns
 * null for an unknown session) results in `{ action: "continue" }` —
 * discipline is an observational layer, it must never abort the turn.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RegisteredHook, HookContext } from "../types.js";
import type { Discipline } from "../../Session.js";
import { matchesAny, expectedTestPaths } from "../../discipline/globMatch.js";

/**
 * Per-session observation counters — keyed by sessionKey. Accumulated
 * across turns within the same session so the afterTurnEnd reminder
 * + discipline prompt block can show "source files modified this
 * session: N".
 */
export interface DisciplineSessionCounter {
  sourceMutations: number;
  testMutations: number;
  /** Epoch ms of the most recent observed commit (if any). */
  lastCommitAt?: number;
  /** Files mutated since lastCommitAt (or session start). */
  dirtyFilesSinceCommit: number;
}

/**
 * Delegate wired by Agent.start so the hook can reach the live
 * Session.meta.discipline and a session-scoped mutation counter.
 */
export interface DisciplineAgent {
  /** Returns the Discipline block for the session, or null if unknown. */
  getSessionDiscipline(sessionKey: string): Discipline | null;
  /** Returns (and lazily creates) the session mutation counter. */
  getSessionCounter(sessionKey: string): DisciplineSessionCounter;
}

export interface DisciplineHookOptions {
  workspaceRoot: string;
  agent: DisciplineAgent;
}

/**
 * Shared guard — returns the Discipline block iff discipline is
 * active (tdd OR git) and enforcement is above "off". Null means "do
 * nothing this hook invocation".
 */
function activeDisciplineFor(
  sessionKey: string,
  agent: DisciplineAgent,
): Discipline | null {
  const d = agent.getSessionDiscipline(sessionKey);
  if (!d) return null;
  if (d.requireCommit === "off") return null;
  if (!d.tdd && !d.git) return null;
  return d;
}

/**
 * beforeToolUse — TDD violation detector for FileWrite / FileEdit.
 */
export function makeDisciplineBeforeToolUseHook(
  opts: DisciplineHookOptions,
): RegisteredHook<"beforeToolUse"> {
  return {
    name: "builtin:discipline-beforeToolUse",
    point: "beforeToolUse",
    priority: 45, // after auto-approval (30), before generic user hooks (100)
    blocking: true,
    timeoutMs: 500,
    handler: async ({ toolName, input }, ctx: HookContext) => {
      // Kevin's A/A/A rule #3 — CommitCheckpoint stays registered
      // unconditionally, but when the session's discipline block is
      // OFF we deny here so tool_end surfaces a clean
      // permission_denied for observability (instead of invisible /
      // succeeding-but-useless). The tool itself still guards
      // internally (DISCIPLINE_GIT_OFF) for callers that bypass the
      // hook path.
      if (toolName === "CommitCheckpoint") {
        const current = opts.agent.getSessionDiscipline(ctx.sessionKey);
        if (!current || current.requireCommit === "off" || !current.git) {
          ctx.emit({
            type: "rule_check",
            ruleId: "discipline.commitCheckpoint",
            verdict: "violation",
            detail: "discipline disabled",
          });
          return {
            action: "permission_decision",
            decision: "deny",
            reason: "discipline disabled",
          };
        }
        return { action: "continue" };
      }
      if (toolName !== "FileWrite" && toolName !== "FileEdit") {
        return { action: "continue" };
      }
      const discipline = activeDisciplineFor(ctx.sessionKey, opts.agent);
      if (!discipline) return { action: "continue" };
      // Only care about TDD enforcement here; git-only sessions let
      // afterTurnEnd do the reminder work.
      if (!discipline.tdd) return { action: "continue" };

      const asRec = input as { path?: unknown } | null;
      const target =
        asRec && typeof asRec.path === "string" ? asRec.path : null;
      if (!target) return { action: "continue" };

      // Is the target a source file we care about?
      const isSource = matchesAny(target, discipline.sourcePatterns);
      const isTest = matchesAny(target, discipline.testPatterns);
      // If the edit is itself a test file, the discipline is satisfied.
      if (isTest) {
        const counter = opts.agent.getSessionCounter(ctx.sessionKey);
        counter.testMutations += 1;
        counter.dirtyFilesSinceCommit += 1;
        return { action: "continue" };
      }
      if (!isSource) return { action: "continue" };

      // Source edit — bump counters and check for a matching test sibling.
      const counter = opts.agent.getSessionCounter(ctx.sessionKey);
      counter.sourceMutations += 1;
      counter.dirtyFilesSinceCommit += 1;

      const candidates = expectedTestPaths(target);
      let hasTest = false;
      for (const rel of candidates) {
        try {
          await fs.access(path.join(opts.workspaceRoot, rel));
          hasTest = true;
          break;
        } catch {
          // continue
        }
      }
      if (hasTest) return { action: "continue" };

      // Violation — emit audit + either block (hard) or warn (soft).
      ctx.log("warn", "[discipline] tdd_violation", {
        turnId: ctx.turnId,
        sourcePath: target,
        expectedTestPaths: candidates,
        enforcement: discipline.requireCommit,
      });
      ctx.emit({
        type: "rule_check",
        ruleId: "discipline.tdd",
        verdict: "violation",
        detail: `tdd_violation: ${target} (expected ${candidates[0] ?? ""})`,
      });

      if (discipline.requireCommit === "hard") {
        const reason = `TDD violation: editing ${target} without a sibling test file (${candidates[0] ?? "*.test.*"}). Write the failing test first, or call CommitCheckpoint to checkpoint your progress.`;
        return { action: "block", reason };
      }
      return { action: "continue" };
    },
  };
}

/**
 * afterTurnEnd — emit a reminder when the dirty-file count exceeds
 * `maxChangesBeforeCommit`. Always non-blocking (observer).
 */
export function makeDisciplineAfterTurnEndHook(
  opts: DisciplineHookOptions,
): RegisteredHook<"afterTurnEnd"> {
  return {
    name: "builtin:discipline-afterTurnEnd",
    point: "afterTurnEnd",
    priority: 80,
    blocking: false,
    timeoutMs: 500,
    handler: async (_args, ctx: HookContext) => {
      const discipline = activeDisciplineFor(ctx.sessionKey, opts.agent);
      if (!discipline) return { action: "continue" };
      if (!discipline.git) return { action: "continue" };

      const counter = opts.agent.getSessionCounter(ctx.sessionKey);
      if (counter.dirtyFilesSinceCommit < discipline.maxChangesBeforeCommit) {
        return { action: "continue" };
      }

      ctx.log("warn", "[discipline] discipline_reminder", {
        turnId: ctx.turnId,
        dirtyFilesSinceCommit: counter.dirtyFilesSinceCommit,
        threshold: discipline.maxChangesBeforeCommit,
      });
      ctx.emit({
        type: "rule_check",
        ruleId: "discipline.git",
        verdict: "violation",
        detail: `discipline_reminder: ${counter.dirtyFilesSinceCommit} dirty files (threshold ${discipline.maxChangesBeforeCommit})`,
      });
      return { action: "continue" };
    },
  };
}
