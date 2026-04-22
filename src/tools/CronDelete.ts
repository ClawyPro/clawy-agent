import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { CronScheduler } from "../cron/CronScheduler.js";
import { errorResult } from "../util/toolResult.js";

export interface CronDeleteInput {
  cronId: string;
}

export interface CronDeleteOutput {
  deleted: boolean;
  cronId: string;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    cronId: { type: "string" },
  },
  required: ["cronId"],
} as const;

export function makeCronDeleteTool(
  scheduler: CronScheduler,
): Tool<CronDeleteInput, CronDeleteOutput> {
  return {
    name: "CronDelete",
    description: "Delete a scheduled cron by id. Irreversible.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    dangerous: true,
    async execute(
      input: CronDeleteInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<CronDeleteOutput>> {
      const start = Date.now();
      try {
        const deleted = await scheduler.delete(input.cronId);
        return {
          status: "ok",
          output: { deleted, cronId: input.cronId },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
