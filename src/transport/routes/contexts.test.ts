/**
 * /v1/contexts route tests. Validates gateway-token gating + basic
 * 404 path after the R5 route split.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HttpServer } from "../HttpServer.js";
import { AuditLog } from "../../storage/AuditLog.js";

interface FakeAgent {
  config: { botId: string; workspaceRoot: string };
  auditLog: AuditLog;
  listSessions(): Array<{ meta: { sessionKey: string } }>;
  sessionKeyIndex(): Map<string, string>;
  tools: { list(): []; skillReport(): null };
  hooks: { list(): [] };
  getActiveTurn(): undefined;
}

function makeFakeAgent(workspaceRoot: string): FakeAgent {
  const botId = "bot-test";
  return {
    config: { botId, workspaceRoot },
    auditLog: new AuditLog(workspaceRoot, botId),
    listSessions: () => [],
    sessionKeyIndex: () => new Map(),
    tools: { list: () => [], skillReport: () => null },
    hooks: { list: () => [] },
    getActiveTurn: () => undefined,
  };
}

async function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = txt;
        try {
          parsed = JSON.parse(txt);
        } catch {
          /* keep text */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe("HttpServer /v1/contexts", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  const TOKEN = "test-gateway-token";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-contexts-"));
    const agent = makeFakeAgent(tmp) as unknown as ConstructorParameters<
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

  it("returns 401 without gateway token", async () => {
    const r = await request("GET", `http://127.0.0.1:${port}/v1/contexts`);
    expect(r.status).toBe(401);
  });

  it("returns 404 when sessionKey not found on GET", async () => {
    const r = await request(
      "GET",
      `http://127.0.0.1:${port}/v1/contexts?sessionKey=unknown`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r.status).toBe(404);
    const body = r.body as { error: string };
    expect(body.error).toBe("session_not_found");
  });

  it("returns 400 when POST body missing required fields", async () => {
    const r = await request(
      "POST",
      `http://127.0.0.1:${port}/v1/contexts`,
      {
        "X-Gateway-Token": TOKEN,
        "Content-Type": "application/json",
      },
      JSON.stringify({}),
    );
    expect(r.status).toBe(400);
    const body = r.body as { error: string };
    expect(body.error).toBe("sessionKey and title required");
  });
});
