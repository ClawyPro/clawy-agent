import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { CronScheduler, CronRecord } from "../cron/CronScheduler.js";
import { errorResult } from "../util/toolResult.js";

export interface CronListInput {
  enabled?: boolean;
}

export interface CronListOutput {
  crons: CronRecord[];
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    enabled: {
      type: "boolean",
      description: "If set, filter to only enabled (true) or disabled (false) crons.",
    },
  },
} as const;

export function makeCronListTool(
  scheduler: CronScheduler,
): Tool<CronListInput, CronListOutput> {
  return {
    name: "CronList",
    description:
      "List scheduled crons for this bot. Shows expression, prompt, deliveryChannel, lastFiredAt, nextFireAt.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    async execute(
      input: CronListInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<CronListOutput>> {
      const start = Date.now();
      try {
        const crons = scheduler.list(
          input.enabled !== undefined ? { enabled: input.enabled } : undefined,
        );
        return {
          status: "ok",
          output: { crons },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
