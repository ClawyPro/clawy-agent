import {
  authorizeGateway,
  route,
  writeJson,
  type RouteHandler,
} from "./_helpers.js";

export const skillsRoutes: RouteHandler[] = [
  route(
    "POST",
    /^\/v1\/admin\/skills\/reload(?:\?.*)?$/,
    async (req, res, _match, ctx) => {
      if (!authorizeGateway(req, res, ctx)) return;

      const result = await ctx.agent.reloadWorkspaceSkills();
      writeJson(res, 200, {
        ok: true,
        loaded: result.loaded,
        issues: result.issues,
        runtimeHooks: result.runtimeHooks,
      });
    },
  ),
];
