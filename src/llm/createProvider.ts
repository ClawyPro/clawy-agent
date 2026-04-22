/**
 * createProvider — factory function for multi-provider LLM instantiation.
 *
 * Returns an `LLMProvider` for the requested backend so callers can
 * switch between Anthropic, OpenAI, and Google without importing
 * concrete classes.
 *
 * ```ts
 * const provider = createProvider({
 *   provider: "openai",
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   defaultModel: "gpt-5.4",
 * });
 * for await (const evt of provider.stream({ messages })) { ... }
 * ```
 */

import type { LLMProvider } from "./LLMProvider.js";
import { AnthropicProvider } from "./providers/AnthropicProvider.js";
import { OpenAIProvider } from "./providers/OpenAIProvider.js";
import { GoogleProvider } from "./providers/GoogleProvider.js";

/** Provider configuration passed to {@link createProvider}. */
export interface ProviderConfig {
  /** Which LLM backend to use. */
  provider: "anthropic" | "openai" | "google";
  /** API key for the chosen provider. */
  apiKey: string;
  /** Override the provider's default base URL (e.g. for proxies or Azure). */
  baseUrl?: string;
  /** Default model when `LLMStreamRequest.model` is omitted. */
  defaultModel?: string;
  /** Request timeout in milliseconds. Defaults to 600 000 (10 min). */
  timeoutMs?: number;
}

/**
 * Create an `LLMProvider` for the given configuration.
 *
 * @throws {Error} If the provider name is not recognised.
 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
        timeoutMs: config.timeoutMs,
      });

    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
        timeoutMs: config.timeoutMs,
      });

    case "google":
      return new GoogleProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
        timeoutMs: config.timeoutMs,
      });

    default:
      throw new Error(
        `Unknown LLM provider: "${(config as { provider: string }).provider}". ` +
          `Supported providers: anthropic, openai, google.`,
      );
  }
}
