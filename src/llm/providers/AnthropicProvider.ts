/**
 * AnthropicProvider — streams completions via raw HTTP to the Anthropic
 * Messages API (`/v1/messages`).
 *
 * Zero external dependencies. Reuses the shared `parseAnthropicSse`
 * parser so the wire-format logic lives in one place.
 *
 * Usage:
 * ```ts
 * const provider = new AnthropicProvider({ apiKey: "sk-ant-..." });
 * for await (const evt of provider.stream({ messages, tools })) { ... }
 * ```
 */

import type { LLMProvider } from "../LLMProvider.js";
import type { LLMEvent, LLMStreamRequest } from "../../transport/LLMClient.js";
import { shouldEnableThinkingByDefault, getCapability } from "../modelCapabilities.js";
import { httpPost, consumeText, parseAnthropicSse } from "../sseUtils.js";

/** Configuration for the Anthropic provider. */
export interface AnthropicProviderOptions {
  /** Anthropic API key (sk-ant-...). */
  apiKey: string;
  /** Override the base URL (e.g. for proxies). Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** Default model when `LLMStreamRequest.model` is omitted. */
  defaultModel?: string;
  /** Anthropic-Version header. Defaults to `2023-06-01`. */
  anthropicVersion?: string;
  /** Request timeout in milliseconds. Defaults to 600 000 (10 min). */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Anthropic streaming provider. Sends requests to the Anthropic Messages
 * API and normalises the SSE response into the canonical `LLMEvent` stream.
 */
export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly anthropicVersion: string;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_VERSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Stream a completion from Anthropic's Messages API.
   *
   * The request body is sent in Anthropic's native format — no conversion
   * needed since our internal types already mirror it.
   */
  async *stream(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void> {
    const model = req.model ?? this.defaultModel;

    // Gate thinking on model capability (T4-17).
    const thinking =
      req.thinking ??
      (shouldEnableThinkingByDefault(model)
        ? ({ type: "adaptive" } as const)
        : undefined);

    const body = JSON.stringify({
      model,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      max_tokens:
        req.max_tokens ??
        (thinking
          ? (getCapability(model)?.maxOutputTokens ?? 16_000)
          : (getCapability(model)?.maxOutputTokens ?? 8_192)),
      temperature: req.temperature,
      ...(thinking ? { thinking } : {}),
      stream: true,
    });

    const res = await httpPost({
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
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

    for await (const evt of parseAnthropicSse(res)) yield evt;
  }
}
