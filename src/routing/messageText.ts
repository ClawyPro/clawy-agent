import type { LLMMessage } from "../transport/LLMClient.js";

export function extractLatestUserText(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== "user") continue;

    if (typeof msg.content === "string") return msg.content.slice(0, 2_000);

    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block): block is { type: "text"; text: string } =>
          block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
        .slice(0, 2_000);
    }
  }
  return "";
}

export function messagesHaveImages(messages: LLMMessage[]): boolean {
  return messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some((block) => block.type === "image"),
  );
}
