/**
 * Heartbeat HTTP route tests.
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { heartbeatRoutes } from "./heartbeat.js";
import type { HttpServerCtx } from "./_helpers.js";
import type { Agent } from "../../Agent.js";

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    headersSent: false,
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? "";
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function makeCtx(overrides: {
  workspaceRoot?: string;
  sessions?: Map<string, { meta: { lastActivityAt: number } }>;
  activeTurnSessions?: Set<string>;
  bearerToken?: string;
}): HttpServerCtx {
  const sessions = overrides.sessions ?? new Map();
  const activeSessions = overrides.activeTurnSessions ?? new Set();
  return {
    agent: {
      config: { workspaceRoot: overrides.workspaceRoot ?? "/nonexistent-workspace" },
      sessions,
      getSession: (key: string) => sessions.get(key),
      hasActiveTurnForSession: (key: string) => activeSessions.has(key),
    } as unknown as Agent,
    bearerToken: overrides.bearerToken ?? "test-token",
  };
}

describe("heartbeat routes", () => {
  const handler = heartbeatRoutes[0]!;

  it("matches GET /v1/sessions/:key/heartbeat", () => {
    const m = handler.match(
      mockReq("GET", "/v1/sessions/main/heartbeat"),
      "/v1/sessions/main/heartbeat",
    );
    expect(m).toBeTruthy();
  });

  it("does not match POST", () => {
    const m = handler.match(
      mockReq("POST", "/v1/sessions/main/heartbeat"),
      "/v1/sessions/main/heartbeat",
    );
    expect(m).toBeFalsy();
  });

  it("returns 401 without gateway token", async () => {
    const res = mockRes();
    const ctx = makeCtx({ bearerToken: "secret" });
    const req = mockReq("GET", "/v1/sessions/main/heartbeat");
    const m = handler.match(req, "/v1/sessions/main/heartbeat");
    await handler.handle(req, res, m!, ctx);
    expect(res._status).toBe(401);
  });

  it("returns 404 for unknown session with no heartbeat file", async () => {
    const res = mockRes();
    const ctx = makeCtx({ bearerToken: "tok" });
    const req = mockReq("GET", "/v1/sessions/unknown/heartbeat", {
      "x-gateway-token": "tok",
    });
    const m = handler.match(req, "/v1/sessions/unknown/heartbeat");
    await handler.handle(req, res, m!, ctx);
    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.error).toBe("session_not_found");
  });

  it("returns in-memory fallback for known session without heartbeat file", async () => {
    const sessions = new Map<string, { meta: { lastActivityAt: number } }>();
    sessions.set("sess-1", { meta: { lastActivityAt: 1700000000000 } });

    const res = mockRes();
    const ctx = makeCtx({
      bearerToken: "tok",
      sessions,
      activeTurnSessions: new Set(["sess-1"]),
    });
    const req = mockReq("GET", "/v1/sessions/sess-1/heartbeat", {
      "x-gateway-token": "tok",
    });
    const m = handler.match(req, "/v1/sessions/sess-1/heartbeat");
    await handler.handle(req, res, m!, ctx);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.alive).toBe(true);
    expect(body.sessionKey).toBe("sess-1");
  });

  it("returns alive:false for known idle session", async () => {
    const sessions = new Map<string, { meta: { lastActivityAt: number } }>();
    sessions.set("idle-1", { meta: { lastActivityAt: 1700000000000 } });

    const res = mockRes();
    const ctx = makeCtx({
      bearerToken: "tok",
      sessions,
      activeTurnSessions: new Set(), // no active turns
    });
    const req = mockReq("GET", "/v1/sessions/idle-1/heartbeat", {
      "x-gateway-token": "tok",
    });
    const m = handler.match(req, "/v1/sessions/idle-1/heartbeat");
    await handler.handle(req, res, m!, ctx);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body.alive).toBe(false);
    expect(body.sessionKey).toBe("idle-1");
    expect(body.completedAt).toBeDefined();
  });
});
