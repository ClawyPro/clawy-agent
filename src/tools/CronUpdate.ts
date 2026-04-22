import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { CronScheduler, CronRecord } from "../cron/CronScheduler.js";
import { errorResult } from "../util/toolResult.js";

export interface CronUpdateInput {
  cronId: string;
  expression?: string;
  prompt?: string;
  enabled?: boolean;
  description?: string;
}

export interface CronUpdateOutput {
  cron: CronRecord;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    cronId: { type: "string" },
    expression: { type: "string" },
    prompt: { type: "string" },
    enabled: { type: "boolean" },
    description: { type: "string" },
  },
  required: ["cronId"],
} as const;

export function makeCronUpdateTool(
  scheduler: CronScheduler,
): Tool<CronUpdateInput, CronUpdateOutput> {
  return {
    name: "CronUpdate",
    description:
      "Update an existing cron's expression / prompt / enabled / description. " +
      "Changing expression recomputes the next fire time immediately.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    async execute(
      input: CronUpdateInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<CronUpdateOutput>> {
      const start = Date.now();
      try {
        const cron = await scheduler.update(input.cronId, {
          ...(input.expression !== undefined ? { expression: input.expression } : {}),
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        });
        return {
          status: "ok",
          output: { cron },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
