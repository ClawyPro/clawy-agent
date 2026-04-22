/**
 * POST /mcp — Model Context Protocol gateway (§8.1).
 *
 * External MCP clients (Claude Desktop, Cursor, …) POST JSON-RPC 2.0
 * requests (or batches) here to list / invoke this bot's tools. Auth
 * reuses the same `Authorization: Bearer <token>` gate as
 * /v1/chat/completions; an optional `X-MCP-Client-Id` header is
 * accepted but not required.
 *
 * The wire transport is deliberately a strict subset of MCP:
 *   - tools/list and tools/call supported
 *   - streaming / notifications / resources out of scope (tools-only)
 *   - batch requests ([req, req]) return a batch response in order
 *
 * The JSON-RPC protocol dispatch itself lives in `mcp/McpServer.ts` so
 * this file stays focused on HTTP framing, auth, and error envelopes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorizeBearer,
  route,
  writeJson,
  type HttpServerCtx,
  type RouteHandler,
} from "./_helpers.js";
import {
  McpServer,
  errorResponse,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpHandleOptions,
  type McpPermissionMode,
} from "../../mcp/McpServer.js";

const BODY_LIMIT = 20 * 1024 * 1024; // 20 MB — aligned with readJsonBody cap

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        req.destroy();
        reject(new Error(`body too large (>${BODY_LIMIT} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function permissionModeFromHeaders(req: IncomingMessage): McpPermissionMode {
  const raw = (req.headers["x-mcp-permission-mode"] as string | undefined) ?? "";
  return raw.trim().toLowerCase() === "plan" ? "plan" : "default";
}

function clientIdFromHeaders(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-mcp-client-id"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Coerce a parsed body into a single JSON-RPC request with an explicit
 * shape check. Returns null on anything that isn't a plain object.
 */
function asRequest(raw: unknown): JsonRpcRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as JsonRpcRequest;
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  _match: RegExpMatchArray | boolean,
  ctx: HttpServerCtx,
): Promise<void> {
  if (!authorizeBearer(req, res, ctx)) return;

  const raw = await readRawBody(req).catch((err: Error) => {
    writeJson(res, 413, { error: "body_too_large", message: err.message });
    return null;
  });
  if (raw === null) return;

  if (!raw.trim()) {
    writeJson(
      res,
      200,
      errorResponse(null, JSON_RPC_INVALID_REQUEST, "Empty request"),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeJson(
      res,
      200,
      errorResponse(null, JSON_RPC_PARSE_ERROR, `Parse error: ${msg}`),
    );
    return;
  }

  const mcp = new McpServer({ agent: ctx.agent });

  const options: McpHandleOptions = {
    permissionMode: permissionModeFromHeaders(req),
    ...(clientIdFromHeaders(req) !== undefined
      ? { clientId: clientIdFromHeaders(req) as string }
      : {}),
  };

  // Batch request handling — JSON-RPC 2.0 §6.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      writeJson(
        res,
        200,
        errorResponse(null, JSON_RPC_INVALID_REQUEST, "Empty batch"),
      );
      return;
    }
    const responses: JsonRpcResponse[] = [];
    for (const entry of parsed) {
      const asReq = asRequest(entry);
      if (!asReq) {
        responses.push(
          errorResponse(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
        );
        continue;
      }
      responses.push(await mcp.handle(asReq, options));
    }
    writeJson(res, 200, responses);
    return;
  }

  const asReq = asRequest(parsed);
  if (!asReq) {
    writeJson(
      res,
      200,
      errorResponse(null, JSON_RPC_INVALID_REQUEST, "Invalid Request"),
    );
    return;
  }
  const response = await mcp.handle(asReq, options);
  writeJson(res, 200, response);
}

export const mcpRoutes: RouteHandler[] = [
  route("POST", /^\/mcp(?:\?.*)?$/, handleMcp),
];
