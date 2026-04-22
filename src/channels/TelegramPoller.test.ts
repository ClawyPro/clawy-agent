import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TelegramPoller } from "./TelegramPoller.js";
import type { InboundMessage } from "./ChannelAdapter.js";

interface StubCall {
  url: string;
  init?: RequestInit;
}

/**
 * Build a stub fetch that drains a queue of canned responses in order.
 * Each entry returns a `Response` with JSON body. Exhausting the queue
 * returns { ok: true, result: [] } — i.e. an empty getUpdates — so the
 * poller's loop doesn't hang on unexpected calls.
 */
function makeStubFetch(
  queue: Array<{ body: unknown; status?: number }>,
): { fetchImpl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, ...(init !== undefined ? { init } : {}) });
    const next = queue.shift();
    if (!next) {
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("TelegramPoller", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tg-poller-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("converts a getUpdates message update into an InboundMessage", async () => {
    const update = {
      update_id: 100,
      message: {
        message_id: 55,
        from: { id: 42, is_bot: false, first_name: "Kev" },
        chat: { id: 42, type: "private" },
        date: 1700000000,
        text: "hello bot",
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "TEST_TOKEN",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });

    await poller.pollOnce();

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.channel).toBe("telegram");
    expect(msg.chatId).toBe("42");
    expect(msg.userId).toBe("42");
    expect(msg.text).toBe("hello bot");
    expect(msg.messageId).toBe("55");
  });

  it("populates replyTo when the inbound message quotes an earlier message", async () => {
    const update = {
      update_id: 150,
      message: {
        message_id: 70,
        from: { id: 5, first_name: "Kev" },
        chat: { id: 5, type: "private" },
        date: 1700000000,
        text: "so about that",
        reply_to_message: {
          message_id: 55,
          from: { id: 42, first_name: "Other" },
          chat: { id: 5, type: "private" },
          date: 1699999000,
          text: "I think the answer is 42.",
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();
    expect(received).toHaveLength(1);
    expect(received[0]!.replyTo).toEqual({
      messageId: "55",
      preview: "I think the answer is 42.",
      role: "user",
    });
  });

  it("uses caption as replyTo preview when quoted message has no text", async () => {
    const update = {
      update_id: 151,
      message: {
        message_id: 71,
        from: { id: 5 },
        chat: { id: 5 },
        date: 0,
        text: "reacting to photo",
        reply_to_message: {
          message_id: 56,
          chat: { id: 5 },
          date: 0,
          caption: "group photo from the trip",
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();
    expect(received[0]!.replyTo?.preview).toBe("group photo from the trip");
  });

  it("omits replyTo when quoted message has neither text nor caption", async () => {
    const update = {
      update_id: 152,
      message: {
        message_id: 72,
        from: { id: 5 },
        chat: { id: 5 },
        date: 0,
        text: "sticker response",
        reply_to_message: {
          message_id: 57,
          chat: { id: 5 },
          date: 0,
          // no text, no caption (sticker-only)
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();
    expect(received).toHaveLength(1);
    expect(received[0]!.replyTo).toBeUndefined();
  });

  it("omits replyTo when inbound message is not a reply", async () => {
    const update = {
      update_id: 153,
      message: {
        message_id: 73,
        from: { id: 5 },
        chat: { id: 5 },
        date: 0,
        text: "standalone message",
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();
    expect(received[0]!.replyTo).toBeUndefined();
  });

  it("skips updates without text, caption, or attachment (channel_post, edited, sticker-only)", async () => {
    const { fetchImpl } = makeStubFetch([
      {
        body: {
          ok: true,
          result: [
            { update_id: 200, edited_message: { message_id: 1, chat: { id: 9 }, text: "x" } },
            {
              update_id: 201,
              message: {
                message_id: 2,
                from: { id: 9 },
                chat: { id: 9 },
                date: 0,
                // no text, no caption, no document/photo — e.g. sticker-only
              },
            },
          ],
        },
      },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();
    expect(received).toHaveLength(0);
  });

  it("accepts a document message and downloads the file", async () => {
    const docUpdate = {
      update_id: 300,
      message: {
        message_id: 10,
        from: { id: 42 },
        chat: { id: 42 },
        date: 0,
        caption: "이거 보면 돼",
        document: {
          file_id: "FILEID_DOC",
          file_unique_id: "u1",
          file_name: "report.html",
          mime_type: "text/html",
          file_size: 116400,
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      // getUpdates
      { body: { ok: true, result: [docUpdate] } },
      // getFile response
      { body: { ok: true, result: { file_id: "FILEID_DOC", file_path: "documents/file_0.html" } } },
      // file download (binary content)
      { body: "<html>hello</html>" },
    ]);
    const poller = new TelegramPoller({
      botToken: "TOK",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    // Caption becomes text
    expect(msg.text).toBe("이거 보면 돼");
    // Attachment populated
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.name).toBe("report.html");
    expect(msg.attachments![0]!.kind).toBe("file");
    expect(msg.attachments![0]!.localPath).toContain("telegram-downloads");
    expect(msg.attachments![0]!.localPath).toContain("report.html");
    // File was actually written to disk
    const content = await fs.readFile(msg.attachments![0]!.localPath!, "utf8");
    expect(content).toContain("hello");
  });

  it("accepts a photo message (no text) and downloads highest-res version", async () => {
    const photoUpdate = {
      update_id: 301,
      message: {
        message_id: 11,
        from: { id: 42 },
        chat: { id: 42 },
        date: 0,
        photo: [
          { file_id: "SMALL", file_unique_id: "s1", width: 90, height: 90 },
          { file_id: "LARGE", file_unique_id: "s2", width: 800, height: 600, file_size: 50000 },
        ],
      },
    };
    const { fetchImpl, calls } = makeStubFetch([
      { body: { ok: true, result: [photoUpdate] } },
      { body: { ok: true, result: { file_id: "LARGE", file_path: "photos/file_1.jpg" } } },
      { body: "JPEGDATA" },
    ]);
    const poller = new TelegramPoller({
      botToken: "TOK",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    // No text or caption — text is empty string
    expect(msg.text).toBe("");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]!.kind).toBe("image");
    expect(msg.attachments![0]!.mimeType).toBe("image/jpeg");
    // Should have called getFile with LARGE (highest res), not SMALL
    const getFileCall = calls.find((c) => c.url.includes("/getFile"));
    const getFileBody = JSON.parse(getFileCall?.init?.body as string);
    expect(getFileBody.file_id).toBe("LARGE");
  });

  it("uses caption as text for document message without text field", async () => {
    const update = {
      update_id: 302,
      message: {
        message_id: 12,
        from: { id: 5 },
        chat: { id: 5 },
        date: 0,
        caption: "파일 보냈음 이걸로",
        document: {
          file_id: "F1",
          file_unique_id: "u1",
          file_name: "data.pdf",
          mime_type: "application/pdf",
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
      { body: { ok: true, result: { file_id: "F1", file_path: "docs/data.pdf" } } },
      { body: "PDFBYTES" },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    await poller.pollOnce();

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("파일 보냈음 이걸로");
    expect(received[0]!.attachments).toHaveLength(1);
    expect(received[0]!.attachments![0]!.name).toBe("data.pdf");
  });

  it("still delivers the message if file download fails (non-fatal)", async () => {
    const update = {
      update_id: 303,
      message: {
        message_id: 13,
        from: { id: 5 },
        chat: { id: 5 },
        date: 0,
        caption: "이 파일 좀 봐",
        document: {
          file_id: "FAIL_FILE",
          file_unique_id: "u1",
          file_name: "broken.zip",
        },
      },
    };
    const { fetchImpl } = makeStubFetch([
      { body: { ok: true, result: [update] } },
      // getFile returns error
      { body: { ok: false, description: "file too big" }, status: 400 },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const received: InboundMessage[] = [];
    poller.onInboundMessage(async (m) => {
      received.push(m);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await poller.pollOnce();
    warn.mockRestore();

    // Message still delivered (with caption as text) but no attachments
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("이 파일 좀 봐");
    expect(received[0]!.attachments).toBeUndefined();
  });

  it("persists next offset to telegram-offset.json (last update_id + 1)", async () => {
    const { fetchImpl } = makeStubFetch([
      {
        body: {
          ok: true,
          result: [
            { update_id: 5, message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, date: 0, text: "a" } },
            { update_id: 6, message: { message_id: 2, from: { id: 1 }, chat: { id: 1 }, date: 0, text: "b" } },
            { update_id: 7, message: { message_id: 3, from: { id: 1 }, chat: { id: 1 }, date: 0, text: "c" } },
          ],
        },
      },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    poller.onInboundMessage(async () => {});
    await poller.pollOnce();

    const offsetFile = path.join(
      workspaceRoot,
      ".core-agent-state",
      "telegram-offset.json",
    );
    const raw = await fs.readFile(offsetFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.offset).toBe(8);
  });

  it("loads persisted offset at start() and passes it to getUpdates", async () => {
    // Seed the state file.
    const offsetFile = path.join(
      workspaceRoot,
      ".core-agent-state",
      "telegram-offset.json",
    );
    await fs.mkdir(path.dirname(offsetFile), { recursive: true });
    await fs.writeFile(offsetFile, JSON.stringify({ offset: 500 }), "utf8");

    const { fetchImpl, calls } = makeStubFetch([
      { body: { ok: true, result: [] } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    poller.onInboundMessage(async () => {});
    await poller.pollOnce();
    const getUpdatesCall = calls.find((c) => c.url.includes("getUpdates"));
    expect(getUpdatesCall).toBeDefined();
    // Either query-string or body; we post JSON body.
    const body = getUpdatesCall?.init?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string).offset).toBe(500);
  });

  it("send() posts to sendMessage with chat_id + text", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { body: { ok: true, result: { message_id: 99 } } },
    ]);
    const poller = new TelegramPoller({
      botToken: "TOK123",
      workspaceRoot,
      fetchImpl,
    });
    await poller.send({ chatId: "42", text: "hi there" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.telegram.org/botTOK123/sendMessage");
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(call.init?.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe("hi there");
  });

  it("send() includes reply_to_message_id when threading", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { body: { ok: true, result: {} } },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    await poller.send({ chatId: "1", text: "x", replyToMessageId: "55" });
    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.reply_to_message_id).toBe(55);
  });

  it("start() returns immediately without awaiting the poll loop (codex P1)", async () => {
    // Signal-aware fetch stub: rejects immediately if signal already aborted
    // (matches real fetch behaviour) so stop() on a barely-started poller
    // can still unwind cleanly.
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (init?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    poller.onInboundMessage(async () => {});
    const startedAt = Date.now();
    await poller.start();
    const elapsed = Date.now() - startedAt;
    // If start() awaited the loop, elapsed would be huge (fetch never resolves).
    // The fix schedules the loop fire-and-forget, so start() returns in a few ms.
    expect(elapsed).toBeLessThan(100);
    // Give the event loop a moment so pollOnce's fetch actually dispatches
    // before stop() tears down the abort controller — matches the pattern
    // used in the "stop() aborts an in-flight long poll" test below.
    await new Promise((r) => setTimeout(r, 30));
    await poller.stop();
  });

  it("stop() aborts an in-flight long poll", async () => {
    let abortFired = false;
    // fetch that rejects with AbortError when aborted, else hangs.
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortFired = true;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    poller.onInboundMessage(async () => {});
    const pollPromise = poller.start();
    // Give the event loop a few ticks so start() has issued the fetch
    // (offset-load is async — setImmediate alone isn't enough).
    await new Promise((r) => setTimeout(r, 30));
    await poller.stop();
    await pollPromise;
    expect(abortFired).toBe(true);
  });

  it("send() throws when Telegram returns ok:false", async () => {
    const { fetchImpl } = makeStubFetch([
      { body: { ok: false, description: "chat not found" }, status: 400 },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    await expect(
      poller.send({ chatId: "1", text: "x" }),
    ).rejects.toThrow(/chat not found/);
  });

  it("sendTyping() POSTs sendChatAction with chat_id + action=typing", async () => {
    const { fetchImpl, calls } = makeStubFetch([
      { body: { ok: true, result: true } },
    ]);
    const poller = new TelegramPoller({
      botToken: "TYPTOK",
      workspaceRoot,
      fetchImpl,
    });
    await poller.sendTyping("987");
    const call = calls[0]!;
    expect(call.url).toBe("https://api.telegram.org/botTYPTOK/sendChatAction");
    expect(call.init?.method).toBe("POST");
    const body = JSON.parse(call.init?.body as string);
    expect(body).toEqual({ chat_id: "987", action: "typing" });
  });

  it("sendTyping() swallows HTTP errors instead of throwing (turn must not die)", async () => {
    const { fetchImpl } = makeStubFetch([
      { body: { ok: false, description: "bad request" }, status: 400 },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(poller.sendTyping("1")).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("sendTyping() swallows network errors instead of throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(poller.sendTyping("1")).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("getUpdates HTTP 5xx is swallowed with a warning (poll loop must survive)", async () => {
    const { fetchImpl } = makeStubFetch([
      { body: { ok: false }, status: 502 },
    ]);
    const poller = new TelegramPoller({
      botToken: "T",
      workspaceRoot,
      fetchImpl,
    });
    poller.onInboundMessage(async () => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await poller.pollOnce();
    warn.mockRestore();
    // No throw = pass.
    expect(true).toBe(true);
  });
});
