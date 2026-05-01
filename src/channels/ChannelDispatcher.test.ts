import { describe, it, expect, vi } from "vitest";
import { dispatchInbound } from "./ChannelDispatcher.js";
import type { Agent } from "../Agent.js";
import type { ChannelAdapter, InboundMessage } from "./ChannelAdapter.js";
import type { UserMessage } from "../util/types.js";

describe("dispatchInbound", () => {
  it("passes downloaded inbound attachments into the Session turn", async () => {
    let capturedMessage: UserMessage | null = null;
    const agent = {
      resetCounters: {
        get: vi.fn(async () => 0),
      },
      getOrCreateSession: vi.fn(async () => ({
        runTurn: vi.fn(async (message: UserMessage) => {
          capturedMessage = message;
        }),
      })),
    } as unknown as Agent;
    const adapter = {
      kind: "telegram",
      sendTyping: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      onInboundMessage: vi.fn(),
      sendDocument: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    } satisfies ChannelAdapter;
    const inbound: InboundMessage = {
      channel: "telegram",
      chatId: "chat-1",
      userId: "user-1",
      text: "",
      messageId: "msg-1",
      attachments: [
        {
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          localPath: "/workspace/telegram-downloads/report.pdf",
          sizeBytes: 123,
        },
      ],
      raw: {},
    };

    await dispatchInbound(agent, adapter, inbound);

    expect(capturedMessage?.attachments).toEqual(inbound.attachments);
  });
});
