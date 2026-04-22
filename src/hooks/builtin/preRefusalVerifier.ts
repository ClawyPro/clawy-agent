/**
 * Pre-refusal verifier (Layer 3 of the meta-cognitive scaffolding —
 * docs/plans/2026-04-20-agent-self-model-design.md).
 *
 * beforeCommit gate, priority 85 (runs BEFORE answerVerifier at 90).
 *
 * Problem: the LLM drafts "I don't have X" / "KB에 없음" without ever
 * running Glob/Grep/FileRead/Bash against the workspace. Layer 1 tells
 * it to check first; Layer 2 gives it a map; Layer 3 is the
 * commit-time enforcement — if the drafted answer matches a refusal
 * pattern AND the turn log shows zero investigation tools used, we
 * block for one retry with an explicit instruction to go check.
 *
 * Retry budget: 1, matching answerVerifier. After that we log + fail
 * open — if the bot insists on refusing after one nudge, maybe it
 * really doesn't exist. Goal: "did you check?" not "you must not
 * refuse."
 *
 * Architectural note: `ctx.transcript` is currently always `[]` at
 * hook dispatch time (see HookContextBuilder — transcript wiring is a
 * future item). We therefore reach the tool-call log via a tiny agent
 * delegate that exposes the Session's on-disk transcript. This keeps
 * the hook pure-function testable (inject the delegate) and avoids
 * taking a hard dep on Session internals.
 *
 * Fail-open: any transcript read / pattern compile error logs a warn
 * and continues. A broken verifier must never block a legitimate
 * commit.
 *
 * Toggle: `CORE_AGENT_PRE_REFUSAL_VERIFY=off` disables globally.
 */

import type { RegisteredHook, HookContext } from "../types.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";

/** Patterns that signal a refusal / "I don't have this" draft.
 *
 * Kept as a simple string list inside the module (YAGNI — external
 * i18n JSON lives in the design doc as a future item, not shipped
 * yet). Korean + English, case-insensitive for English.
 */
export const REFUSAL_PATTERNS: RegExp[] = [
  // Korean: "KB에/기억/memory ... 없 / 못 찾 / 저장되어 있지 않"
  /(?:KB에|기억|memory).{0,40}(?:없|못\s*찾|저장되어\s*있지\s*않)/u,
  // Korean: "저장되어 있지 않" standalone
  /저장되어\s*있지\s*않/u,
  // Korean: "확인 불가"
  /확인\s*불가/u,
  // Korean: "찾을 수 없" (common refusal)
  /찾을\s*수\s*없/u,
  // English: "I/we don't have/see/find/know ..."
  /(?:\bI\b|\bwe\b)\s+(?:do\s+not|don[''`]t)\s+(?:have|see|find|know)/i,
  // English: "cannot/can't find/locate/verify/confirm ..."
  /(?:cannot|can[''`]t)\s+(?:find|locate|verify|confirm)/i,
  // English: "unable to confirm/verify/find"
  /unable\s+to\s+(?:confirm|verify|find|locate)/i,
  // English: "no record of" / "not in (my|the) (KB|memory|records)"
  /no\s+record\s+of/i,
  /not\s+in\s+(?:my|the)\s+(?:kb|knowledge|memory|records?)/i,
];

/** Tool names whose presence in the turn's transcript means the bot
 * DID investigate before drafting — skips the block. */
const INVESTIGATION_TOOLS = new Set([
  "Glob",
  "Grep",
  "FileRead",
  "Bash",
]);

const MAX_RETRIES = 1;

export interface PreRefusalVerifierAgent {
  /** Return all transcript entries visible to this hook — the
   * handler filters by `ctx.turnId` itself. When the delegate isn't
   * wired (unit tests not exercising the full transcript), returning
   * `null` causes the hook to fall back to `ctx.transcript`. */
  readSessionTranscript(
    sessionKey: string,
  ): Promise<ReadonlyArray<TranscriptEntry> | null>;
}

function isEnabled(): boolean {
  const raw = process.env.CORE_AGENT_PRE_REFUSAL_VERIFY;
  if (raw === undefined || raw === null) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "on" || v === "true" || v === "1";
}

/** Exported for tests — true if any pattern matches. */
export function matchesRefusal(text: string): boolean {
  if (!text) return false;
  for (const p of REFUSAL_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

/** Exported for tests — count investigation tool calls in the turn's
 * transcript (only entries tagged with the current turnId). */
export function countInvestigationsThisTurn(
  transcript: ReadonlyArray<{ kind: string; turnId: string; name?: string }>,
  turnId: string,
): number {
  let n = 0;
  for (const entry of transcript) {
    if (entry.kind !== "tool_call") continue;
    if (entry.turnId !== turnId) continue;
    if (typeof entry.name === "string" && INVESTIGATION_TOOLS.has(entry.name)) {
      n++;
    }
  }
  return n;
}

export interface PreRefusalVerifierOptions {
  /** Optional delegate that reads the session transcript from disk.
   * When omitted, the hook falls back to `ctx.transcript` — which is
   * empty in production today but populated in unit tests. */
  agent?: PreRefusalVerifierAgent;
}

export function makePreRefusalVerifierHook(
  opts: PreRefusalVerifierOptions = {},
): RegisteredHook<"beforeCommit"> {
  return {
    name: "builtin:pre-refusal-verifier",
    point: "beforeCommit",
    // Runs BEFORE answerVerifier (90). Cheap deterministic check — no
    // LLM call, so it can gate inexpensively before the Haiku judge.
    priority: 85,
    blocking: true,
    handler: async ({ assistantText, retryCount }, ctx: HookContext) => {
      try {
        if (!isEnabled()) return { action: "continue" };

        if (!assistantText || assistantText.trim().length === 0) {
          return { action: "continue" };
        }

        if (!matchesRefusal(assistantText)) {
          return { action: "continue" };
        }

        let entries: ReadonlyArray<TranscriptEntry> | null = null;
        if (opts.agent) {
          try {
            entries = await opts.agent.readSessionTranscript(ctx.sessionKey);
          } catch (err) {
            ctx.log("warn", "[pre-refusal-verifier] transcript read failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            entries = null;
          }
        }
        const source = entries ?? (ctx.transcript as ReadonlyArray<TranscriptEntry>);

        const investigationCount = countInvestigationsThisTurn(
          source as ReadonlyArray<{
            kind: string;
            turnId: string;
            name?: string;
          }>,
          ctx.turnId,
        );

        if (investigationCount > 0) {
          // Refusal with investigation is legitimate — let it through.
          ctx.emit({
            type: "rule_check",
            ruleId: "pre-refusal-verifier",
            verdict: "ok",
            detail: `refusal allowed; investigated=${investigationCount}`,
          });
          return { action: "continue" };
        }

        if (retryCount >= MAX_RETRIES) {
          ctx.log(
            "warn",
            "[pre-refusal-verifier] retry budget exhausted; failing open",
            { retryCount },
          );
          ctx.emit({
            type: "rule_check",
            ruleId: "pre-refusal-verifier",
            verdict: "violation",
            detail: `retry exhausted; failing open`,
          });
          return { action: "continue" };
        }

        ctx.log(
          "warn",
          "[pre-refusal-verifier] blocking refusal without investigation",
          { retryCount },
        );
        ctx.emit({
          type: "rule_check",
          ruleId: "pre-refusal-verifier",
          verdict: "violation",
          detail: `blocked for retry; retryCount=${retryCount}`,
        });
        return {
          action: "block",
          reason: [
            "[RETRY:PRE_REFUSAL_VERIFY] You are refusing / disclaiming",
            "without having checked the workspace this turn. Before",
            "finalising this answer:",
            "1) Glob or Bash(ls) a plausible workspace subtree.",
            "2) Grep for a substring of what the user asked about.",
            "3) FileRead any likely hits.",
            "Then re-draft based on what you actually find. If after",
            "checking the thing really is absent, say so — explicit",
            "refusal after investigation is fine.",
          ].join("\n"),
        };
      } catch (err) {
        ctx.log("warn", "[pre-refusal-verifier] failed; commit continues", {
          error: err instanceof Error ? err.message : String(err),
        });
        return { action: "continue" };
      }
    },
  };
}

/**
 * Default singleton — no delegate, falls back to `ctx.transcript`.
 * Convenient for tests that populate `ctx.transcript` manually (the
 * Layer 1/2 style). Production registration in
 * `src/hooks/builtin/index.ts` uses `makePreRefusalVerifierHook`
 * with an agent delegate that reads the on-disk JSONL.
 */
export const preRefusalVerifierHook = makePreRefusalVerifierHook();
