/**
 * Deferral blocker hook — beforeCommit, priority 86.
 *
 * Problem (2026-04-20 admin-bot POS case): the LLM drafts an answer
 * that promises "I'll send results when done" / "완료되면 결과
 * 보내드리겠습니다" / "5분 후 결과 드릴게요" AND ends the turn, stranding
 * the user. Claude Code handles long work by running the work
 * synchronously in the same turn and returning the artefact. Clawy
 * should match that.
 *
 * Distinct from preRefusalVerifier (priority 85): that blocks refusals
 * without investigation. This blocks turn endings where the bot
 * narrates future delivery without having delivered. Fires when:
 *   1. Response text matches a deferral-promise pattern, AND
 *   2. The turn either:
 *      (a) invoked a subagent / long-running Bash (i.e. work was
 *          actually started — but no deliverable materialised), OR
 *      (b) invoked NO tool at all (pure narration — deferring without
 *          even trying).
 *
 * Retry budget: 1. Fail-open on error. Operator-gate:
 * `CORE_AGENT_DEFERRAL_BLOCKER=off`.
 */

import type { RegisteredHook, HookContext } from "../types.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";

/**
 * Patterns matching "I'll deliver this later" promises drafted just
 * before turn end. Korean + English, case-insensitive for English.
 */
export const DEFERRAL_PATTERNS: RegExp[] = [
  // Korean: 완료되면 결과 보내/드리겠/전달 등
  /완료(?:되면|하면|후에?)\s*[^.\n]{0,40}?(?:보내|드리|전달|공유|알려)/u,
  // Korean: 결과(를?) (보내|드리|전달) (드리|겠|예정)
  /결과(?:를|가)?\s*(?:보내|드리|전달)(?:\s*드리)?(?:겠|예정|할게)/u,
  // Korean: 나중에 (보내|드리|알려)
  /나중에\s*[^.\n]{0,20}?(?:보내|드리|알려|전달)/u,
  // Korean: 분/시간 후 + 결과/리포트
  /\d+\s*(?:분|시간)\s*(?:후|뒤)\s*[^.\n]{0,20}?(?:결과|리포트|보내|드리)/u,
  // Korean: "조금만 기다려" / "잠시만요" + 완료 promise. Matches
  // either the bare "잠시만요" form or the "조금만 기다려" form with
  // an optional attached honorific particle.
  /(?:조금만|잠시만|잠깐만)(?:요)?/u,
  // English: "I'll (send|give|return|report|share) ... when/once"
  /\bI[''`]?ll\s+(?:send|give|return|report|share|provide|deliver)[^.\n]{0,40}?\b(?:when|once|after|as\s+soon)/i,
  // English: "results will be (sent|ready|available)"
  /\bresults?\s+(?:will\s+be|are\s+coming|is\s+coming)\s+(?:sent|ready|available|shortly)/i,
  // English: "check back"
  /\bcheck\s+back\b/i,
  // English: "in (a few|5|10) (minutes|seconds)"
  /\bin\s+(?:a\s+few|\d+)\s+(?:minutes?|seconds?)\b/i,
];

/** Tool names that indicate work was actually started this turn. */
const WORK_TOOLS = new Set([
  "SpawnAgent",
  "Bash",
  "BashExec",
  "FileWrite",
  "FileEdit",
]);

const MAX_RETRIES = 1;

export interface DeferralBlockerAgent {
  readSessionTranscript(
    sessionKey: string,
  ): Promise<ReadonlyArray<TranscriptEntry> | null>;
}

function isEnabled(): boolean {
  const raw = process.env.CORE_AGENT_DEFERRAL_BLOCKER;
  if (raw === undefined || raw === null) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "on" || v === "true" || v === "1";
}

/** Exported for tests — pattern match. */
export function matchesDeferral(text: string): boolean {
  if (!text) return false;
  for (const p of DEFERRAL_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

/** Exported for tests — count WORK_TOOLS calls in the turn's transcript. */
export function countWorkToolsThisTurn(
  transcript: ReadonlyArray<{ kind: string; turnId: string; name?: string }>,
  turnId: string,
): number {
  let n = 0;
  for (const entry of transcript) {
    if (entry.kind !== "tool_call") continue;
    if (entry.turnId !== turnId) continue;
    if (typeof entry.name === "string" && WORK_TOOLS.has(entry.name)) {
      n++;
    }
  }
  return n;
}

export interface DeferralBlockerOptions {
  agent?: DeferralBlockerAgent;
}

export function makeDeferralBlockerHook(
  opts: DeferralBlockerOptions = {},
): RegisteredHook<"beforeCommit"> {
  return {
    name: "builtin:deferral-blocker",
    point: "beforeCommit",
    // 86 — one notch after preRefusalVerifier (85), before answerVerifier (90).
    priority: 86,
    blocking: true,
    handler: async ({ assistantText, retryCount }, ctx: HookContext) => {
      try {
        if (!isEnabled()) return { action: "continue" };

        if (!assistantText || assistantText.trim().length === 0) {
          return { action: "continue" };
        }

        if (!matchesDeferral(assistantText)) {
          return { action: "continue" };
        }

        if (retryCount >= MAX_RETRIES) {
          ctx.log("warn", "[deferral-blocker] retry budget exhausted; failing open", {
            retryCount,
          });
          ctx.emit({
            type: "rule_check",
            ruleId: "deferral-blocker",
            verdict: "violation",
            detail: "retry exhausted; failing open",
          });
          return { action: "continue" };
        }

        // We block for retry regardless of whether tools fired this
        // turn — the response promises future delivery in THIS turn.
        // Whether work already started or not, the bot should
        // complete and deliver inline.
        let entries: ReadonlyArray<TranscriptEntry> | null = null;
        if (opts.agent) {
          try {
            entries = await opts.agent.readSessionTranscript(ctx.sessionKey);
          } catch (err) {
            ctx.log("warn", "[deferral-blocker] transcript read failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            entries = null;
          }
        }
        const source = entries ?? (ctx.transcript as ReadonlyArray<TranscriptEntry>);
        const workCount = countWorkToolsThisTurn(
          source as ReadonlyArray<{
            kind: string;
            turnId: string;
            name?: string;
          }>,
          ctx.turnId,
        );

        ctx.log("warn", "[deferral-blocker] blocking deferral promise", {
          retryCount,
          workCount,
        });
        ctx.emit({
          type: "rule_check",
          ruleId: "deferral-blocker",
          verdict: "violation",
          detail: `blocked; retryCount=${retryCount} workToolCalls=${workCount}`,
        });
        return {
          action: "block",
          reason: [
            "[RETRY:DEFERRAL_BLOCKED] You drafted a response that defers",
            "delivery to a later message (\"I'll send results when done\" /",
            "\"완료되면 결과 보내드릴게요\" / \"잠시만요\"). Clawy turns are",
            "synchronous: complete the work in THIS turn and return the",
            "result inline, like Claude Code does. Either:",
            "  (a) Call the remaining tools (SpawnAgent, Bash, FileRead,",
            "      ArtifactRead) NOW and synthesise results in the same",
            "      response, OR",
            "  (b) If the work genuinely cannot complete this turn, say",
            "      so plainly with a concrete reason — do not promise",
            "      future delivery you cannot keep.",
            "Remove the deferral phrasing and re-draft.",
          ].join("\n"),
        };
      } catch (err) {
        ctx.log("warn", "[deferral-blocker] failed; commit continues", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { action: "continue" };
      }
    },
  };
}

/** Default singleton — no delegate, falls back to `ctx.transcript`. */
export const deferralBlockerHook = makeDeferralBlockerHook();
