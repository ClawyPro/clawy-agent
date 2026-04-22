/**
 * Session introspection routes. All gateway-token gated. Behaviour
 * preserved verbatim from the pre-split HttpServer.ts.
 *
 *   GET /v1/session/:sessionKey/stats
 *     T1-06 budget snapshot: turn/cost counts + maxTurns/maxCostUsd.
 *
 *   GET /v1/session/:sessionKey/permission
 *     T2-08 permission-mode snapshot: mode, prePlanMode, isPlanMode.
 */

import {
  authorizeGateway,
  route,
  writeJson,
  type HttpServerCtx,
  type RouteHandler,
} from "./_helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

async function handleSessionStats(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeGateway(req, res, ctx)) return;
  const sessionKey = decodeURIComponent(match[1] as string);
  const session = ctx.agent
    .listSessions()
    .find((s) => s.meta.sessionKey === sessionKey);
  if (!session) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  const stats = session.budgetStats();
  writeJson(res, 200, {
    sessionKey,
    botId: ctx.agent.config.botId,
    ...stats,
    maxTurns: session.maxTurns,
    maxCostUsd: session.maxCostUsd,
  });
}

async function handleSessionPermission(
  req: IncomingMessage,
  res: ServerResponse,
  match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeGateway(req, res, ctx)) return;
  const sessionKey = decodeURIComponent(match[1] as string);
  const session = ctx.agent
    .listSessions()
    .find((s) => s.meta.sessionKey === sessionKey);
  if (!session) {
    writeJson(res, 404, { error: "not_found" });
    return;
  }
  const mode = session.getPermissionMode();
  const prePlanMode = session.getPrePlanMode();
  writeJson(res, 200, {
    sessionKey,
    botId: ctx.agent.config.botId,
    mode,
    prePlanMode,
    isPlanMode: mode === "plan",
  });
}

export const sessionRoutes: RouteHandler[] = [
  route(
    "GET",
    /^\/v1\/session\/([^/?]+)\/stats(?:\?.*)?$/,
    handleSessionStats,
  ),
  route(
    "GET",
    /^\/v1\/session\/([^/?]+)\/permission(?:\?.*)?$/,
    handleSessionPermission,
  ),
];
