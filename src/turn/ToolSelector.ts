/**
 * ToolSelector — pick the tool set exposed to the LLM for one turn.
 *
 * Extracted from Turn.buildToolDefs (R3 refactor, 2026-04-19). Owns:
 *   • T2-08 plan-mode read-only filter (driven by session permissionMode)
 *   • Skill intent classification + filterToolsByIntent
 *   • Hard cap at MAX_TOOLS_PER_TURN (§9.8 P3)
 *   • intent tool_start / tool_end SSE emission for observability
 */

import type { Session } from "../Session.js";
import type { SseWriter } from "../transport/SseWriter.js";
import type { LLMToolDef } from "../transport/LLMClient.js";
import type { Tool } from "../Tool.js";
import { filterToolsByIntent } from "../rules/IntentClassifier.js";

/**
 * Hard cap on tools exposed per turn (§9.8 P3).
 * 2026-04-20 0.17.1: 15 → 50 for Claude Code parity. Bots with 100+
 * skills previously had relevant skills truncated by the 15-cap after
 * intent classification picked too few tags. 50 covers every realistic
 * intent overlap while staying below the model's tool-def token budget.
 */
export const MAX_TOOLS_PER_TURN = 50;

/** Tool names allowed while planMode=true. */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "FileRead",
  "Glob",
  "Grep",
  "TaskBoard",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export interface ToolSelectorDeps {
  readonly session: Session;
  readonly sse: SseWriter;
  readonly turnId: string;
  readonly userText: string;
  /** True when the session (or Turn mirror) is in plan mode. */
  readonly planMode: boolean;
}

export async function buildToolDefs(deps: ToolSelectorDeps): Promise<LLMToolDef[]> {
  let all = deps.session.agent.tools.list();
  if (deps.planMode) {
    all = all.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name));
  }
  const hasSkills = all.some((t) => t.kind === "skill");

  let selected: Tool[];
  if (!hasSkills) {
    selected = all.slice(0, MAX_TOOLS_PER_TURN);
  } else {
    // Collect unique tags across loaded skills for the classifier.
    const tagSet = new Set<string>();
    for (const t of all) if (t.kind === "skill") for (const tag of t.tags ?? []) tagSet.add(tag);
    const availableTags = [...tagSet];

    const intentTags = await deps.session.agent.intent.classify(
      deps.userText,
      availableTags,
    );
    deps.sse.agent({
      type: "tool_start",
      id: `intent-${deps.turnId}`,
      name: `intent:${intentTags.join(",") || "general"}`,
    });
    deps.sse.agent({
      type: "tool_end",
      id: `intent-${deps.turnId}`,
      status: "ok",
      durationMs: 0,
      output_preview: intentTags.join(","),
    });

    selected = filterToolsByIntent(all, intentTags, MAX_TOOLS_PER_TURN);
  }

  return selected.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
