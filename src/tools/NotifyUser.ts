/**
 * NotifyUser — out-of-band push notification tool.
 * Design reference: §7.14 Push notifications.
 *
 * Sends a notification to the bot's owner (userId) across all their
 * registered push channels (web, mobile, telegram). Delegates all
 * fanout + VAPID/Expo/Telegram transport to chat-proxy's
 * `/v1/internal/push/:userId` broker endpoint.
 *
 * Typical use:
 *   - After a long-running turn finishes (§7.10 long-running semantic).
 *   - After a SpawnAgent(deliver=background) child commits.
 *   - From a cron/scheduled run that wants to surface results even when
 *     the chat UI isn't open.
 *
 * Permission class: `net` — single outbound POST, no filesystem/shell.
 */
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { errorResult } from "../util/toolResult.js";

export interface NotifyUserInput {
  title: string;
  body?: string;
  url?: string;
  channels?: Array<"web" | "mobile" | "telegram">;
  metadata?: Record<string, unknown>;
}

export interface NotifyUserOutput {
  delivered: { web: number; mobile: number; telegram: number };
  failed: Array<{ channel: string; id?: string; error: string }>;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Notification headline (<=200 chars)." },
    body: { type: "string", description: "Notification body (<=2000 chars)." },
    url: {
      type: "string",
      description:
        "Optional deep-link path (e.g. /dashboard/<botId>/chat#ctx:turn). Tapped by the client to focus the originating turn.",
    },
    channels: {
      type: "array",
      description:
        "Restrict fanout to these channels. Default: all channels the user has subscribed on.",
      items: { type: "string", enum: ["web", "mobile", "telegram"] },
    },
    metadata: {
      type: "object",
      description: "Arbitrary JSON stored alongside the notification log row.",
    },
  },
  required: ["title"],
} as const;

export interface NotifyUserDeps {
  chatProxyUrl: string;
  gatewayToken: string;
  userId: string;
  fetchImpl?: typeof fetch;
}

export function makeNotifyUserTool(
  deps: NotifyUserDeps,
): Tool<NotifyUserInput, NotifyUserOutput> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    name: "NotifyUser",
    description:
      "Send an out-of-band push notification to the bot's owner (web / mobile / telegram). Use this to surface results of long-running or background turns when the chat UI may not be open. `title` is required; `body` and `url` are optional. `channels` restricts fanout; omit to use all subscribed channels.",
    inputSchema: INPUT_SCHEMA,
    permission: "net",
    async execute(
      input: NotifyUserInput,
      ctx: ToolContext,
    ): Promise<ToolResult<NotifyUserOutput>> {
      const start = Date.now();
      try {
        if (!input || typeof input.title !== "string" || !input.title.trim()) {
          return {
            status: "error",
            errorCode: "bad_input",
            errorMessage: "`title` is required",
            durationMs: Date.now() - start,
          };
        }
        if (!deps.userId) {
          return {
            status: "error",
            errorCode: "no_user",
            errorMessage: "agent has no userId configured",
            durationMs: Date.now() - start,
          };
        }
        const body: Record<string, unknown> = { title: input.title };
        if (input.body !== undefined) body.body = input.body;
        if (input.url !== undefined) body.url = input.url;
        if (input.channels) body.channels = input.channels;
        if (input.metadata) body.metadata = input.metadata;

        const urlStr = `${deps.chatProxyUrl.replace(/\/$/, "")}/v1/internal/push/${encodeURIComponent(deps.userId)}`;
        const resp = await fetchImpl(urlStr, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deps.gatewayToken}`,
          },
          body: JSON.stringify(body),
          signal: ctx.abortSignal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          return {
            status: "error",
            errorCode: `http_${resp.status}`,
            errorMessage: text.slice(0, 500) || `HTTP ${resp.status}`,
            durationMs: Date.now() - start,
          };
        }
        const json = (await resp.json()) as NotifyUserOutput;
        return {
          status: "ok",
          output: json,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
