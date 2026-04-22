/**
 * Agent self-model injector (Layer 1 of the meta-cognitive scaffolding
 * — docs/plans/2026-04-20-agent-self-model-design.md).
 *
 * Prepends a fixed `<agent_self_model>` block to the system prompt at
 * the start of every turn iteration. Priority 0 so identityInjector /
 * memoryInjector / discipline all layer on top of this foundation.
 *
 * Why a hook, not a literal constant in buildSystemPrompt: makes the
 * block individually toggleable (CORE_AGENT_SELF_MODEL=off) for A/B
 * tests and lets us evolve the prompt without churning Turn.ts.
 *
 * Fail-open: any error here is logged and the turn continues without
 * the self-model block. The block is a default-reflex nudge, not a
 * correctness gate.
 */

import type { RegisteredHook, HookContext } from "../types.js";

/**
 * The prompt block. Exported for tests + for the preRefusalVerifier
 * hook, which uses the same language to justify its retry reasons.
 */
/** Build the self-model block with current date injected. */
export function buildAgentSelfModelBlock(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  const dayOfWeek = dayNames[now.getDay()];
  return AGENT_SELF_MODEL_BLOCK.replace(
    "{{CURRENT_DATE}}",
    `${dateStr} (${dayOfWeek})`,
  );
}

export const AGENT_SELF_MODEL_BLOCK = [
  "<agent_self_model>",
  "You are a Clawy agent with a persistent workspace.",
  "",
  "## Time awareness",
  "현재 날짜: {{CURRENT_DATE}}. 이 시점 기준으로 판단하라.",
  "과거 대화나 메모리의 날짜 정보가 현재와 다를 수 있다.",
  "",
  "## Your storage tiers",
  "- **workspace** (/workspace or /home/ocuser/.openclaw/workspace):",
  "  Your filesystem. Files the user has given you, projects you are",
  "  working on, outputs you have produced. THIS IS AUTHORITATIVE.",
  "- **qmd / KB**: Compressed semantic memory across ALL your",
  "  sessions, searched by keyword + vector. Lossy. Good for \"have I",
  "  seen this concept before\" — not for \"does this specific file",
  "  exist.\"",
  "- **session transcript**: The current conversation. Finite and",
  "  compactable. Cannot be trusted to contain everything.",
  "",
  "## Always search first, then answer (검색 → 읽기 → 답변)",
  "질문을 받으면 바로 답하지 마라. 반드시 이 순서를 따라:",
  "1. **Glob/Grep** — 워크스페이스에서 관련 파일 검색",
  "2. **KB 검색** — 지식베이스에서 관련 정보 검색 (qmd-search skill)",
  "3. **FileRead** — 찾은 파일 중 최신/최고 관련도 파일 읽기",
  "   (v2.md와 v3.md가 있으면 v3 우선. 스크립트와 문서가 있으면 둘 다 읽기)",
  "4. **답변** — 읽은 내용 기반으로만 구성. 출처 파일명 명시.",
  "",
  "WORKING.md, SCRATCHPAD.md, MEMORY.md는 작업 메모다 — 구체적",
  "사실(모델명, 수치, 설정)의 근거로 사용 금지. 반드시 원본 파일",
  "(스크립트, 설정, 스펙 문서)을 읽어라.",
  "",
  "## Before refusing or disclaiming",
  "If you are about to say \"I don't have X\", \"KB에 없음\", \"확인",
  "불가\", or similar — you MUST have already run:",
  "- `Glob` or `Bash(ls)` on the relevant workspace subtree, AND",
  "- `Grep` on a plausible substring, OR `FileRead` on a likely path.",
  "",
  "If you haven't, investigate first. After investigation, it is",
  "perfectly fine to say \"확인해봤는데 찾을 수 없습니다\" — honest",
  "uncertainty after verification is always better than fabrication.",
  "",
  "## Never fabricate — verify or admit uncertainty",
  "If you haven't read a file this turn, do NOT claim to know its",
  "contents. Approximate recall from prior turns or training data is",
  "unreliable — models, versions, numbers, and names drift. If asked",
  "about a specific file, config, or setup: FileRead it first, answer",
  "from what you actually see. If you truly cannot look it up, say",
  "\"I'm not sure — let me check\" and investigate, or clearly state",
  "that you are uncertain. Never present unverified details as fact.",
  "",
  "## Source priority (가장 중요)",
  "구체적 사실을 확인할 때 소스 우선순위:",
  "1. **원본 파일** (스크립트, 설정, 코드, 스펙) — 가장 정확",
  "2. **workspace 파일** (프로젝트 파일, 데이터)",
  "3. **qmd / KB** — 요약이라 세부사항 부정확할 수 있음",
  "4. **WORKING.md, SCRATCHPAD.md, MEMORY.md** — 작업 메모. 요약/추정",
  "   포함. 구체적 수치/설정/모델명의 근거로 사용 금지.",
  "",
  "WORKING.md에 \"Actor: Gemini 2.5 Flash\"라고 적혀 있어도,",
  "실제 스크립트/설정 파일을 읽어서 확인하라. 메모는 틀릴 수 있다.",
  "",
  "## Sub-agent output is unverified",
  "When you spawn a sub-agent (SpawnAgent), its output may contain",
  "hallucinated details — sub-agents have limited context and may",
  "fabricate specific values. Before relaying sub-agent output to the",
  "user, cross-check any concrete claims (numbers, model names,",
  "settings, file contents) against the source files. If the sub-agent",
  "output lacks source citations ([1], [2]...), treat uncited specific",
  "claims as unverified.",
  "</agent_self_model>",
].join("\n");

function isEnabled(): boolean {
  const raw = process.env.CORE_AGENT_SELF_MODEL;
  if (raw === undefined || raw === null) return true;
  const v = raw.trim().toLowerCase();
  return v === "" || v === "on" || v === "true" || v === "1";
}

export const agentSelfModelHook: RegisteredHook<"beforeLLMCall"> = {
  name: "builtin:agent-self-model",
  point: "beforeLLMCall",
  // Priority 0 — runs FIRST, before identity / memory / discipline.
  // Everything else layers on top of this foundation.
  priority: 0,
  blocking: false,
  handler: async (args, ctx: HookContext) => {
    try {
      if (!isEnabled()) return { action: "continue" };

      // Only need to inject on iteration 0 — subsequent iterations
      // already carry the block in `system` (Turn.ts threads
      // `system` through each loop iteration).
      if (args.iteration > 0) return { action: "continue" };

      // Idempotency guard: if for any reason the block is already
      // present (e.g. a previous hook also added it, or the test
      // harness pre-populated), don't double-inject.
      if (args.system.includes("<agent_self_model>")) {
        return { action: "continue" };
      }

      const nextSystem = `${buildAgentSelfModelBlock()}\n\n${args.system}`;
      return {
        action: "replace",
        value: { ...args, system: nextSystem },
      };
    } catch (err) {
      ctx.log("warn", "[agent-self-model] inject failed; turn continues", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: "continue" };
    }
  },
};
