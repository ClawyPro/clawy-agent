/**
 * GoogleProvider — streams completions via raw HTTP to the Google Gemini
 * `streamGenerateContent` API.
 *
 * Zero external dependencies. Converts Anthropic-format messages/tools
 * into Gemini format on the way in, and converts the chunked JSON
 * response back into the canonical `LLMEvent` stream on the way out.
 *
 * Gemini streaming uses `alt=sse` query parameter and returns SSE frames
 * where each `data:` line contains a `GenerateContentResponse` JSON object.
 *
 * Key conversions:
 *   - Anthropic `system` → Gemini `systemInstruction`
 *   - Anthropic `LLMToolDef` → Gemini `tools[].functionDeclarations`
 *   - Anthropic content blocks → Gemini `parts` (text / functionCall / functionResponse)
 *   - Gemini `candidates[0].content.parts` → normalised `LLMEvent`
 */

import type { LLMProvider } from "../LLMProvider.js";
import type {
  LLMEvent,
  LLMStreamRequest,
  LLMMessage,
  LLMContentBlock,
  LLMToolDef,
  LLMUsage,
} from "../../transport/LLMClient.js";
import { getCapability } from "../modelCapabilities.js";
import { httpPost, consumeText, parseGenericSse } from "../sseUtils.js";

/** Configuration for the Google Gemini provider. */
export interface GoogleProviderOptions {
  /** Google AI API key. */
  apiKey: string;
  /** Override the base URL. Defaults to `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
  /** Default model when `LLMStreamRequest.model` is omitted. */
  defaultModel?: string;
  /** API version path segment. Defaults to `v1beta`. */
  apiVersion?: string;
  /** Request timeout in milliseconds. Defaults to 600 000 (10 min). */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_MODEL = "gemini-3.1-pro-preview";
const DEFAULT_API_VERSION = "v1beta";
const DEFAULT_TIMEOUT_MS = 600_000;

// ─── Gemini wire types (minimal, inline) ───────────────────────────

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: unknown } } }
  | { inlineData: { mimeType: string; data: string } };

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: object;
}

/**
 * Google Gemini streaming provider. Sends requests to the
 * `streamGenerateContent` endpoint and normalises the response
 * into the canonical `LLMEvent` stream.
 */
export class GoogleProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(opts: GoogleProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Stream a completion from Gemini's streamGenerateContent endpoint.
   *
   * Converts the Anthropic-format request to Gemini format, streams
   * the response, and converts each chunk back to `LLMEvent`.
   */
  async *stream(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void> {
    const model = req.model ?? this.defaultModel;

    const contents = convertMessages(req.messages);
    const systemInstruction = convertSystem(req.system);
    const tools = req.tools?.length ? convertTools(req.tools) : undefined;

    const requestBody: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens:
          req.max_tokens ?? (getCapability(model)?.maxOutputTokens ?? 8_192),
        temperature: req.temperature,
      },
    };

    if (systemInstruction) {
      requestBody.systemInstruction = systemInstruction;
    }

    if (tools) {
      requestBody.tools = [{ functionDeclarations: tools }];
    }

    const body = JSON.stringify(requestBody);

    // Gemini uses query-param API key and `alt=sse` for streaming
    const url =
      `${this.baseUrl}/${this.apiVersion}/models/${model}:streamGenerateContent` +
      `?key=${this.apiKey}&alt=sse`;

    const res = await httpPost({
      url,
      headers: {
        Accept: "text/event-stream",
      },
      body,
      timeoutMs: this.timeoutMs,
    });

    if (res.statusCode && res.statusCode >= 400) {
      const errBody = await consumeText(res);
      yield {
        kind: "error",
        code: `http_${res.statusCode}`,
        message: errBody.slice(0, 500) || `upstream ${res.statusCode}`,
      };
      return;
    }

    yield* this.parseGeminiSse(res);
  }

  /**
   * Parse Gemini SSE chunks into normalised `LLMEvent`s.
   *
   * Each SSE data frame is a `GenerateContentResponse`:
   * ```json
   * {
   *   "candidates": [{ "content": { "parts": [...], "role": "model" }, "finishReason": "STOP" }],
   *   "usageMetadata": { "promptTokenCount": N, "candidatesTokenCount": M }
   * }
   * ```
   */
  private async *parseGeminiSse(
    res: import("node:http").IncomingMessage,
  ): AsyncGenerator<LLMEvent, void, void> {
    let nextBlockIndex = 0;
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let finishReason: string | null = null;

    // Track which function calls we've started (by blockIndex)
    const emittedToolStarts = new Set<number>();

    for await (const payload of parseGenericSse(res)) {
      // ── Usage metadata ──
      const usageMeta = payload.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
        | undefined;
      if (usageMeta) {
        if (typeof usageMeta.promptTokenCount === "number")
          usage.inputTokens = usageMeta.promptTokenCount;
        if (typeof usageMeta.candidatesTokenCount === "number")
          usage.outputTokens = usageMeta.candidatesTokenCount;
      }

      // ── Candidates ──
      const candidates = payload.candidates as
        | Array<{
            content?: { parts?: Array<Record<string, unknown>>; role?: string };
            finishReason?: string;
          }>
        | undefined;

      if (!candidates?.length) continue;
      const candidate = candidates[0];

      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
      }

      const parts = candidate?.content?.parts;
      if (!parts) continue;

      for (const part of parts) {
        // ── Text part ──
        if (typeof part.text === "string" && part.text) {
          const blockIndex = nextBlockIndex++;
          yield { kind: "text_delta", blockIndex, delta: part.text as string };
          yield { kind: "block_stop", blockIndex };
        }

        // ── Function call part ──
        const fc = part.functionCall as
          | { name?: string; args?: Record<string, unknown> }
          | undefined;
        if (fc?.name) {
          const blockIndex = nextBlockIndex++;
          const toolId = `gemini_call_${blockIndex}`;
          yield {
            kind: "tool_use_start",
            blockIndex,
            id: toolId,
            name: fc.name,
          };
          // Gemini delivers function args as a complete object (not streamed)
          yield {
            kind: "tool_use_input_delta",
            blockIndex,
            partial: JSON.stringify(fc.args ?? {}),
          };
          yield { kind: "block_stop", blockIndex };
          emittedToolStarts.add(blockIndex);
        }
      }
    }

    // Map Gemini finishReason → canonical stopReason
    const stopReason = mapGeminiFinishReason(finishReason);
    yield { kind: "message_end", stopReason, usage };
  }
}

// ─── Format conversion helpers ─────────────────────────────────────

/**
 * Convert Anthropic system prompt to Gemini systemInstruction.
 */
function convertSystem(
  system: LLMStreamRequest["system"],
): { parts: Array<{ text: string }> } | undefined {
  if (!system) return undefined;
  const text =
    typeof system === "string"
      ? system
      : system.map((b) => b.text).join("\n");
  return { parts: [{ text }] };
}

/**
 * Convert Anthropic-format messages to Gemini contents array.
 */
function convertMessages(messages: LLMMessage[]): GeminiContent[] {
  const result: GeminiContent[] = [];

  for (const msg of messages) {
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";

    if (typeof msg.content === "string") {
      result.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          parts.push({ text: block.text });
          break;

        case "image":
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data,
            },
          });
          break;

        case "tool_use":
          parts.push({
            functionCall: {
              name: block.name,
              args: (typeof block.input === "object" && block.input !== null
                ? block.input
                : {}) as Record<string, unknown>,
            },
          });
          break;

        case "tool_result": {
          const content =
            typeof block.content === "string"
              ? block.content
              : block.content.map((c) => c.text).join("\n");
          // We need the tool name for functionResponse, but tool_result
          // only has tool_use_id. Use a placeholder name — Gemini matches
          // by position in the conversation, not by call ID.
          parts.push({
            functionResponse: {
              name: block.tool_use_id,
              response: { result: content },
            },
          });
          break;
        }

        case "thinking":
          // Anthropic-specific; omit for Gemini
          break;

        default:
          break;
      }
    }

    if (parts.length > 0) {
      result.push({ role, parts });
    }
  }

  return result;
}

/**
 * Convert Anthropic tool definitions to Gemini function declarations.
 */
function convertTools(tools: LLMToolDef[]): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

/**
 * Map Gemini finishReason to our canonical stop reason.
 */
function mapGeminiFinishReason(
  reason: string | null,
): "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "refusal" | "pause_turn" | null {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
      return "refusal";
    case "TOOL_USE":
      return "tool_use";
    default:
      return null;
  }
}
