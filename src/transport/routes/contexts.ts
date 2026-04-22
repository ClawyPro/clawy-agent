/**
 * Multi-context CRUD routes (T4-19 §7.10). All gateway-token gated.
 * Behaviour preserved verbatim from the pre-split HttpServer.ts.
 *
 *   POST   /v1/contexts             body {sessionKey, title, systemPromptAddendum?}
 *   GET    /v1/contexts?sessionKey=
 *   PATCH  /v1/contexts/:contextId  body {title?, archived?, systemPromptAddendum?, sessionKey}
 *   DELETE /v1/contexts/:contextId?sessionKey=
 *   GET    /v1/contexts/:contextId/stats?sessionKey=
 *
 * Routing by method + subpath is owned by this module via a
 * `prefixRoute` on `/v1/contexts`.
 */

import {
  authorizeGateway,
  prefixRoute,
  readJsonBodyLenient,
  writeJson,
  type HttpServerCtx,
  type RouteHandler,
} from "./_helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

async function peekSessionKeyFromBody(req: IncomingMessage): Promise<string> {
  try {
    const body = await readJsonBodyLenient(req);
    return typeof body.sessionKey === "string" ? body.sessionKey : "";
  } catch {
    return "";
  }
}

async function handleContextRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeGateway(req, res, ctx)) return;

  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const parts = url.split("?", 2);
  const pathOnly = parts[0] ?? url;
  const search = new URLSearchParams(parts[1] ?? "");

  const findSession = (sessionKey: string) =>
    ctx.agent.listSessions().find((s) => s.meta.sessionKey === sessionKey);

  // POST /v1/contexts
  if (pathOnly === "/v1/contexts" && method === "POST") {
    const body = await readJsonBodyLenient(req);
    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
    const title = typeof body.title === "string" ? body.title : "";
    if (!sessionKey || !title) {
      writeJson(res, 400, { error: "sessionKey and title required" });
      return;
    }
    const session = findSession(sessionKey);
    if (!session) {
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    const systemPromptAddendum =
      typeof body.systemPromptAddendum === "string"
        ? body.systemPromptAddendum
        : undefined;
    const created = await session.createContext({
      title,
      ...(systemPromptAddendum !== undefined ? { systemPromptAddendum } : {}),
    });
    writeJson(res, 200, { context: created.meta });
    return;
  }

  // GET /v1/contexts?sessionKey=
  if (pathOnly === "/v1/contexts" && method === "GET") {
    const sessionKey = search.get("sessionKey") ?? "";
    const session = findSession(sessionKey);
    if (!session) {
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    const list = await session.listContexts();
    writeJson(res, 200, { contexts: list });
    return;
  }

  // /v1/contexts/:contextId[/stats]
  const m = pathOnly.match(/^\/v1\/contexts\/([^/]+)(\/stats)?$/);
  if (m) {
    const contextId = decodeURIComponent(m[1] as string);
    const statsSuffix = !!m[2];
    const sessionKey =
      search.get("sessionKey") ??
      (method === "PATCH" || method === "POST"
        ? await peekSessionKeyFromBody(req)
        : "");
    const session = sessionKey ? findSession(sessionKey) : undefined;
    if (!session) {
      writeJson(res, 404, { error: "session_not_found" });
      return;
    }
    if (statsSuffix && method === "GET") {
      const s = session.contextStats(contextId);
      if (!s) {
        writeJson(res, 404, { error: "context_not_found" });
        return;
      }
      writeJson(res, 200, { contextId, stats: s });
      return;
    }
    if (method === "PATCH") {
      const body = await readJsonBodyLenient(req);
      try {
        const updated = await session.patchContext(contextId, {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
          ...(typeof body.systemPromptAddendum === "string"
            ? { systemPromptAddendum: body.systemPromptAddendum }
            : {}),
        });
        writeJson(res, 200, { context: updated });
      } catch (err) {
        writeJson(res, 404, { error: (err as Error).message });
      }
      return;
    }
    if (method === "DELETE") {
      try {
        await session.deleteContext(contextId);
        writeJson(res, 200, { deleted: true, contextId });
      } catch (err) {
        writeJson(res, 400, { error: (err as Error).message });
      }
      return;
    }
  }

  writeJson(res, 404, { error: "not_found" });
}

export const contextsRoutes: RouteHandler[] = [
  prefixRoute("/v1/contexts", handleContextRoute),
];
