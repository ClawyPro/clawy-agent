/**
 * Built-in self-claim verifier hook (port of
 * infra/docker/chat-proxy/self-claim-verifier.js — AEF RULE5).
 * Design reference: §6 invariant D (read-before-claim).
 *
 * Blocks commit when the assistant asserts something about its own
 * workspace file / prompt / memory WITHOUT having read the
 * referenced file in this turn. The model is forced to abort the
 * turn, read the file, and retry.
 */

import type { RegisteredHook, HookContext } from "../types.js";

// Korean: claims about my prompt / config / memory / named .md file.
const KR_SELF_CLAIM_RE =
  /(?:제\s*(?:프롬프트|config|설정|메모리|SOUL\.md|AGENTS?\.md|TOOLS?\.md|SCRATCHPAD|WORKING|MEMORY|USER\.md)|내\s*(?:프롬프트|config|설정|메모리|소스코드|파일)|제가\s*가진\s*(?:프롬프트|설정)|Evaluator\s*프롬프트|Finalize\s*프롬프트|Actor\s*프롬프트)[^.\n]{0,80}(?:없(?:습니다|음|다|어요)|있(?:습니다|음|다|어요)|안\s*(?:들어|포함|박혀)|포함(?:되지|안)|기재(?:되지|안))/i;

// English equivalent.
const EN_SELF_CLAIM_RE =
  /(?:my|our)\s+(?:prompt|config|system\s+prompt|configuration|workspace|SOUL\.md|agents?\.md|memory|Evaluator|Finalize|Actor)[^.\n]{0,80}(?:does\s*not|doesn't|is\s*not|isn't|has\s*no|doesn't\s*have|does\s*not\s*include|lacks)/i;

// "SOUL.md 없습니다" / "MEMORY.md is empty" style outright denials.
const NAMED_FILE_DENIAL_RE =
  /(?:SOUL|IDENTITY|AGENTS?|TOOLS?|MEMORY|USER|SCRATCHPAD|WORKING|HEARTBEAT)\.md[^.\n]{0,40}(?:없(?:습니다|음|다)|doesn't exist|is empty)/i;

/** Tools whose execution counts as "having read a workspace file". */
const READ_TOOLS = new Set(["FileRead", "Grep", "Glob", "Bash"]);

function detectSelfClaim(text: string): "kr" | "en" | "named_file" | null {
  if (!text || text.length < 10) return null;
  if (KR_SELF_CLAIM_RE.test(text)) return "kr";
  if (EN_SELF_CLAIM_RE.test(text)) return "en";
  if (NAMED_FILE_DENIAL_RE.test(text)) return "named_file";
  return null;
}

export const selfClaimVerifierHook: RegisteredHook<"beforeCommit"> = {
  name: "builtin:self-claim-verifier",
  point: "beforeCommit",
  priority: 80,
  blocking: true,
  timeoutMs: 1_000,
  handler: async ({ assistantText, toolReadHappened }, ctx: HookContext) => {
    const claim = detectSelfClaim(assistantText);
    if (!claim) return { action: "continue" };

    // A workspace file-reading tool (FileRead / Grep / Glob / Bash)
    // was used this turn → the claim is backed by evidence. Let it
    // through but surface a rule_check event for the UI.
    if (toolReadHappened) {
      ctx.emit({
        type: "rule_check",
        ruleId: "self-claim-verifier",
        verdict: "ok",
        detail: `self-claim kind=${claim} with tool read`,
      });
      return { action: "continue" };
    }

    ctx.emit({
      type: "rule_check",
      ruleId: "self-claim-verifier",
      verdict: "violation",
      detail: `self-claim kind=${claim} without file read`,
    });
    ctx.log("warn", "blocking commit: self-claim without file read", { kind: claim });

    return {
      action: "block",
      reason:
        "[RETRY:RULE5] Response asserted something about your own workspace / prompt / memory without having read the relevant file this turn. Memory-based claims are treated as hallucination. Read the file (FileRead on SOUL.md / AGENTS.md / TOOLS.md / MEMORY.md / USER.md or the specific file you referenced) and regenerate the answer with concrete quotes. If the file genuinely doesn't exist, say so explicitly after verifying with Glob/Bash ls.",
    };
  },
};

/**
 * Reusable helper to build a toolReadHappened flag from any Turn's
 * tool-call history. Kept here so RuleEngine (Phase 2c-next) can
 * reuse the same detection logic.
 */
export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}
