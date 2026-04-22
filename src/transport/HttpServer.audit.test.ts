/**
 * Phase 2h — /v1/audit endpoint tests.
 *
 * Covers:
 *  - 401 without X-Gateway-Token.
 *  - 404 for an unknown turnId.
 *  - 200 returning a full turn bundle (messages + tool_use trail +
 *    commit status) for a known turn.
 *  - Session-scoped listing with pagination (limit + cursor).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HttpServer } from "./HttpServer.js";
import { Transcript } from "../storage/Transcript.js";
import { AuditLog } from "../storage/AuditLog.js";

interface TestAgent {
  config: { botId: string; workspaceRoot: string };
  auditLog: AuditLog;
  listSessions(): Array<{ meta: { sessionKey: string } }>;
  sessionKeyIndex(): Map<string, string>;
  tools: { list(): []; skillReport(): null };
  hooks: { list(): [] };
  getActiveTurn(): undefined;
}

function sessionHash(sessionKey: string): string {
  const c = require("node:crypto") as typeof import("node:crypto");
  return c.createHash("sha1").update(sessionKey).digest("hex").slice(0, 16);
}

function makeAgent(workspaceRoot: string, sessionKeys: string[] = []): TestAgent {
  const botId = "bot-test";
  const auditLog = new AuditLog(workspaceRoot, botId);
  const sessions = sessionKeys.map((k) => ({ meta: { sessionKey: k } }));
  const idx = new Map<string, string>();
  for (const k of sessionKeys) idx.set(sessionHash(k), k);
  return {
    config: { botId, workspaceRoot },
    auditLog,
    listSessions: () => sessions,
    sessionKeyIndex: () => idx,
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
          /* keep as text */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("HttpServer /v1/audit", () => {
  let tmp: string;
  let server: HttpServer;
  let port: number;
  const TOKEN = "test-gateway-token";
  const sessionKey = "agent:main:app:general:7";

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "core-agent-audit-"));
    const agent = makeAgent(tmp, [sessionKey]) as unknown as ConstructorParameters<
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

  async function writeTurns(count: number): Promise<string[]> {
    const sessionsDir = path.join(tmp, "core-agent", "sessions");
    const transcript = new Transcript(sessionsDir, sessionKey);
    await transcript.ensureDir();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const turnId = `01HX${String(i).padStart(10, "0")}`;
      ids.push(turnId);
      const t = Date.now() + i;
      await transcript.append({
        kind: "turn_started",
        ts: t,
        turnId,
        declaredRoute: "direct",
      });
      await transcript.append({
        kind: "user_message",
        ts: t,
        turnId,
        text: `msg-${i}`,
      });
      await transcript.append({
        kind: "tool_call",
        ts: t + 1,
        turnId,
        toolUseId: `t${i}`,
        name: "Grep",
        input: { pattern: "foo" },
      });
      await transcript.append({
        kind: "tool_result",
        ts: t + 2,
        turnId,
        toolUseId: `t${i}`,
        status: "ok",
        output: "hit",
      });
      await transcript.append({
        kind: "assistant_text",
        ts: t + 3,
        turnId,
        text: `reply-${i}`,
      });
      await transcript.append({
        kind: "turn_committed",
        ts: t + 4,
        turnId,
        inputTokens: 10,
        outputTokens: 5,
      });
    }
    return ids;
  }

  it("returns 401 without token", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/v1/audit?turnId=unknown`);
    expect(r.status).toBe(401);
  });

  it("returns 404 for unknown turnId", async () => {
    const r = await getJson(`http://127.0.0.1:${port}/v1/audit?turnId=unknown`, {
      "X-Gateway-Token": TOKEN,
    });
    expect(r.status).toBe(404);
  });

  it("returns full turn bundle for known turnId", async () => {
    const [t0] = await writeTurns(1);
    const r = await getJson(
      `http://127.0.0.1:${port}/v1/audit?turnId=${t0}&sessionKey=${encodeURIComponent(
        sessionKey,
      )}`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r.status).toBe(200);
    const body = r.body as {
      turn: {
        turnId: string;
        status: string;
        messages: Array<{ role: string; text: string }>;
        toolUses: Array<{ name: string; status?: string; durationMs?: number }>;
        inputTokens?: number;
      };
    };
    expect(body.turn.turnId).toBe(t0);
    expect(body.turn.status).toBe("committed");
    expect(body.turn.messages.length).toBe(2); // user + assistant
    expect(body.turn.toolUses[0]?.name).toBe("Grep");
    expect(body.turn.toolUses[0]?.status).toBe("ok");
    expect(body.turn.inputTokens).toBe(10);
  });

  it("paginates session-scoped listing", async () => {
    const ids = await writeTurns(5);
    const r1 = await getJson(
      `http://127.0.0.1:${port}/v1/audit?sessionKey=${encodeURIComponent(
        sessionKey,
      )}&limit=2`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r1.status).toBe(200);
    const body1 = r1.body as {
      turns: Array<{ turnId: string }>;
      nextCursor: string | null;
    };
    expect(body1.turns.map((t) => t.turnId)).toEqual([ids[0], ids[1]]);
    expect(body1.nextCursor).toBe(ids[1]);

    const r2 = await getJson(
      `http://127.0.0.1:${port}/v1/audit?sessionKey=${encodeURIComponent(
        sessionKey,
      )}&limit=2&cursor=${encodeURIComponent(body1.nextCursor ?? "")}`,
      { "X-Gateway-Token": TOKEN },
    );
    const body2 = r2.body as {
      turns: Array<{ turnId: string }>;
      nextCursor: string | null;
    };
    expect(body2.turns.map((t) => t.turnId)).toEqual([ids[2], ids[3]]);
    expect(body2.nextCursor).toBe(ids[3]);
  });

  it("returns 404 for unknown sessionKey listing", async () => {
    const r = await getJson(
      `http://127.0.0.1:${port}/v1/audit?sessionKey=agent:nobody:app:x:1`,
      { "X-Gateway-Token": TOKEN },
    );
    expect(r.status).toBe(404);
  });
});
