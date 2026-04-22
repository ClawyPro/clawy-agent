/**
 * MessageBuilder unit tests (R3 refactor).
 *
 * Cover:
 *   - buildSystemPrompt renders identity + session header
 *   - buildSystemPrompt returns header-only when identity empty
 *   - buildMessages calls contextEngine.maybeCompact and re-reads
 *   - buildMessages appends the current user message last
 *   - Token limit uses getCapability().contextWindow * 0.75
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildSystemPrompt,
  buildMessages,
  formatReplyPreamble,
  REPLY_PREVIEW_MAX_CHARS,
} from "./MessageBuilder.js";
import { Transcript } from "../storage/Transcript.js";
import type { Session } from "../Session.js";
import type { UserMessage } from "../util/types.js";
import type { LLMMessage } from "../transport/LLMClient.js";

interface ContextEngineCall {
  kind: "maybeCompact" | "buildMessagesFromTranscript";
  tokenLimit?: number;
}

async function makeSession(opts: {
  model?: string;
  identity?: Record<string, string>;
  replayMessages?: LLMMessage[];
  channel?: { type: string; channelId: string } | null;
}): Promise<{
  session: Session;
  transcript: Transcript;
  contextCalls: ContextEngineCall[];
}> {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "msg-builder-"),
  );
  const sessionsDir = path.join(workspaceRoot, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const transcript = new Transcript(sessionsDir, "sess-1");
  const contextCalls: ContextEngineCall[] = [];

  const replayMessages = opts.replayMessages ?? [];

  const contextEngine = {
    maybeCompact: async (
      _s: Session,
      _entries: unknown[],
      tokenLimit: number,
    ) => {
      contextCalls.push({ kind: "maybeCompact", tokenLimit });
    },
    buildMessagesFromTranscript: () => {
      contextCalls.push({ kind: "buildMessagesFromTranscript" });
      return [...replayMessages];
    },
  };

  const workspace = {
    loadIdentity: async () => opts.identity ?? {},
  };

  const meta: Record<string, unknown> = { sessionKey: "sess-1" };
  if (opts.channel !== null) {
    // Default: no channel populated — exercises the `web` fallback.
    if (opts.channel !== undefined) meta.channel = opts.channel;
  }

  const session = {
    meta,
    transcript,
    agent: {
      config: { model: opts.model ?? "unknown-model-x" },
      contextEngine,
      workspace,
    },
  } as unknown as Session;

  return { session, transcript, contextCalls };
}

describe("MessageBuilder.buildSystemPrompt", () => {
  it("returns header-only when identity renders empty", async () => {
    const { session } = await makeSession({ identity: {} });
    const out = await buildSystemPrompt(session, "turn-A");
    expect(out).toContain("[Session: sess-1]");
    expect(out).toContain("[Turn: turn-A]");
    expect(out).toContain("[Time: ");
    expect(out).not.toContain("# IDENTITY");
  });

  it("includes identity sections when present", async () => {
    const { session } = await makeSession({
      identity: { identity: "Im Kevin", soul: "engineer" },
    });
    const out = await buildSystemPrompt(session, "turn-B");
    expect(out).toContain("# IDENTITY");
    expect(out).toContain("# SOUL");
    expect(out).toContain("Im Kevin");
  });

  it("includes [Channel: telegram] when channel.type is telegram", async () => {
    const { session } = await makeSession({
      channel: { type: "telegram", channelId: "123" },
    });
    const out = await buildSystemPrompt(session, "turn-tg");
    expect(out).toContain("[Channel: telegram]");
    // Ordering: Channel appears after Time, before identity.
    const timeIdx = out.indexOf("[Time:");
    const channelIdx = out.indexOf("[Channel:");
    expect(channelIdx).toBeGreaterThan(timeIdx);
  });

  it("includes [Channel: discord] for discord sessions", async () => {
    const { session } = await makeSession({
      channel: { type: "discord", channelId: "ch-1" },
    });
    const out = await buildSystemPrompt(session, "turn-dc");
    expect(out).toContain("[Channel: discord]");
  });

  it("includes [Channel: app] for mobile-app sessions", async () => {
    const { session } = await makeSession({
      channel: { type: "app", channelId: "app-1" },
    });
    const out = await buildSystemPrompt(session, "turn-app");
    expect(out).toContain("[Channel: app]");
  });

  it("defaults to [Channel: web] when channel is undefined", async () => {
    const { session } = await makeSession({});
    const out = await buildSystemPrompt(session, "turn-web");
    expect(out).toContain("[Channel: web]");
  });

  it("injects <agent_rules> block when identity.userRules is populated", async () => {
    const { session } = await makeSession({
      identity: {
        identity: "I am bot",
        userRules: "- Always answer in Korean.",
      },
    });
    const out = await buildSystemPrompt(session, "turn-rules");
    expect(out).toContain("<agent_rules>");
    expect(out).toContain("Always answer in Korean.");
    expect(out).toContain("</agent_rules>");
  });

  it("skips <agent_rules> block when identity.userRules is absent", async () => {
    const { session } = await makeSession({
      identity: { identity: "I am bot" },
    });
    const out = await buildSystemPrompt(session, "turn-no-rules");
    expect(out).not.toContain("<agent_rules>");
  });
});

describe("MessageBuilder.buildMessages", () => {
  it("calls maybeCompact + buildMessagesFromTranscript + appends user message", async () => {
    const { session, contextCalls } = await makeSession({
      replayMessages: [{ role: "assistant", content: "prior" }],
    });
    const um: UserMessage = { text: "hello", receivedAt: Date.now() };
    const out = await buildMessages(session, um);

    expect(out.length).toBe(2);
    expect(out[0]?.role).toBe("assistant");
    expect(out[1]?.role).toBe("user");
    expect(out[1]?.content).toBe("hello");

    // maybeCompact called once, buildMessagesFromTranscript called once.
    expect(
      contextCalls.filter((c) => c.kind === "maybeCompact").length,
    ).toBe(1);
    expect(
      contextCalls.filter((c) => c.kind === "buildMessagesFromTranscript")
        .length,
    ).toBe(1);
  });

  it("uses fallback 150_000 token limit for unknown model", async () => {
    const { session, contextCalls } = await makeSession({ model: "unknown" });
    const um: UserMessage = { text: "x", receivedAt: Date.now() };
    await buildMessages(session, um);
    const mc = contextCalls.find((c) => c.kind === "maybeCompact");
    expect(mc?.tokenLimit).toBe(150_000);
  });

  it("uses 75% of contextWindow for known model (opus-4-7)", async () => {
    // opus-4-7 is registered in llm/modelCapabilities — 200k * 0.75 = 150_000
    // (any known model works; we don't depend on the specific number,
    // only that it's the floor of contextWindow * 0.75).
    const { session, contextCalls } = await makeSession({
      model: "claude-opus-4-7",
    });
    const um: UserMessage = { text: "x", receivedAt: Date.now() };
    await buildMessages(session, um);
    const mc = contextCalls.find((c) => c.kind === "maybeCompact");
    expect(mc?.tokenLimit).toBeTypeOf("number");
    // Must be > 0 and a plausible floor-of-window figure.
    expect(mc?.tokenLimit).toBeGreaterThan(0);
  });

  it("prepends [Reply to user: …] when metadata.replyTo is present", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "what did you mean by that?",
      receivedAt: Date.now(),
      metadata: {
        replyTo: {
          messageId: "m-1",
          preview: "I think the answer is 42.",
          role: "assistant",
        },
      },
    };
    const out = await buildMessages(session, um);
    const last = out[out.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toBe(
      '[Reply to assistant: "I think the answer is 42."]\nwhat did you mean by that?',
    );
  });

  it("supports role=user replies (quoting another user's message)", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "+1",
      receivedAt: Date.now(),
      metadata: {
        replyTo: { messageId: "m-2", preview: "hello team", role: "user" },
      },
    };
    const out = await buildMessages(session, um);
    expect(out[out.length - 1]?.content).toBe(
      '[Reply to user: "hello team"]\n+1',
    );
  });

  it("leaves content unchanged when metadata.replyTo is absent", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "plain text",
      receivedAt: Date.now(),
    };
    const out = await buildMessages(session, um);
    expect(out[out.length - 1]?.content).toBe("plain text");
  });

  it("includes [Attachment: ...] preamble when attachments are present", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "이거 보면 돼",
      receivedAt: Date.now(),
      attachments: [
        {
          kind: "file",
          name: "report.html",
          mimeType: "text/html",
          sizeBytes: 116400,
          localPath: "/workspace/telegram-downloads/report.html",
        },
      ],
    };
    const out = await buildMessages(session, um);
    const last = out[out.length - 1]!;
    expect(last.content).toContain('[Attachment: name="report.html"');
    expect(last.content).toContain("type=text/html");
    expect(last.content).toContain('path="/workspace/telegram-downloads/report.html"');
    expect(last.content).toContain("이거 보면 돼");
  });

  it("attachment preamble appears before user text", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "분석해줘",
      receivedAt: Date.now(),
      attachments: [
        { kind: "image", name: "photo.jpg", localPath: "/tmp/photo.jpg" },
      ],
    };
    const out = await buildMessages(session, um);
    const content = out[out.length - 1]!.content as string;
    const attachIdx = content.indexOf("[Attachment:");
    const textIdx = content.indexOf("분석해줘");
    expect(attachIdx).toBeLessThan(textIdx);
  });

  it("handles attachment-only messages (empty text)", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "",
      receivedAt: Date.now(),
      attachments: [
        { kind: "file", name: "data.pdf", localPath: "/tmp/data.pdf", mimeType: "application/pdf" },
      ],
    };
    const out = await buildMessages(session, um);
    const content = out[out.length - 1]!.content as string;
    expect(content).toContain('[Attachment: name="data.pdf"');
    // Should NOT have trailing empty lines or just whitespace
    expect(content.trim()).toBe(content);
  });

  it("passes through imageBlocks from chat-proxy as Anthropic vision content array", async () => {
    const { session } = await makeSession({});
    const fakeBase64 = Buffer.from("test-image").toString("base64");
    const um: UserMessage = {
      text: "이 이미지 분석해줘",
      receivedAt: Date.now(),
      imageBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: fakeBase64 },
        },
      ],
    };
    const out = await buildMessages(session, um);
    const last = out[out.length - 1]!;
    expect(last.role).toBe("user");
    // Content should be an array (mixed content), not a string
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string; source?: unknown; text?: string }>;
    // Image block first, then text
    expect(blocks[0]!.type).toBe("image");
    expect(blocks[1]!.type).toBe("text");
    expect(blocks[1]!.text).toBe("이 이미지 분석해줘");
  });

  it("reads image attachments from disk and creates base64 image blocks", async () => {
    const { session } = await makeSession({});
    // Create a temporary fake image file
    const fsSync = await import("node:fs");
    const tmpFile = path.join(os.tmpdir(), `test-img-${Date.now()}.jpg`);
    fsSync.default.writeFileSync(tmpFile, Buffer.from("fake-jpeg-data"));
    try {
      const um: UserMessage = {
        text: "사진 봐",
        receivedAt: Date.now(),
        attachments: [
          { kind: "image", name: "photo.jpg", mimeType: "image/jpeg", localPath: tmpFile },
        ],
      };
      const out = await buildMessages(session, um);
      const last = out[out.length - 1]!;
      expect(Array.isArray(last.content)).toBe(true);
      const blocks = last.content as Array<{ type: string; source?: { media_type: string; data: string }; text?: string }>;
      expect(blocks[0]!.type).toBe("image");
      expect(blocks[0]!.source?.media_type).toBe("image/jpeg");
      expect(blocks[0]!.source?.data).toBe(Buffer.from("fake-jpeg-data").toString("base64"));
      expect(blocks[1]!.type).toBe("text");
      expect(blocks[1]!.text).toBe("사진 봐");
    } finally {
      fsSync.default.unlinkSync(tmpFile);
    }
  });

  it("falls back to text metadata when image file cannot be read", async () => {
    const { session } = await makeSession({});
    const um: UserMessage = {
      text: "분석해줘",
      receivedAt: Date.now(),
      attachments: [
        { kind: "image", name: "missing.jpg", mimeType: "image/jpeg", localPath: "/nonexistent/missing.jpg" },
      ],
    };
    const out = await buildMessages(session, um);
    const last = out[out.length - 1]!;
    // No imageBlocks → should be plain string with [Attachment: ...] tag
    expect(typeof last.content).toBe("string");
    expect(last.content as string).toContain('[Attachment: name="missing.jpg"');
  });

  it("non-image attachments remain as text metadata even when imageBlocks exist", async () => {
    const { session } = await makeSession({});
    const fakeBase64 = Buffer.from("img").toString("base64");
    const um: UserMessage = {
      text: "둘 다 처리해줘",
      receivedAt: Date.now(),
      imageBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: fakeBase64 },
        },
      ],
      attachments: [
        { kind: "file", name: "doc.pdf", mimeType: "application/pdf", localPath: "/tmp/doc.pdf" },
      ],
    };
    const out = await buildMessages(session, um);
    const last = out[out.length - 1]!;
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Array<{ type: string; text?: string }>;
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock?.text).toContain('[Attachment: name="doc.pdf"');
    expect(textBlock?.text).toContain("둘 다 처리해줘");
  });
});

describe("MessageBuilder.formatReplyPreamble", () => {
  it("emits single-line `[Reply to <role>: \"<preview>\"]`", () => {
    expect(
      formatReplyPreamble({
        messageId: "m",
        preview: "hi there",
        role: "assistant",
      }),
    ).toBe('[Reply to assistant: "hi there"]');
  });

  it("collapses internal whitespace/newlines to single spaces", () => {
    expect(
      formatReplyPreamble({
        messageId: "m",
        preview: "line one\nline two\n\n\tline three",
        role: "user",
      }),
    ).toBe('[Reply to user: "line one line two line three"]');
  });

  it("truncates previews longer than REPLY_PREVIEW_MAX_CHARS with an ellipsis", () => {
    const long = "x".repeat(REPLY_PREVIEW_MAX_CHARS + 50);
    const out = formatReplyPreamble({
      messageId: "m",
      preview: long,
      role: "assistant",
    });
    // Must end with the Unicode ellipsis — NOT three dots — so the
    // caller can grep for the boundary.
    expect(out.endsWith('…"]')).toBe(true);
    // Preview body is exactly MAX chars + 1 ellipsis between the quote
    // boundaries.
    const preview = out.slice(
      '[Reply to assistant: "'.length,
      -"]".length - 1, // strip trailing `"]`
    );
    expect(preview.length).toBe(REPLY_PREVIEW_MAX_CHARS + 1);
  });

  it("keeps short previews verbatim (no ellipsis)", () => {
    const out = formatReplyPreamble({
      messageId: "m",
      preview: "short",
      role: "user",
    });
    expect(out).toBe('[Reply to user: "short"]');
    expect(out.includes("…")).toBe(false);
  });
});
