/**
 * Phase 2h — /v1/compliance endpoint tests.
 *
 * Covers:
 *  - 401 when X-Gateway-Token is missing or wrong.
 *  - 404 when the requested sessionKey has no transcript.
 *  - 200 with correct summary shape when transcript + audit entries
 *    exist for a session.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HttpServer } from "./HttpServer.js";
import { Transcript } from "../storage/Transcript.js";
import { AuditLog } from "../storage/AuditLog.js";

interface FakeAgent {
  config: {
    botId: string;
    workspaceRoot: string;
  };
  auditLog: AuditLog;
  listSessions(): Array<{ meta: { sessionKey: string } }>;
  sessionKeyIndex(): Map<string, string>;
  // Unused here but HttpServer references them defensively.
  tools: { list(): []; skillReport(): null };
  hooks: { list(): [] };
  getActiveTurn(): undefined;
  config_unused?: unknown;
}

function makeFakeAgent(workspaceRoot: string, botId = "bot-test"): FakeAgent {
  const auditLog = new AuditLog(workspaceRoot, botId);
  const sessions: Array<{ meta: { sessionKey: string } }> = [];
  return {
    config: { botId, workspaceRoot },
    auditLog,
    listSessions: () => sessions,
    sessionKeyIndex: () => new Map(),
    tools: { list: () => [], skillReport: () => null },
    hooks: { list: () => [] },
    getActiveTurn: () => undefined,
  };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{
  status: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers }, (res) => {
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

describe("HttpServer /v1/compliance", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  const TOKEN = "test-gateway-token";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-compliance-"));
    const agent = makeFakeAgent(tmp) as unknown as ConstructorParameters<typeof HttpServer>[0]["agent"];
    server = new HttpServer({ port: 0, agent, bearerToken: TOKEN });
    await server.start();
    // Grab the actual port assigned.
    const anyServer = server as unknown as { server: http.Server };
    const addr = anyServer.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns 401 without gateway token", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/v1/compliance`);
    expect(r.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/v1/compliance`, {
      "X-Gateway-Token": "wrong",
    });
    expect(r.status).toBe(401);
  });

  it("returns 404 for unknown sessionKey", async () => {
    const r = await getJson(
      `http://127.0.0.1:${port}/v1/compliance?sessionKey=agent:main:app:nope:1`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r.status).toBe(404);
  });

  it("returns 200 with summary shape when session has transcript", async () => {
    const sessionKey = "agent:main:app:general:7";
    const sessionsDir = path.join(tmp, "core-agent", "sessions");
    const transcript = new Transcript(sessionsDir, sessionKey);
    await transcript.ensureDir();
    const now = Date.now();
    const turnId = "01HXTEST000001";
    await transcript.append({
      kind: "turn_started",
      ts: now,
      turnId,
      declaredRoute: "direct",
    });
    await transcript.append({
      kind: "user_message",
      ts: now,
      turnId,
      text: "hi",
    });
    await transcript.append({
      kind: "tool_call",
      ts: now,
      turnId,
      toolUseId: "t1",
      name: "FileRead",
      input: { path: "README.md" },
    });
    await transcript.append({
      kind: "tool_result",
      ts: now + 5,
      turnId,
      toolUseId: "t1",
      status: "ok",
      output: "ok",
    });
    await transcript.append({
      kind: "turn_committed",
      ts: now + 10,
      turnId,
      inputTokens: 5,
      outputTokens: 3,
    });

    // Inject a policy event into the audit log.
    const audit = new AuditLog(tmp, "bot-test");
    await audit.append("permission_denied", sessionKey, turnId, {
      tool: "Bash",
    });

    const r = await getJson(
      `http://127.0.0.1:${port}/v1/compliance?sessionKey=${encodeURIComponent(
        sessionKey,
      )}`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      sessions: Array<{
        sessionKey: string;
        botId: string;
        turnCount: number;
        toolUseCount: number;
        policyEvents: Array<{ event: string }>;
      }>;
    };
    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0]!;
    expect(s.sessionKey).toBe(sessionKey);
    expect(s.botId).toBe("bot-test");
    expect(s.turnCount).toBe(1);
    expect(s.toolUseCount).toBe(1);
    expect(s.policyEvents.map((e) => e.event)).toContain("permission_denied");
  });
});
