/**
 * FileRead — read a workspace file as text.
 *
 * T1-03b: factory captures a default Workspace over `workspaceRoot`; at
 * runtime every execute() consults `ctx.spawnWorkspace ?? defaultWorkspace`
 * so spawned children are scoped to their ephemeral subdirectory rather
 * than the parent's full PVC root (PRE-01 completion).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { Workspace } from "../storage/Workspace.js";
import { errorResult } from "../util/toolResult.js";
import { readSafe, statSafe, isFsSafeEscape } from "../util/fsSafe.js";

export interface FileReadInput {
  path: string;
  /** Optional 1-based line offset. */
  offset?: number;
  /** Optional line count. */
  limit?: number;
}

export interface FileReadOutput {
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Workspace-relative path to read." },
    offset: { type: "integer", minimum: 1, description: "1-based line to start at." },
    limit: { type: "integer", minimum: 1, description: "Max lines to return." },
  },
  required: ["path"],
} as const;

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB hard cap

export function makeFileReadTool(workspaceRoot: string): Tool<FileReadInput, FileReadOutput> {
  const defaultWorkspace = new Workspace(workspaceRoot);
  return {
    name: "FileRead",
    description:
      "Read a workspace file. Returns the full text unless offset/limit are given, in which case only those lines are returned.",
    inputSchema: INPUT_SCHEMA,
    permission: "read",
    validate(input) {
      if (!input || typeof input.path !== "string" || input.path.length === 0) {
        return "`path` is required";
      }
      return null;
    },
    async execute(input: FileReadInput, ctx: ToolContext): Promise<ToolResult<FileReadOutput>> {
      const start = Date.now();
      try {
        const ws = ctx.spawnWorkspace ?? defaultWorkspace;
        // Safe stat + read — opens once, re-validates via FD realpath,
        // closes. Blocks symlink-swap TOCTOU (§15.2).
        const stat = await statSafe(input.path, ws.root);
        if (!stat) {
          return {
            status: "error",
            errorCode: "not_found",
            errorMessage: `${input.path} not found`,
            durationMs: Date.now() - start,
          };
        }
        if (!stat.isFile()) {
          return {
            status: "error",
            errorCode: "not_a_file",
            errorMessage: `${input.path} is not a regular file`,
            durationMs: Date.now() - start,
          };
        }
        const raw = await readSafe(input.path, ws.root);
        let content = raw;
        let truncated = false;
        if (input.offset || input.limit) {
          const lines = raw.split("\n");
          const off = Math.max(0, (input.offset ?? 1) - 1);
          const lim = input.limit ?? lines.length - off;
          content = lines.slice(off, off + lim).join("\n");
        }
        if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
          content = content.slice(0, MAX_BYTES);
          truncated = true;
        }
        return {
          status: "ok",
          output: {
            path: input.path,
            content,
            sizeBytes: stat.size,
            truncated,
          },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        if (isFsSafeEscape(err)) {
          return {
            status: "error",
            errorCode: "path_escape",
            errorMessage: `path escape detected: ${(err as Error).message}`,
            durationMs: Date.now() - start,
          };
        }
        return errorResult(err, start);
      }
    },
  };
}

/**
 * Legacy helper — retained because a few callers outside the 6 core
 * tools import it. New code should prefer `Workspace#resolve` directly.
 */
export function resolveInsideWorkspace(root: string, rel: string): string {
  const normalised = path.normalize(rel).replace(/^\/+/, "");
  const full = path.join(root, normalised);
  const absRoot = path.resolve(root);
  const absFull = path.resolve(full);
  if (absFull !== absRoot && !absFull.startsWith(absRoot + path.sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return absFull;
}
