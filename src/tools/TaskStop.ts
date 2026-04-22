/**
 * TaskStop — T2-10.
 *
 * Aborts a running background subagent task by triggering the
 * AbortController held inside BackgroundTaskRegistry. The registry
 * transitions the task to status="aborted"; the child loop sees the
 * abort signal on its next iteration and unwinds.
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { BackgroundTaskRegistry } from "../tasks/BackgroundTaskRegistry.js";
import { errorResult } from "../util/toolResult.js";

export interface TaskStopInput {
  taskId: string;
  reason?: string;
}

export interface TaskStopOutput {
  stopped: boolean;
  taskId: string;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "taskId returned by SpawnAgent." },
    reason: {
      type: "string",
      description:
        "Optional human-readable reason; recorded in record.error as 'stopped: <reason>'.",
    },
  },
  required: ["taskId"],
} as const;

export function makeTaskStopTool(
  registry: BackgroundTaskRegistry,
): Tool<TaskStopInput, TaskStopOutput> {
  return {
    name: "TaskStop",
    description:
      "Abort a running background subagent task. Triggers the child's AbortSignal and marks the task as 'aborted'. Returns stopped=true when an abort was actually fired; stopped=false when the task was unknown or already in a terminal state.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    kind: "core",
    validate(input) {
      if (!input || typeof input.taskId !== "string" || input.taskId.length === 0) {
        return "`taskId` is required";
      }
      return null;
    },
    async execute(
      input: TaskStopInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<TaskStopOutput>> {
      const start = Date.now();
      try {
        const stopped = await registry.stop(input.taskId, input.reason);
        return {
          status: "ok",
          output: { stopped, taskId: input.taskId },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
