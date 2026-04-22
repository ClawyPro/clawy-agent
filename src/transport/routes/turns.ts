/**
 * Turn routes:
 *   POST /v1/chat/completions         — start a streaming turn (SSE).
 *   POST /v1/turns/:turnId/ask-response — resolve a pending
 *     AskUserQuestion call for a running turn.
 *
 * Both routes bearer-gate via `Authorization: Bearer <token>` (not the
 * `X-Gateway-Token` header used by audit/compliance/session/contexts).
 * Behaviour preserved verbatim from the pre-split HttpServer.ts.
 */

import {
  authorizeBearer,
  readJsonBody,
  route,
  writeJson,
  type HttpServerCtx,
  type RouteHandler,
} from "./_helpers.js";
import { SseWriter } from "../SseWriter.js";
import { applyResetToSessionKey } from "../../slash/resetCounters.js";
import type {
  ChannelRef,
  ImageContentBlock,
  ReplyToRef,
  UserMessage,
  UserMessageMetadata,
} from "../../util/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Parse an optional `replyTo` descriptor off the chat/completions
 * request body. Validates structurally (object with string fields +
 * role ∈ {user, assistant}) and drops silently on any mismatch so a
 * malformed field never fails the turn — the reply preamble is a
 * best-effort hint, not a contract.
 */
export function extractReplyTo(body: unknown): ReplyToRef | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { replyTo?: unknown }).replyTo;
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as {
    messageId?: unknown;
    preview?: unknown;
    role?: unknown;
  };
  if (typeof obj.messageId !== "string" || obj.messageId.length === 0) {
    return undefined;
  }
  if (typeof obj.preview !== "string") return undefined;
  if (obj.role !== "user" && obj.role !== "assistant") return undefined;
  return {
    messageId: obj.messageId,
    preview: obj.preview,
    role: obj.role,
  };
}

/**
 * Supported Anthropic vision media types. chat-proxy sends OpenAI-style
 * `image_url` blocks with `data:<mime>;base64,...` URLs — we extract the
 * mime and base64 payload and convert to Anthropic native `image` blocks.
 */
const VISION_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function extractLastUserMessage(body: unknown): UserMessage | null {
  if (!body || typeof body !== "object") return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (!m || m.role !== "user") continue;

    let text = "";
    const imageBlocks: ImageContentBlock[] = [];

    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      const textParts: string[] = [];
      for (const block of m.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; image_url?: { url?: string } };

        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "image_url" && b.image_url?.url) {
          // chat-proxy sends: { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }
          // Convert to Anthropic native image block
          const dataMatch = b.image_url.url.match(
            /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/,
          );
          if (dataMatch) {
            const mediaType = dataMatch[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            if (VISION_MEDIA_TYPES.has(mediaType)) {
              imageBlocks.push({
                type: "image",
                source: { type: "base64", media_type: mediaType, data: dataMatch[2]! },
              });
            }
          }
        }
      }
      text = textParts.join("\n");
    }

    const replyTo = extractReplyTo(body);
    const metadata: UserMessageMetadata | undefined = replyTo
      ? { replyTo }
      : undefined;
    return {
      text,
      receivedAt: Date.now(),
      ...(imageBlocks.length > 0 ? { imageBlocks } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }
  return null;
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeBearer(req, res, ctx)) return;

  // Session key: OpenClaw convention used the X-Openclaw-Session-Key
  // header. Accept both that and a core-agent-native header so callers
  // can migrate at their own pace.
  const sessionKey =
    (req.headers["x-core-agent-session-key"] as string | undefined) ??
    (req.headers["x-openclaw-session-key"] as string | undefined) ??
    `agent:main:app:default:${ctx.agent.config.botId.slice(0, 8)}`;

  const body = await readJsonBody(req).catch((err: Error) => {
    writeJson(res, 400, { error: "bad_body", message: err.message });
    return null;
  });
  if (body === null) return;

  const userMsg = extractLastUserMessage(body);
  if (!userMsg) {
    writeJson(res, 400, { error: "no_user_message" });
    return;
  }

  const channel: ChannelRef = {
    type: "app",
    channelId:
      sessionKey.match(/^agent:[^:]+:[^:]+:([^:]+)/)?.[1] ?? "default",
  };
  // Apply any per-channel `/reset` counter. Counter == 0 leaves the
  // incoming sessionKey untouched (existing clients unaffected). Once
  // a user has run `/reset` the sessionKey picks up a `:<N>` suffix so
  // subsequent turns land in a fresh session namespace.
  const resetCounter = await ctx.agent.resetCounters.get(channel);
  const effectiveSessionKey = applyResetToSessionKey(sessionKey, resetCounter);
  const session = await ctx.agent.getOrCreateSession(effectiveSessionKey, channel);

  const sse = new SseWriter(res);
  sse.start();

  // If the client disconnects mid-turn, surface it as an abort signal.
  // The session mutex still holds the current turn to completion; Phase
  // 1b will wire this to an AbortController on the Turn itself.
  req.once("close", () => {
    if (!res.writableEnded) {
      // Client went away; we can stop writing but the turn itself
      // finishes on its own timeline.
    }
  });

  // Plan mode (§7.2) can be toggled via HTTP header. The Turn also
  // detects a `[PLAN_MODE: on]` marker embedded in the user text, so
  // clients that can't set headers (e.g. some channel relays) still
  // have a path.
  const planHeader = (req.headers["x-core-agent-plan-mode"] ?? "")
    .toString()
    .toLowerCase();
  const planMode =
    planHeader === "on" || planHeader === "1" || planHeader === "true";

  try {
    await session.runTurn(userMsg, sse, { planMode });
  } finally {
    sse.end();
  }
}

async function handleAskResponse(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeBearer(req, res, ctx)) return;
  const turnId = match[1] as string;
  const body = await readJsonBody(req).catch((err: Error) => {
    writeJson(res, 400, { error: "bad_body", message: err.message });
    return null;
  });
  if (body === null) return;
  const payload = body as {
    questionId?: unknown;
    selectedId?: unknown;
    freeText?: unknown;
  };
  if (typeof payload.questionId !== "string" || payload.questionId.length === 0) {
    writeJson(res, 400, { error: "missing_questionId" });
    return;
  }
  const turn = ctx.agent.getActiveTurn(turnId);
  if (!turn) {
    writeJson(res, 404, { error: "turn_not_found" });
    return;
  }
  const answer: { selectedId?: string; freeText?: string } = {};
  if (typeof payload.selectedId === "string") answer.selectedId = payload.selectedId;
  if (typeof payload.freeText === "string") answer.freeText = payload.freeText;
  if (answer.selectedId === undefined && answer.freeText === undefined) {
    writeJson(res, 400, { error: "empty_answer" });
    return;
  }
  const resolved = turn.resolveAsk(payload.questionId, answer);
  if (!resolved) {
    writeJson(res, 404, { error: "question_not_pending" });
    return;
  }
  writeJson(res, 200, { ok: true });
}

/**
 * POST /v1/chat/inject — queue a message to be absorbed into the next
 * LLM iteration of the currently-streaming turn (#86).
 *
 * 200 { injectionId, queuedCount }  on success
 * 404 { error: "session_not_found" } when no session matches the key
 * 409 { error: "no_active_turn" }    when the session has no streaming
 *                                     turn (caller should POST to
 *                                     /v1/chat/completions instead)
 * 429 { error: "queue_full" }        when MAX_PENDING_INJECTIONS hit
 *
 * Auth: same bearer-token gate as /v1/chat/completions.
 */
async function handleInject(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeBearer(req, res, ctx)) return;

  const body = await readJsonBody(req).catch((err: Error) => {
    writeJson(res, 400, { error: "bad_body", message: err.message });
    return null;
  });
  if (body === null) return;

  const payload = body as {
    sessionKey?: unknown;
    text?: unknown;
    source?: unknown;
  };
  if (typeof payload.sessionKey !== "string" || payload.sessionKey.length === 0) {
    writeJson(res, 400, { error: "missing_sessionKey" });
    return;
  }
  if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
    writeJson(res, 400, { error: "empty_text" });
    return;
  }
  const source =
    payload.source === "web" ||
    payload.source === "mobile" ||
    payload.source === "telegram" ||
    payload.source === "discord" ||
    payload.source === "api"
      ? payload.source
      : "api";

  const session = ctx.agent.getSession(payload.sessionKey);
  if (!session) {
    writeJson(res, 404, { error: "session_not_found" });
    return;
  }

  // "No active turn" = nothing currently streaming. Detected via the
  // agent's active-turn registry. If no turn is live for this session,
  // the client should POST /v1/chat/completions normally.
  if (!ctx.agent.hasActiveTurnForSession(payload.sessionKey)) {
    writeJson(res, 409, {
      error: "no_active_turn",
      hint: "POST /v1/chat/completions instead",
    });
    return;
  }

  const queued = session.injectMessage(payload.text, source);
  if (!queued) {
    writeJson(res, 429, {
      error: "queue_full",
      hint: "wait for the current turn to finish, then retry",
    });
    return;
  }

  writeJson(res, 200, queued);
}

export const turnsRoutes: RouteHandler[] = [
  route("POST", /^\/v1\/chat\/completions(?:\?.*)?$/, handleChatCompletions),
  route(
    "POST",
    /^\/v1\/turns\/([^/]+)\/ask-response$/,
    handleAskResponse,
  ),
  route("POST", /^\/v1\/chat\/inject$/, handleInject),
];
