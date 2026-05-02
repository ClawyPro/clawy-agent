import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "../../Agent.js";
import type { HttpServerCtx } from "./_helpers.js";
import { skillsRoutes } from "./skills.js";

function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: "",
    headersSent: false,
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    end(body?: string) {
      res._body = body ?? "";
    },
  } as unknown as ServerResponse & { _status: number; _body: string };
  return res;
}

function makeCtx(
  reloadWorkspaceSkills = vi.fn().mockResolvedValue({
    loaded: 2,
    issues: 0,
    runtimeHooks: 0,
  }),
): HttpServerCtx {
  return {
    bearerToken: "gateway-token",
    agent: { reloadWorkspaceSkills } as unknown as Agent,
  };
}

describe("skills admin routes", () => {
  const handler = skillsRoutes[0]!;

  it("matches POST /v1/admin/skills/reload", () => {
    const match = handler.match(
      mockReq("POST", "/v1/admin/skills/reload"),
      "/v1/admin/skills/reload",
    );
    expect(match).toBeTruthy();
  });

  it("returns 401 without gateway token", async () => {
    const res = mockRes();
    const ctx = makeCtx();
    const req = mockReq("POST", "/v1/admin/skills/reload");
    const match = handler.match(req, "/v1/admin/skills/reload");

    await handler.handle(req, res, match!, ctx);

    expect(res._status).toBe(401);
  });

  it("reloads workspace skills with a valid gateway token", async () => {
    const reloadWorkspaceSkills = vi.fn().mockResolvedValue({
      loaded: 3,
      issues: 1,
      runtimeHooks: 0,
    });
    const res = mockRes();
    const ctx = makeCtx(reloadWorkspaceSkills);
    const req = mockReq("POST", "/v1/admin/skills/reload", {
      "x-gateway-token": "gateway-token",
    });
    const match = handler.match(req, "/v1/admin/skills/reload");

    await handler.handle(req, res, match!, ctx);

    expect(reloadWorkspaceSkills).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      ok: true,
      loaded: 3,
      issues: 1,
      runtimeHooks: 0,
    });
  });
});
