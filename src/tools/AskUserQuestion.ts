/**
 * AskUserQuestion — blocks the turn, emits an `ask_user` AgentEvent,
 * and waits for the client to POST a response back via
 *   POST /v1/turns/:turnId/ask-response
 * Design reference: §7.5.
 *
 * The tool returns `{selectedId?, freeText?}` once resolved, or aborts
 * with status:"aborted" after a timeout (default 300s).
 */

import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  Tool,
  ToolContext,
  ToolResult,
} from "../Tool.js";
import { errorResult } from "../util/toolResult.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      minLength: 1,
      description: "The prompt shown to the user.",
    },
    choices: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          description: { type: "string" },
        },
        required: ["id", "label"],
      },
      description: "Discrete options the user can select.",
    },
    allowFreeText: {
      type: "boolean",
      description: "If true, the UI exposes a free-text input alongside choices.",
    },
  },
  required: ["question", "choices"],
} as const;

export interface AskUserQuestionToolOptions {
  /** Override the per-call timeout. Defaults to 300_000 ms. */
  timeoutMs?: number;
}

export function makeAskUserQuestionTool(
  options: AskUserQuestionToolOptions = {},
): Tool<AskUserQuestionInput, AskUserQuestionOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: "AskUserQuestion",
    description:
      "Ask the human user a multiple-choice question (optionally allowing a free-text fallback). The turn is paused until the client answers or the 5-minute timeout elapses. Use this when you genuinely need a human decision that cannot be inferred from context.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    validate(input) {
      if (!input || typeof input.question !== "string" || input.question.length === 0) {
        return "`question` is required";
      }
      if (!Array.isArray(input.choices) || input.choices.length === 0) {
        return "`choices` must be a non-empty array";
      }
      const ids = new Set<string>();
      for (const c of input.choices) {
        if (!c || typeof c.id !== "string" || typeof c.label !== "string") {
          return "each choice must have string `id` and `label`";
        }
        if (ids.has(c.id)) return `duplicate choice id: ${c.id}`;
        ids.add(c.id);
      }
      return null;
    },
    async execute(
      input: AskUserQuestionInput,
      ctx: ToolContext,
    ): Promise<ToolResult<AskUserQuestionOutput>> {
      const start = Date.now();
      try {
        const answer = await withTimeout(
          ctx.askUser(input),
          timeoutMs,
          ctx.abortSignal,
        );
        if (answer === "__timeout__") {
          return {
            status: "aborted",
            errorCode: "ask_user_timeout",
            errorMessage: `no response within ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          };
        }
        if (answer === "__aborted__") {
          return {
            status: "aborted",
            errorCode: "ask_user_aborted",
            errorMessage: "turn aborted while waiting for user response",
            durationMs: Date.now() - start,
          };
        }
        return {
          status: "ok",
          output: {
            ...(answer.selectedId !== undefined ? { selectedId: answer.selectedId } : {}),
            ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
          },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}

type TimeoutResult<T> = T | "__timeout__" | "__aborted__";

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<TimeoutResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await new Promise<TimeoutResult<T>>((resolve, reject) => {
      timer = setTimeout(() => resolve("__timeout__"), ms);
      abortListener = (): void => resolve("__aborted__");
      if (signal.aborted) {
        resolve("__aborted__");
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
      promise.then(
        (value) => resolve(value),
        (err) => reject(err),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}
