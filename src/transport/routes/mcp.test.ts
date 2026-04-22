/**
 * POST /mcp route tests. Validates HTTP framing + auth + batch handling
 * on top of the McpServer dispatcher.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HttpServer } from "../HttpServer.js";
import { AuditLog } from "../../storage/AuditLog.js";
import { makeFileReadTool } from "../../tools/FileRead.js";
import type { Tool } from "../../Tool.js";

interface FakeAgent {
  config: { botId: string; workspaceRoot: string };
  auditLog: AuditLog;
  listSessions(): [];
  sessionKeyIndex(): Map<string, string>;
  tools: { list(): Tool[]; skillReport(): null };
  hooks: { list(): [] };
  getActiveTurn(): undefined;
}

function makeFakeAgent(workspaceRoot: string, tools: Tool[]): FakeAgent {
  const botId = "bot-test";
  return {
    config: { botId, workspaceRoot },
    auditLog: new AuditLog(workspaceRoot, botId),
    listSessions: () => [],
    sessionKeyIndex: () => new Map(),
    tools: { list: () => tools, skillReport: () => null },
    hooks: { list: () => [] },
    getActiveTurn: () => undefined,
  };
}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
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
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("POST /mcp route", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  const TOKEN = "test-bearer-token";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-route-"));
    await fs.writeFile(path.join(tmp, "fixture.txt"), "fixture-body", "utf8");
    const agent = makeFakeAgent(tmp, [makeFileReadTool(tmp)]);
    server = new HttpServer({
      port: 0,
      agent: agent as unknown as ConstructorParameters<
        typeof HttpServer
      >[0]["agent"],
      bearerToken: TOKEN,
    });
    await server.start();
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("missing bearer token → 401", async () => {
    const r = await postJson(
      `http://127.0.0.1:${port}/mcp`,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    );
    expect(r.status).toBe(401);
  });

  it("malformed JSON → -32700 envelope with HTTP 200", async () => {
    const r = await postJson(
      `http://127.0.0.1:${port}/mcp`,
      "{ not valid json",
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(200);
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("batch request with 2 tools/list calls returns array response", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const r = await postJson(
      `http://127.0.0.1:${port}/mcp`,
      JSON.stringify(batch),
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const responses = r.body as Array<{
      id: number;
      result: { tools: Array<{ name: string }> };
    }>;
    expect(responses).toHaveLength(2);
    const first = responses[0];
    const second = responses[1];
    if (!first || !second) throw new Error("expected 2 responses");
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(first.result.tools.map((t) => t.name)).toContain("FileRead");
  });
});
