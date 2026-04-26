/**
 * Health routes — /health (lean) + /healthz (rich: tools, skills, hooks).
 *
 * Both endpoints are unauthenticated on purpose: /healthz is what
 * health-monitor pings every 15s; adding auth just to fail-open would
 * be lossy.
 */

import { route, writeJson, type RouteHandler } from "./_helpers.js";

export const healthRoutes: RouteHandler[] = [
  route("GET", /^\/health(?:\?.*)?$/, async (_req, res, _m, ctx) => {
    writeJson(res, 200, {
      ok: true,
      botId: ctx.agent.config.botId,
      runtime: "clawy-agent",
      version: "0.1.0",
    });
  }),
  route("GET", /^\/healthz(?:\?.*)?$/, async (_req, res, _m, ctx) => {
    const tools = ctx.agent.tools.list();
    const skillReport = ctx.agent.tools.skillReport();
    writeJson(res, 200, {
      ok: true,
      botId: ctx.agent.config.botId,
      runtime: "clawy-agent",
      version: "0.1.0",
      tools: tools.map((t) => ({ name: t.name, permission: t.permission })),
      skills: skillReport
        ? {
            loaded: skillReport.loaded.length,
            issues: skillReport.issues,
          }
        : null,
      hooks: ctx.agent.hooks.list().map((h) => ({
        name: h.name,
        point: h.point,
        priority: h.priority ?? 100,
        blocking: h.blocking !== false,
      })),
    });
  }),
];
