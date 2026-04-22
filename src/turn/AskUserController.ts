/**
 * AskUserController — per-turn askUser surface.
 *
 * Extracted from Turn (R3 refactor, 2026-04-19). Owns the pendingAsks
 * map + resolve/reject API consumed by Tool hooks that need the human.
 */

import type { SseWriter } from "../transport/SseWriter.js";
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
} from "../Tool.js";

interface PendingAsk {
  resolve(answer: AskUserQuestionOutput): void;
  reject(err: Error): void;
}

export class AskUserController {
  private readonly pending = new Map<string, PendingAsk>();
  private seq = 0;

  constructor(
    private readonly turnId: string,
    private readonly sse: SseWriter,
  ) {}

  /** Tool-facing: emit ask_user AgentEvent + await the response. */
  ask(input: AskUserQuestionInput): Promise<AskUserQuestionOutput> {
    this.seq += 1;
    const questionId = `${this.turnId}:ask:${this.seq}`;
    return new Promise<AskUserQuestionOutput>((resolve, reject) => {
      this.pending.set(questionId, { resolve, reject });
      this.sse.agent({
        type: "ask_user",
        questionId,
        question: input.question,
        choices: input.choices.map((c) => ({
          id: c.id,
          label: c.label,
          ...(c.description !== undefined ? { description: c.description } : {}),
        })),
        ...(input.allowFreeText !== undefined
          ? { allowFreeText: input.allowFreeText }
          : {}),
      });
    });
  }

  /** Client → runtime: resolve a pending askUser. Returns true if matched. */
  resolve(questionId: string, answer: AskUserQuestionOutput): boolean {
    const p = this.pending.get(questionId);
    if (!p) return false;
    this.pending.delete(questionId);
    p.resolve(answer);
    return true;
  }

  /** Abort path: reject every pending ask so tools unblock. */
  rejectAll(reason: string): void {
    for (const [id, p] of this.pending) {
      p.reject(new Error(`ask_user rejected: ${reason}`));
      this.pending.delete(id);
    }
  }
}
