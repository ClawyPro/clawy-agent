/**
 * ScoreVariant — T3-16 tournament scoring.
 *
 * Extracted from tools/SpawnAgent.ts (R4 step 3, 2026-04-19). A scorer
 * either invokes a named tool (`kind: "tool"`) with the child's
 * finalText bound into the input, or asks a Haiku model to rate the
 * finalText against a free-form rubric. All failure modes are absorbed
 * (thrown / missing score / NaN / non-ok tool status) — score=0 plus a
 * warning string that the tournament orchestrator hoists into an audit
 * breadcrumb.
 */

import type { Agent } from "../Agent.js";
import type { Tool, ToolContext } from "../Tool.js";

/** Scorer union exposed on SpawnAgentInput.scorer. */
export type TournamentScorer =
  | { kind: "tool"; toolName: string; input?: Record<string, unknown> }
  | { kind: "haiku_rubric"; rubric: string };

/** Model used for `haiku_rubric` scoring. */
export const TOURNAMENT_HAIKU_MODEL = "claude-haiku-4-5-20251001";

/**
 * Score a variant's final text using the configured scorer. Never
 * throws — on failure returns `{ score: 0, warning: <diagnostic> }`.
 */
export async function scoreVariant(
  finalText: string,
  scorer: TournamentScorer,
  ctx: ToolContext,
  agent: Agent,
): Promise<{ score: number; warning?: string }> {
  if (scorer.kind === "tool") {
    return scoreWithTool(finalText, scorer, ctx, agent);
  }
  return scoreWithHaikuRubric(finalText, scorer, agent);
}

async function scoreWithTool(
  finalText: string,
  scorer: Extract<TournamentScorer, { kind: "tool" }>,
  ctx: ToolContext,
  agent: Agent,
): Promise<{ score: number; warning?: string }> {
  const tool = agent.tools.resolve(scorer.toolName);
  if (!tool) {
    return { score: 0, warning: `scorer tool '${scorer.toolName}' not found` };
  }
  try {
    const toolInput = {
      ...(scorer.input ?? {}),
      childOutput: finalText,
    };
    const result = await (tool as Tool<unknown, unknown>).execute(toolInput, ctx);
    if (result.status !== "ok") {
      return {
        score: 0,
        warning: `scorer tool returned status=${result.status}`,
      };
    }
    const out = result.output as { score?: unknown } | undefined;
    const raw = out?.score;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      return { score: 0, warning: "scorer tool output.score is NaN or missing" };
    }
    return { score: n };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { score: 0, warning: `scorer tool threw: ${msg}` };
  }
}

async function scoreWithHaikuRubric(
  finalText: string,
  scorer: Extract<TournamentScorer, { kind: "haiku_rubric" }>,
  agent: Agent,
): Promise<{ score: number; warning?: string }> {
  try {
    const system =
      "Score the following response against this rubric from 0 to 100. Return only a single integer.";
    const userContent = `Rubric: ${scorer.rubric}\n\nResponse: ${finalText}`;
    const stream = agent.llm.stream({
      model: TOURNAMENT_HAIKU_MODEL,
      system,
      messages: [{ role: "user", content: userContent }],
    });
    let accumulated = "";
    for await (const evt of stream) {
      if (evt.kind === "text_delta") accumulated += evt.delta;
      else if (evt.kind === "error") {
        return { score: 0, warning: `haiku scorer error: ${evt.message}` };
      }
    }
    const match = accumulated.match(/\d+/);
    if (!match) {
      return {
        score: 0,
        warning: `haiku scorer produced no integer (got ${JSON.stringify(accumulated.slice(0, 60))})`,
      };
    }
    const n = parseInt(match[0], 10);
    if (!Number.isFinite(n)) {
      return { score: 0, warning: "haiku scorer integer parse failed" };
    }
    return { score: n };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { score: 0, warning: `haiku scorer threw: ${msg}` };
  }
}
