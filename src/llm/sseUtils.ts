/**
 * sseUtils — shared SSE parsing and HTTP helpers for LLM providers.
 *
 * Extracted from the original LLMClient.ts so every provider can reuse
 * the Anthropic SSE parser and common HTTP plumbing without duplication.
 * Zero external dependencies — uses only Node.js built-ins.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { LLMEvent, LLMUsage } from "../transport/LLMClient.js";

/** Options for {@link httpPost}. */
export interface HttpPostOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}

/**
 * Fire an HTTPS (or HTTP) POST and return the raw IncomingMessage.
 * Rejects on network error or timeout.
 */
export function httpPost(opts: HttpPostOptions): Promise<http.IncomingMessage> {
  const url = new URL(opts.url);
  const lib = url.protocol === "https:" ? https : http;
  const reqOptions: http.RequestOptions = {
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(opts.body),
      ...opts.headers,
    },
    timeout: opts.timeoutMs ?? 600_000,
  };

  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const r = lib.request(reqOptions, resolve);
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("LLM provider timeout")));
    r.write(opts.body);
    r.end();
  });
}

/**
 * Consume the full response body as a UTF-8 string (used on error paths).
 */
export async function consumeText(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse an Anthropic `/v1/messages` SSE stream into normalised LLMEvents.
 *
 * Anthropic SSE frame shape:
 *   event: message_start        → usage
 *   event: content_block_start  → tool_use_start
 *   event: content_block_delta  → text_delta / thinking_delta / signature_delta / input_json_delta
 *   event: content_block_stop   → block_stop
 *   event: message_delta        → stop_reason + usage
 *   event: message_stop         → message_end
 *   event: error                → error
 */
export async function* parseAnthropicSse(
  res: http.IncomingMessage,
): AsyncGenerator<LLMEvent, void, void> {
  let buffer = "";
  let currentEvent = "";
  type StopReason =
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "stop_sequence"
    | "refusal"
    | "pause_turn"
    | null;
  let stopReason: StopReason = null;
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  for await (const chunk of res) {
    buffer += (chunk as Buffer).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line === "") {
        currentEvent = "";
        continue;
      }
      if (line.startsWith(":")) continue; // SSE comment
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(dataStr);
      } catch {
        continue;
      }

      switch (currentEvent) {
        case "message_start": {
          const msg = (payload as { message?: { usage?: Partial<LLMUsage> } }).message;
          const u = msg?.usage;
          if (u) {
            usage = {
              inputTokens:
                (u as { input_tokens?: number }).input_tokens ?? usage.inputTokens,
              outputTokens:
                (u as { output_tokens?: number }).output_tokens ?? usage.outputTokens,
            };
          }
          break;
        }
        case "content_block_start": {
          const idx = (payload as { index?: number }).index ?? 0;
          const block = (
            payload as { content_block?: { type?: string; id?: string; name?: string } }
          ).content_block;
          if (block?.type === "tool_use" && block.id && block.name) {
            yield {
              kind: "tool_use_start",
              blockIndex: idx,
              id: block.id,
              name: block.name,
            };
          }
          break;
        }
        case "content_block_delta": {
          const idx = (payload as { index?: number }).index ?? 0;
          const delta = (payload as { delta?: Record<string, unknown> }).delta;
          if (!delta) break;
          const t = (delta as { type?: string }).type;
          if (t === "text_delta") {
            const text = (delta as { text?: string }).text ?? "";
            if (text) yield { kind: "text_delta", blockIndex: idx, delta: text };
          } else if (t === "thinking_delta") {
            const text = (delta as { thinking?: string }).thinking ?? "";
            if (text) yield { kind: "thinking_delta", blockIndex: idx, delta: text };
          } else if (t === "signature_delta") {
            const sig = (delta as { signature?: string }).signature ?? "";
            if (sig) yield { kind: "thinking_signature", blockIndex: idx, signature: sig };
          } else if (t === "input_json_delta") {
            const partial = (delta as { partial_json?: string }).partial_json ?? "";
            yield { kind: "tool_use_input_delta", blockIndex: idx, partial };
          }
          break;
        }
        case "content_block_stop": {
          const idx = (payload as { index?: number }).index ?? 0;
          yield { kind: "block_stop", blockIndex: idx };
          break;
        }
        case "message_delta": {
          const delta = (payload as { delta?: { stop_reason?: string } }).delta;
          if (delta?.stop_reason) {
            stopReason = delta.stop_reason as StopReason;
          }
          const u = (
            payload as { usage?: { output_tokens?: number; input_tokens?: number } }
          ).usage;
          if (u) {
            if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
            if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
          }
          break;
        }
        case "message_stop": {
          yield { kind: "message_end", stopReason: stopReason ?? "end_turn", usage };
          return;
        }
        case "error": {
          const err = (payload as { error?: { type?: string; message?: string } }).error;
          yield {
            kind: "error",
            code: err?.type ?? "upstream_error",
            message: err?.message ?? "unknown",
          };
          return;
        }
        default:
          break;
      }
    }
  }

  // Fallthrough — stream closed without message_stop
  yield { kind: "message_end", stopReason: stopReason ?? null, usage };
}

/**
 * Parse a generic SSE stream (OpenAI / others) that uses `data: {...}\n\n`
 * framing. Yields parsed JSON payloads. Stops on `[DONE]` sentinel.
 */
export async function* parseGenericSse(
  res: http.IncomingMessage,
): AsyncGenerator<Record<string, unknown>, void, void> {
  let buffer = "";

  for await (const chunk of res) {
    buffer += (chunk as Buffer).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line === "" || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        yield JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        // skip malformed JSON
      }
    }
  }
}
