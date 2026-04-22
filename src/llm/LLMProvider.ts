/**
 * LLMProvider — common interface for multi-provider LLM streaming.
 *
 * Every provider (Anthropic, OpenAI, Google) implements this interface
 * so the agent loop can swap backends without changing any call-site.
 * All providers normalise their wire format into the existing `LLMEvent`
 * type defined in `src/transport/LLMClient.ts`.
 */

import type { LLMEvent, LLMStreamRequest } from "../transport/LLMClient.js";

/**
 * A streaming LLM provider. Implementations MUST normalise their native
 * SSE / chunked-transfer format into the canonical `LLMEvent` stream so
 * callers are provider-agnostic.
 */
export interface LLMProvider {
  /**
   * Open a streaming completion and yield normalised events until the
   * upstream server closes the stream, errors, or the message ends.
   */
  stream(req: LLMStreamRequest): AsyncGenerator<LLMEvent, void, void>;
}
