/**
 * Compliance + audit routes (Phase 2h).
 *
 * Both endpoints are gateway-token gated. Behaviour preserved verbatim
 * from the pre-split HttpServer.ts.
 *
 *   GET /v1/compliance?sessionKey=&since=&until=
 *     Per-session summary: turn/tool counts, policy events, start/end
 *     timestamps. Omitting `sessionKey` returns summaries for every
 *     live session.
 *
 *   GET /v1/audit
 *     Modes:
 *       ?turnId=...              → full turn bundle.
 *       ?sessionKey=...&limit=N  → paginated turn summaries.
 *       (neither)                → raw audit-log page.
 */

import { isPolicyEvent } from "../../storage/AuditLog.js";
import {
  bundleTurn,
  findSessionOfTurn,
  readAllEntries,
  sessionFilePath,
  summariseTurns,
  type TurnSummary,
} from "../../storage/TranscriptReader.js";
import {
  authorizeGateway,
  clampLimit,
  numberParam,
  parseUrl,
  route,
  writeJson,
  type HttpServerCtx,
  type RouteHandler,
} from "./_helpers.js";
import type { IncomingMessage, ServerResponse } from "node:http";

async function handleCompliance(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeGateway(req, res, ctx)) return;
  const parsed = parseUrl(req.url);
  const sessionKey = parsed.searchParams.get("sessionKey") ?? undefined;
  const since = numberParam(parsed.searchParams.get("since"));
  const until = numberParam(parsed.searchParams.get("until"));

  const { workspaceRoot } = ctx.agent.config;

  const targets: string[] = [];
  if (sessionKey) {
    targets.push(sessionKey);
  } else {
    for (const s of ctx.agent.listSessions()) targets.push(s.meta.sessionKey);
  }

  if (sessionKey && targets.length === 1) {
    const existsInRegistry = ctx.agent
      .listSessions()
      .some((s) => s.meta.sessionKey === sessionKey);
    if (!existsInRegistry) {
      const file = sessionFilePath(workspaceRoot, sessionKey);
      const entries = await readAllEntries(file);
      if (entries.length === 0) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
    }
  }

  const summaries: Array<{
    sessionKey: string;
    botId: string;
    turnCount: number;
    toolUseCount: number;
    policyEvents: Array<{
      ts: number;
      turnId?: string;
      event: string;
      data?: Record<string, unknown>;
    }>;
    startedAt?: number;
    endedAt?: number;
  }> = [];

  for (const sk of targets) {
    const file = sessionFilePath(workspaceRoot, sk);
    const entries = await readAllEntries(file);
    const turns: TurnSummary[] = summariseTurns(entries);
    const toolUseCount = turns.reduce((a, t) => a + t.toolUseCount, 0);
    const startedAt = turns[0]?.startedAt;
    const endedAt = turns[turns.length - 1]?.endedAt;
    if (since !== undefined && endedAt !== undefined && endedAt < since) continue;
    if (until !== undefined && startedAt !== undefined && startedAt > until) continue;

    const { entries: auditEntries } = await ctx.agent.auditLog.query({
      sessionKey: sk,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
      limit: 1_000,
    });
    const policyEvents = auditEntries
      .filter((e) => isPolicyEvent(e.event))
      .map((e) => ({
        ts: e.ts,
        ...(e.turnId ? { turnId: e.turnId } : {}),
        event: e.event,
        ...(e.data ? { data: e.data } : {}),
      }));

    summaries.push({
      sessionKey: sk,
      botId: ctx.agent.config.botId,
      turnCount: turns.length,
      toolUseCount,
      policyEvents,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    });
  }

  writeJson(res, 200, { sessions: summaries });
}

async function handleAudit(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpMatchArray,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeGateway(req, res, ctx)) return;
  const parsed = parseUrl(req.url);
  const turnId = parsed.searchParams.get("turnId") ?? undefined;
  const sessionKey = parsed.searchParams.get("sessionKey") ?? undefined;
  const limit = clampLimit(parsed.searchParams.get("limit"), 1, 500, 50);
  const cursor = parsed.searchParams.get("cursor") ?? undefined;

  const { workspaceRoot } = ctx.agent.config;

  if (turnId && !sessionKey) {
    const idx = ctx.agent.sessionKeyIndex();
    const hit = await findSessionOfTurn(workspaceRoot, turnId, idx);
    if (!hit) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    const entries = await readAllEntries(hit.file);
    const bundle = bundleTurn(entries, hit.sessionKey, turnId);
    if (!bundle) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    writeJson(res, 200, { turn: bundle });
    return;
  }

  if (turnId && sessionKey) {
    const file = sessionFilePath(workspaceRoot, sessionKey);
    const entries = await readAllEntries(file);
    const bundle = bundleTurn(entries, sessionKey, turnId);
    if (!bundle) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    writeJson(res, 200, { turn: bundle });
    return;
  }

  if (sessionKey) {
    const file = sessionFilePath(workspaceRoot, sessionKey);
    const entries = await readAllEntries(file);
    if (entries.length === 0) {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    const allTurns = summariseTurns(entries);
    let start = 0;
    if (cursor) {
      const idx = allTurns.findIndex((t) => t.turnId === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = allTurns.slice(start, start + limit);
    const nextCursor =
      start + limit < allTurns.length ? page[page.length - 1]?.turnId ?? null : null;
    writeJson(res, 200, {
      sessionKey,
      botId: ctx.agent.config.botId,
      turns: page,
      nextCursor,
    });
    return;
  }

  // Neither turnId nor sessionKey — fall back to the raw audit log.
  const q = {
    ...(parsed.searchParams.get("event")
      ? { event: parsed.searchParams.get("event") as string }
      : {}),
    ...(numberParam(parsed.searchParams.get("since")) !== undefined
      ? { since: numberParam(parsed.searchParams.get("since")) as number }
      : {}),
    ...(numberParam(parsed.searchParams.get("until")) !== undefined
      ? { until: numberParam(parsed.searchParams.get("until")) as number }
      : {}),
    ...(cursor && /^\d+$/.test(cursor) ? { cursor: Number.parseInt(cursor, 10) } : {}),
    limit,
  };
  const page = await ctx.agent.auditLog.query(q);
  writeJson(res, 200, {
    entries: page.entries,
    nextCursor: page.nextCursor !== null ? String(page.nextCursor) : null,
  });
}

export const complianceRoutes: RouteHandler[] = [
  route("GET", /^\/v1\/compliance(?:\?.*)?$/, handleCompliance),
  route("GET", /^\/v1\/audit(?:\?.*)?$/, handleAudit),
];
