/**
 * /v1/chat/completions + /v1/turns/:id/ask-response tests.
 *
 * Uses a stub agent whose `getOrCreateSession` returns a Session-like
 * object whose `runTurn` simply writes one SSE event + ends. Verifies
 * the route framing (200 + SSE text/event-stream) without running the
 * real Turn machinery.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HttpServer } from "../HttpServer.js";
import { AuditLog } from "../../storage/AuditLog.js";
import { ResetCounterStore } from "../../slash/resetCounters.js";
import { extractReplyTo } from "./turns.js";

interface SseLike {
  legacyDelta(_t: string): void;
  legacyFinish(): void;
  end(): void;
}

interface StubSession {
  runTurn(_userMsg: unknown, sse: SseLike, _opts: unknown): Promise<void>;
}

interface StubSessionWithInject extends StubSession {
  injectMessage?: (
    text: string,
    source?: string,
  ) => { injectionId: string; queuedCount: number } | null;
}

interface StubAgent {
  config: { botId: string; workspaceRoot: string };
  auditLog: AuditLog;
  /** Slash-command reset-counter sidecar. Route handler reads it on
   * every POST to apply any `/reset` bump to the sessionKey. */
  resetCounters: ResetCounterStore;
  listSessions(): Array<{ meta: { sessionKey: string } }>;
  sessionKeyIndex(): Map<string, string>;
  tools: { list(): []; skillReport(): null };
  hooks: { list(): [] };
  getActiveTurn(): undefined;
  getSession?: (sessionKey: string) => StubSessionWithInject | undefined;
  hasActiveTurnForSession?: (sessionKey: string) => boolean;
  getOrCreateSession(
    _sessionKey: string,
    _channel: unknown,
  ): Promise<StubSession>;
}

interface InjectStubState {
  /** sessionKey → whether a turn is currently "active" for inject tests. */
  activeSessions: Set<string>;
  /** sessionKey → session stub instance used by getSession(). */
  sessions: Map<string, StubSessionWithInject>;
}

function makeStubAgent(
  workspaceRoot: string,
  capture?: { userMessage?: unknown },
  injectState?: InjectStubState,
): StubAgent {
  const botId = "bot-test";
  return {
    config: { botId, workspaceRoot },
    auditLog: new AuditLog(workspaceRoot, botId),
    resetCounters: new ResetCounterStore(
      path.join(workspaceRoot, "core-agent", "sessions"),
    ),
    listSessions: () => [],
    sessionKeyIndex: () => new Map(),
    tools: { list: () => [], skillReport: () => null },
    hooks: { list: () => [] },
    getActiveTurn: () => undefined,
    getSession: injectState
      ? (key) => injectState.sessions.get(key)
      : undefined,
    hasActiveTurnForSession: injectState
      ? (key) => injectState.activeSessions.has(key)
      : undefined,
    async getOrCreateSession(): Promise<StubSession> {
      return {
        async runTurn(userMsg, sse) {
          if (capture) capture.userMessage = userMsg;
          // Emit one legacy OpenAI-style delta so the SSE body contains
          // the expected `data:` framing; the route harness calls
          // sse.end() in its finally block.
          sse.legacyDelta("hi");
          sse.legacyFinish();
        },
      };
    },
  };
}

function rawRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("HttpServer /v1/chat/completions + /v1/turns/:id/ask-response", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  let capture: { userMessage?: unknown };
  const TOKEN = "test-bearer-token";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-turns-"));
    capture = {};
    const agent = makeStubAgent(tmp, capture) as unknown as ConstructorParameters<
      typeof HttpServer
    >[0]["agent"];
    server = new HttpServer({ port: 0, agent, bearerToken: TOKEN });
    await server.start();
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("POST /v1/chat/completions opens an SSE stream with stub turn", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/event-stream");
    // SseWriter should have produced at least one "data:" line.
    expect(r.body).toContain("data:");
  });

  it("POST /v1/chat/completions without bearer token → 401", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      { "Content-Type": "application/json" },
      JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(r.status).toBe(401);
  });

  it("POST /v1/chat/completions with no user message → 400", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ messages: [] }),
    );
    expect(r.status).toBe(400);
  });

  it("POST /v1/turns/:id/ask-response → 404 when turn unknown", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/turns/unknown-turn/ask-response`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ questionId: "q1", selectedId: "a" }),
    );
    expect(r.status).toBe(404);
    expect(r.body).toContain("turn_not_found");
  });

  it("POST /v1/turns/:id/ask-response missing questionId → 400", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/turns/t1/ask-response`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({ selectedId: "a" }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toContain("missing_questionId");
  });

  it("POST /v1/chat/completions propagates replyTo into userMessage.metadata", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [{ role: "user", content: "follow-up question" }],
        replyTo: {
          messageId: "msg-42",
          preview: "the original statement",
          role: "assistant",
        },
      }),
    );
    expect(r.status).toBe(200);
    const userMsg = capture.userMessage as
      | { text: string; metadata?: { replyTo?: unknown } }
      | undefined;
    expect(userMsg).toBeDefined();
    expect(userMsg?.metadata?.replyTo).toEqual({
      messageId: "msg-42",
      preview: "the original statement",
      role: "assistant",
    });
  });

  it("POST /v1/chat/completions without replyTo leaves metadata unset", async () => {
    await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [{ role: "user", content: "plain message" }],
      }),
    );
    const userMsg = capture.userMessage as
      | { metadata?: unknown }
      | undefined;
    expect(userMsg).toBeDefined();
    expect(userMsg?.metadata).toBeUndefined();
  });
});

describe("POST /v1/chat/inject", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  let injectState: InjectStubState;
  const TOKEN = "test-bearer-token";
  const SESSION_KEY = "agent:main:app:default:botTest1";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-inject-"));
    injectState = {
      activeSessions: new Set(),
      sessions: new Map(),
    };
    const agent = makeStubAgent(tmp, undefined, injectState) as unknown as ConstructorParameters<
      typeof HttpServer
    >[0]["agent"];
    server = new HttpServer({ port: 0, agent, bearerToken: TOKEN });
    await server.start();
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function postInject(payload: unknown): Promise<{
    status: number;
    body: string;
  }> {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/inject`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify(payload),
    );
    return { status: r.status, body: r.body };
  }

  it("rejects missing bearer token with 401", async () => {
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/inject`,
      { "Content-Type": "application/json" },
      JSON.stringify({ sessionKey: SESSION_KEY, text: "hi" }),
    );
    expect(r.status).toBe(401);
  });

  it("rejects missing sessionKey with 400", async () => {
    const r = await postInject({ text: "hi" });
    expect(r.status).toBe(400);
    expect(r.body).toContain("missing_sessionKey");
  });

  it("rejects empty text with 400", async () => {
    const r = await postInject({ sessionKey: SESSION_KEY, text: "   " });
    expect(r.status).toBe(400);
    expect(r.body).toContain("empty_text");
  });

  it("returns 404 when session does not exist", async () => {
    const r = await postInject({ sessionKey: SESSION_KEY, text: "hi" });
    expect(r.status).toBe(404);
    expect(r.body).toContain("session_not_found");
  });

  it("returns 409 when session exists but no active turn", async () => {
    injectState.sessions.set(SESSION_KEY, {
      runTurn: async () => undefined,
      injectMessage: () => ({ injectionId: "inj-1", queuedCount: 1 }),
    });
    // activeSessions left empty — no active turn
    const r = await postInject({ sessionKey: SESSION_KEY, text: "hi" });
    expect(r.status).toBe(409);
    expect(r.body).toContain("no_active_turn");
  });

  it("returns 200 + injectionId when session has an active turn", async () => {
    injectState.sessions.set(SESSION_KEY, {
      runTurn: async () => undefined,
      injectMessage: () => ({ injectionId: "inj-abc-1", queuedCount: 1 }),
    });
    injectState.activeSessions.add(SESSION_KEY);
    const r = await postInject({
      sessionKey: SESSION_KEY,
      text: "queue me",
      source: "web",
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain("inj-abc-1");
    expect(r.body).toContain("\"queuedCount\":1");
  });

  it("returns 429 when the session queue is full", async () => {
    injectState.sessions.set(SESSION_KEY, {
      runTurn: async () => undefined,
      injectMessage: () => null,
    });
    injectState.activeSessions.add(SESSION_KEY);
    const r = await postInject({ sessionKey: SESSION_KEY, text: "overflow" });
    expect(r.status).toBe(429);
    expect(r.body).toContain("queue_full");
  });
});

describe("extractLastUserMessage image_url handling", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  let capture: { userMessage?: unknown };
  const TOKEN = "test-bearer-token";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-img-"));
    capture = {};
    const agent = makeStubAgent(tmp, capture) as unknown as ConstructorParameters<
      typeof HttpServer
    >[0]["agent"];
    server = new HttpServer({ port: 0, agent, bearerToken: TOKEN });
    await server.start();
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("extracts image_url blocks from chat-proxy into imageBlocks", async () => {
    const fakeBase64 = Buffer.from("fake-image-data").toString("base64");
    const r = await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "이 이미지 분석해줘" },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${fakeBase64}`,
                },
              },
            ],
          },
        ],
      }),
    );
    expect(r.status).toBe(200);
    const userMsg = capture.userMessage as {
      text: string;
      imageBlocks?: Array<{
        type: string;
        source: { type: string; media_type: string; data: string };
      }>;
    };
    expect(userMsg.text).toBe("이 이미지 분석해줘");
    expect(userMsg.imageBlocks).toHaveLength(1);
    expect(userMsg.imageBlocks![0]!.type).toBe("image");
    expect(userMsg.imageBlocks![0]!.source.media_type).toBe("image/jpeg");
    expect(userMsg.imageBlocks![0]!.source.data).toBe(fakeBase64);
  });

  it("handles multiple image_url blocks + text blocks", async () => {
    const img1 = Buffer.from("img1").toString("base64");
    const img2 = Buffer.from("img2").toString("base64");
    await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "첫 번째 텍스트" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${img1}` } },
              { type: "text", text: "두 번째 텍스트" },
              { type: "image_url", image_url: { url: `data:image/webp;base64,${img2}` } },
            ],
          },
        ],
      }),
    );
    const userMsg = capture.userMessage as {
      text: string;
      imageBlocks?: Array<{ source: { media_type: string } }>;
    };
    expect(userMsg.text).toBe("첫 번째 텍스트\n두 번째 텍스트");
    expect(userMsg.imageBlocks).toHaveLength(2);
    expect(userMsg.imageBlocks![0]!.source.media_type).toBe("image/png");
    expect(userMsg.imageBlocks![1]!.source.media_type).toBe("image/webp");
  });

  it("ignores non-data image_url (e.g. http URLs)", async () => {
    await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "링크 이미지" },
              { type: "image_url", image_url: { url: "https://example.com/img.jpg" } },
            ],
          },
        ],
      }),
    );
    const userMsg = capture.userMessage as {
      text: string;
      imageBlocks?: unknown[];
    };
    expect(userMsg.text).toBe("링크 이미지");
    expect(userMsg.imageBlocks).toBeUndefined();
  });

  it("plain string content still works (no imageBlocks)", async () => {
    await rawRequest(
      "POST",
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      JSON.stringify({
        messages: [{ role: "user", content: "text only" }],
      }),
    );
    const userMsg = capture.userMessage as {
      text: string;
      imageBlocks?: unknown[];
    };
    expect(userMsg.text).toBe("text only");
    expect(userMsg.imageBlocks).toBeUndefined();
  });
});

describe("extractReplyTo", () => {
  it("returns undefined for non-object bodies", () => {
    expect(extractReplyTo(null)).toBeUndefined();
    expect(extractReplyTo("nope")).toBeUndefined();
    expect(extractReplyTo(123)).toBeUndefined();
  });

  it("returns undefined when replyTo field is missing", () => {
    expect(extractReplyTo({ messages: [] })).toBeUndefined();
  });

  it("returns undefined on malformed role", () => {
    expect(
      extractReplyTo({
        replyTo: { messageId: "m1", preview: "p", role: "system" },
      }),
    ).toBeUndefined();
  });

  it("returns undefined on empty messageId", () => {
    expect(
      extractReplyTo({
        replyTo: { messageId: "", preview: "p", role: "user" },
      }),
    ).toBeUndefined();
  });

  it("returns parsed ReplyToRef for a valid object", () => {
    const out = extractReplyTo({
      replyTo: { messageId: "m1", preview: "hello", role: "user" },
      messages: [],
    });
    expect(out).toEqual({ messageId: "m1", preview: "hello", role: "user" });
  });
});
