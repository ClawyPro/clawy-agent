/**
 * Inline task notification hook (#81) — drains the background task
 * registry's per-session notification queue at the start of each
 * beforeLLMCall and appends a synthetic user-role message containing
 * `<task-notification>` blocks so the running turn learns about any
 * background tasks that completed while it was idle (or mid-turn).
 *
 * Parallel in spirit to `midTurnInjector.ts` (#86) but distinct:
 *   - #86 queues user-origin messages (real user typed mid-turn).
 *   - #81 queues system-origin completion signals (cron fired, spawn
 *     returned, etc.) — formatted as `<task-notification>` so the LLM
 *     can clearly distinguish them from user utterances.
 *
 * Fail-open: any drain/render error is logged and the turn continues
 * unmodified. An ergonomic surface must never block a turn.
 */

import type { RegisteredHook, HookContext } from "../types.js";
import type { LLMMessage } from "../../transport/LLMClient.js";
import type { TaskNotification } from "../../tasks/BackgroundTaskRegistry.js";

/** Truncation cap for `output` per notification — keeps the parent
 * session's context bounded when a subagent produced a long transcript. */
const MAX_OUTPUT_BYTES = 4 * 1024;

export interface TaskNotifierAgent {
  /** Remove and return all pending notifications for the session. */
  drainForSession(sessionKey: string): TaskNotification[];
}

export interface InlineTaskNotifierOpts {
  readonly agent: TaskNotifierAgent;
}

/** Truncate to MAX_OUTPUT_BYTES UTF-8 bytes, appending a marker when cut. */
function truncateOutput(output: string): string {
  const buf = Buffer.from(output, "utf8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return output;
  // Slice on byte boundary then coerce back to a valid UTF-8 string.
  const slice = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return `${slice}…[truncated ${buf.byteLength - MAX_OUTPUT_BYTES} bytes]`;
}

/** Render a single `TaskNotification` into its XML-ish block. */
export function renderNotification(n: TaskNotification): string {
  const lines = [
    "<task-notification>",
    `  <task-id>${n.taskId}</task-id>`,
    `  <kind>${n.kind}</kind>`,
    `  <summary>${n.summary}</summary>`,
  ];
  if (n.output !== undefined && n.output !== "") {
    lines.push(`  <output>${truncateOutput(n.output)}</output>`);
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

/**
 * Compose a single synthetic user message containing all the drained
 * notifications, one `<task-notification>` block per entry. A leading
 * comment line tells the LLM these are system-origin completion
 * signals so it doesn't confuse them with a fresh user request.
 */
export function buildNotificationMessage(
  notifications: ReadonlyArray<TaskNotification>,
): LLMMessage | null {
  if (notifications.length === 0) return null;
  const body = [
    "<!-- The following background tasks finished while you were working.",
    "     Incorporate their results into the rest of this turn. These are",
    "     system-origin notifications, not a new user request. -->",
    ...notifications.map(renderNotification),
  ].join("\n");
  return {
    role: "user",
    content: [{ type: "text", text: body }],
  };
}

export function makeInlineTaskNotifierHook(
  opts: InlineTaskNotifierOpts,
): RegisteredHook<"beforeLLMCall"> {
  return {
    name: "builtin:inline-task-notifier",
    point: "beforeLLMCall",
    // Priority 4 — after mid-turn injector (3) so user-origin
    // injections land first; both run before discipline-layer hooks.
    priority: 4,
    blocking: false,
    handler: async (args, ctx: HookContext) => {
      try {
        const drained = opts.agent.drainForSession(ctx.sessionKey);
        if (drained.length === 0) return { action: "continue" };

        const message = buildNotificationMessage(drained);
        if (!message) return { action: "continue" };

        ctx.log("info", "[inline-task-notifier] injected notifications", {
          count: drained.length,
          iteration: args.iteration,
        });

        ctx.emit({
          type: "task_notification_injected",
          count: drained.length,
          iteration: args.iteration,
        } as never);

        return {
          action: "replace",
          value: {
            ...args,
            messages: [...args.messages, message],
          },
        };
      } catch (err) {
        ctx.log(
          "warn",
          "[inline-task-notifier] drain failed; turn continues",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return { action: "continue" };
      }
    },
  };
}
