/**
 * /health + /healthz tests. Validates wire-format parity after the R5
 * route split.
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
  tools: {
    list(): Array<{ name: string; permission: string }>;
    skillReport(): { loaded: string[]; issues: string[] } | null;
  };
  hooks: {
    list(): Array<{
      name: string;
      point: string;
      priority?: number;
      blocking?: boolean;
    }>;
  };
  getActiveTurn(): undefined;
}

function makeFakeAgent(workspaceRoot: string): FakeAgent {
  const botId = "bot-test";
  return {
    config: { botId, workspaceRoot },
    auditLog: new AuditLog(workspaceRoot, botId),
    listSessions: () => [],
    sessionKeyIndex: () => new Map(),
    tools: {
      list: () => [
        { name: "FileRead", permission: "read" },
        { name: "Bash", permission: "ask" },
      ],
      skillReport: () => ({ loaded: ["plan", "coding-agent"], issues: [] }),
    },
    hooks: {
      list: () => [
        { name: "auditTool", point: "pre_tool", priority: 10, blocking: true },
      ],
    },
    getActiveTurn: () => undefined,
  };
}

async function getJson(
  url: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        let body: unknown = txt;
        try {
          body = JSON.parse(txt);
        } catch {
          /* keep text */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HttpServer /health + /healthz", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-health-"));
    const agent = makeFakeAgent(tmp) as unknown as ConstructorParameters<
      typeof HttpServer
    >[0]["agent"];
    server = new HttpServer({ port: 0, agent });
    await server.start();
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("GET /health returns the lean payload", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      botId: string;
      runtime: string;
      version: string;
    };
    expect(body.ok).toBe(true);
    expect(body.botId).toBe("bot-test");
    expect(body.runtime).toBe("clawy-agent");
    expect(body.version).toBe("0.1.0");
  });

  it("GET /healthz returns tool + skill + hook counts", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/healthz`);
    expect(r.status).toBe(200);
    const body = r.body as {
      ok: boolean;
      botId: string;
      tools: Array<{ name: string; permission: string }>;
      skills: { loaded: number; issues: string[] } | null;
      hooks: Array<{
        name: string;
        point: string;
        priority: number;
        blocking: boolean;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toEqual({ name: "FileRead", permission: "read" });
    expect(body.skills).toEqual({ loaded: 2, issues: [] });
    expect(body.hooks).toHaveLength(1);
    expect(body.hooks[0]).toEqual({
      name: "auditTool",
      point: "pre_tool",
      priority: 10,
      blocking: true,
    });
  });

  it("returns 404 for unknown route", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/does-not-exist`);
    expect(r.status).toBe(404);
  });
});
