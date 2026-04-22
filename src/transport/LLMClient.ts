/**
 * LLMClient — thin streaming client for the agent loop.
 *
 * Design reference: §5.3, §9.2.
 *
 * Phase 1b: Anthropic `/v1/messages` streaming with tool_use content
 * blocks. Parses the SSE wire format into a normalised event stream
 * consumed by Turn.execute's agent loop.
 *
 * Phase 2: Multi-provider support via `LLMProvider` interface. The
 * class now delegates streaming to a pluggable provider while keeping
 * the existing constructor and `stream()` signature fully backward
 * compatible. Use `LLMClient.fromProvider()` to create an instance
 * backed by any provider (Anthropic, OpenAI, Google).
 *
 * We do NOT use official SDKs — a zero-dep fetcher + SSE parser stays
 * honest about exactly what flows over the wire and what the loop
 * depends on.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { shouldEnableThinkingByDefault, getCapability } from "../llm/modelCapabilities.js";
import type { LLMProvider } from "../llm/LLMProvider.js";
import { parseAnthropicSse, consumeText } from "../llm/sseUtils.js";

export interface LLMClientOptions {
  apiProxyUrl: string; // e.g. http://api-proxy.clawy-system.svc.cluster.local:3001
  gatewayToken: string; // used as x-api-key to api-proxy
  defaultModel: string;
  anthropicVersion?: string; // default 2023-06-01
  timeoutMs?: number; // default 600_000
}

export type LLMRole = "user" | "assistant";

export type LLMContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | Array<{ type: "text"; text: string }>;
      is_error?: boolean;
    };

export interface LLMMessage {
  role: LLMRole;
  content: string | LLMContentBlock[];
}

export interface LLMToolDef {
  name: string;
  description: string;
  input_schema: object;
}

export interface LLMStreamRequest {
  model?: string;
  system?: string | Array<{ type: "text"; text: string }>;
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  max_tokens?: number;
  temperature?: number;
  /** Adaptive thinking for opus-4-7 etc. Pass `{ type: "adaptive" }` to enable. */
  thinking?: { type: "adaptive" } | { type: "disabled" };
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LLMEvent =
  /** Accumulating text block. */
  | { kind: "text_delta"; blockIndex: number; delta: string }
  /** Accumulating thinking block (Anthropic extended thinking). */
  | { kind: "thinking_delta"; blockIndex: number; delta: string }
  /** Thinking block signature (required for replay in subsequent API calls). */
  | { kind: "thinking_signature"; blockIndex: number; signature: string }
  /** Tool use block announced — id + name known, input being streamed in chunks. */
  | { kind: "tool_use_start"; blockIndex: number; id: string; name: string }
  /** input_json delta (partial JSON fragment). */
  | { kind: "tool_use_input_delta"; blockIndex: number; partial: string }
  /** Content block ended; final input is available for tool_use blocks. */
  | { kind: "block_stop"; blockIndex: number }
  /** Whole message ended. */
  | {
      kind: "message_end";
      stopReason:
        | "end_turn"
        | "tool_use"
        | "max_tokens"
        | "stop_sequence"
        | "refusal"
        | "pause_turn"
        | null;
      usage: LLMUsage;
    }
  | { kind: "error"; code: string; message: string };

export class LLMClient {
  private readonly opts: Required<Pick<LLMClientOptions, "anthropicVersion" | "timeoutMs">> &
    LLMClientOptions;
  private readonly provider: LLMProvider | null;

  /**
   * Create an LLMClient backed by the Clawy api-proxy infrastructure.
   * This is the original constructor — fully backward compatible.
   */
  constructor(options: LLMClientOptions) {
    this.opts = {
      anthropicVersion: "2023-06-01",
      timeoutMs: 600_000,
      ...options,
    };
    this.provider = null;
  }

  /**
   * Create an LLMClient backed by any `LLMProvider` implementation
   * (Anthropic direct, OpenAI, Google, or custom).
   *
   * ```ts
   * import { createProvider } from "../llm/createProvider.js";
   * const provider = createProvider({ provider: "openai", apiKey: "sk-..." });
   * const client = LLMClient.fromProvider(provider);
   * ```
   */
  static fromProvider(provider: LLMProvider): LLMClient {
    // Create with dummy options; the provider will handle everything.
    const client = new LLMClient({
      apiProxyUrl: "http://unused",
      gatewayToken: "unused",
      defaultModel: "unused",
    });
    // Override the provider field via Object.defineProperty to bypass readonly
    (client as unknown as { provider: LLMProvider | null }).provider = provider;
    return client;
  }

  /**
   * Stream a single completion call. Yields normalised LLMEvents
   * until the upstream server closes the stream or errors.
   *
   * If an `LLMProvider` is set (via `fromProvider`), delegates to it.
   * Otherwise falls back to the legacy api-proxy HTTP path.
   *
   * The caller is responsible for accumulating tool_use input fragments
   * (via `tool_use_input_delta`) and materialising the final structured
   * input when `block_stop` arrives for that block.
   */
  async *stream(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void> {
    if (this.provider) {
      yield* this.provider.stream(req);
      return;
    }

    // ── Legacy api-proxy path (backward compatible) ──
    yield* this.streamLegacy(req);
  }

  /**
   * Original api-proxy streaming implementation, preserved for backward
   * compatibility with existing Clawy infrastructure deployments.
   */
  private async *streamLegacy(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void> {
    const model = req.model ?? this.opts.defaultModel;
    // T4-17: gate thinking on model capability.
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
      max_tokens: req.max_tokens ?? (thinking ? (getCapability(model)?.maxOutputTokens ?? 16_000) : (getCapability(model)?.maxOutputTokens ?? 8_192)),
      temperature: req.temperature,
      ...(thinking ? { thinking } : {}),
      stream: true,
    });

    const url = new URL("/v1/messages", this.opts.apiProxyUrl);
    const lib = url.protocol === "https:" ? https : http;
    const reqOptions: http.RequestOptions = {
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": this.opts.gatewayToken,
        "anthropic-version": this.opts.anthropicVersion,
        Accept: "text/event-stream",
      },
      timeout: this.opts.timeoutMs,
    };

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = lib.request(reqOptions, resolve);
      r.on("error", reject);
      r.on("timeout", () => r.destroy(new Error("api-proxy timeout")));
      r.write(body);
      r.end();
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
