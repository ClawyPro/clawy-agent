/**
 * disciplinePromptBlock — beforeLLMCall hook that prepends the live
 * `<discipline>` observation block to the system prompt. Runs AFTER
 * classifyTurnMode (priority 3) and memoryInjector (priority 5) so the
 * block reflects the freshest classification and fits alongside
 * whatever memory context was added.
 *
 * Null block (discipline fully off) → no modification.
 */

import type { RegisteredHook, HookContext } from "../types.js";
import type { Discipline } from "../../Session.js";
import type { DisciplineSessionCounter } from "./disciplineHook.js";
import { buildDisciplineBlock } from "../../discipline/promptBlock.js";

export interface DisciplinePromptBlockAgent {
  getSessionDiscipline(sessionKey: string): Discipline | null;
  getSessionCounter(sessionKey: string): DisciplineSessionCounter;
}

export interface DisciplinePromptBlockOptions {
  agent: DisciplinePromptBlockAgent;
  now?: () => number;
}

export function makeDisciplinePromptBlockHook(
  opts: DisciplinePromptBlockOptions,
): RegisteredHook<"beforeLLMCall"> {
  const now = opts.now ?? Date.now;
  return {
    name: "builtin:discipline-prompt-block",
    point: "beforeLLMCall",
    priority: 6,
    blocking: true,
    timeoutMs: 200,
    handler: async ({ messages, tools, system, iteration }, ctx: HookContext) => {
      const discipline = opts.agent.getSessionDiscipline(ctx.sessionKey);
      if (!discipline) return { action: "continue" };
      const counter = opts.agent.getSessionCounter(ctx.sessionKey);
      const block = buildDisciplineBlock({ discipline, counter, now: now() });
      if (!block) return { action: "continue" };
      const nextSystem = system ? `${block}\n\n${system}` : block;
      return {
        action: "replace",
        value: { messages, tools, system: nextSystem, iteration },
      };
    },
  };
}
