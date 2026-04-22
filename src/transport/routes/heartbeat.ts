/**
 * Heartbeat HTTP route — B5 session-alive liveness endpoint.
 *
 * GET /v1/sessions/:sessionKey/heartbeat
 *
 * Returns the contents of the session's heartbeat.json file, or a
 * synthesised response from in-memory session state when the file is
 * absent. Auth-gated via X-Gateway-Token (same as other session routes).
 *
 * Response shape matches HeartbeatFileData:
 *   { alive, sessionKey, turnId, iteration, lastActivityMs, updatedAt, completedAt? }
 *
 * 200 — heartbeat data found (file or in-memory)
 * 401 — missing/invalid gateway token
 * 404 — session not found and no heartbeat file on disk
 */

import type { RouteHandler } from "./_helpers.js";
import { route, authorizeGateway, writeJson } from "./_helpers.js";
import {
  SessionHeartbeat,
  type HeartbeatFileData,
} from "../../turn/SessionHeartbeat.js";

const HEARTBEAT_RE = /^\/v1\/sessions\/([^/]+)\/heartbeat$/;

export const heartbeatRoutes: RouteHandler[] = [
  route("GET", HEARTBEAT_RE, async (_req, res, match, ctx) => {
    if (!authorizeGateway(_req, res, ctx)) return;

    const sessionKey = decodeURIComponent(match[1]!);
    const workspaceRoot = ctx.agent.config.workspaceRoot;

    // Try reading the heartbeat file first — it's the source of truth
    // for activity timestamps and iteration counts.
    const fileData = await SessionHeartbeat.readHeartbeat(
      workspaceRoot,
      sessionKey,
    );

    if (fileData) {
      writeJson(res, 200, fileData);
      return;
    }

    // No file — check if the session exists in memory and synthesise
    // a minimal response.
    const session = ctx.agent.getSession(sessionKey);
    if (session) {
      const now = Date.now();
      const hasActiveTurn =
        ctx.agent.hasActiveTurnForSession(sessionKey);
      const data: HeartbeatFileData = {
        alive: hasActiveTurn,
        sessionKey,
        turnId: "",
        iteration: 0,
        lastActivityMs: session.meta.lastActivityAt ?? now,
        updatedAt: new Date(now).toISOString(),
        ...(!hasActiveTurn
          ? { completedAt: new Date(session.meta.lastActivityAt ?? now).toISOString() }
          : {}),
      };
      writeJson(res, 200, data);
      return;
    }

    writeJson(res, 404, { error: "session_not_found", sessionKey });
  }),
];
