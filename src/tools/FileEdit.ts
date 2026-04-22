/**
 * FileEdit — find-and-replace within a workspace file.
 * Fails if `old_string` is not unique (unless `replace_all`).
 *
 * T1-03b: resolves ctx.spawnWorkspace ?? defaultWorkspace per call.
 */

import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { Workspace } from "../storage/Workspace.js";
import { errorResult } from "../util/toolResult.js";
import { readSafe, writeSafe, isFsSafeEscape } from "../util/fsSafe.js";

export interface FileEditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileEditOutput {
  path: string;
  replaced: number;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Workspace-relative path." },
    old_string: { type: "string", description: "Exact text to find (including whitespace)." },
    new_string: { type: "string", description: "Replacement text." },
    replace_all: {
      type: "boolean",
      default: false,
      description: "Replace every occurrence. Default false — fails if old_string is not unique.",
    },
  },
  required: ["path", "old_string", "new_string"],
} as const;

export function makeFileEditTool(workspaceRoot: string): Tool<FileEditInput, FileEditOutput> {
  const defaultWorkspace = new Workspace(workspaceRoot);
  return {
    name: "FileEdit",
    description:
      "Find-and-replace within a workspace file. old_string must match exactly once unless replace_all=true. Use this instead of FileWrite when only a small change is needed.",
    inputSchema: INPUT_SCHEMA,
    permission: "write",
    validate(input) {
      if (!input || typeof input.path !== "string") return "`path` is required";
      if (typeof input.old_string !== "string" || input.old_string.length === 0) {
        return "`old_string` is required (non-empty)";
      }
      if (typeof input.new_string !== "string") return "`new_string` must be a string";
      if (input.old_string === input.new_string) {
        return "`old_string` and `new_string` must differ";
      }
      return null;
    },
    async execute(
      input: FileEditInput,
      ctx: ToolContext,
    ): Promise<ToolResult<FileEditOutput>> {
      const start = Date.now();
      try {
        const ws = ctx.spawnWorkspace ?? defaultWorkspace;
        // Safe read — FD-based realpath blocks symlink-swap TOCTOU.
        const content = await readSafe(input.path, ws.root);
        let next = content;
        let replaced = 0;
        if (input.replace_all) {
          const parts = content.split(input.old_string);
          replaced = parts.length - 1;
          if (replaced === 0) {
            return {
              status: "error",
              errorCode: "not_found",
              errorMessage: `old_string not found in ${input.path}`,
              durationMs: Date.now() - start,
            };
          }
          next = parts.join(input.new_string);
        } else {
          const first = content.indexOf(input.old_string);
          if (first < 0) {
            return {
              status: "error",
              errorCode: "not_found",
              errorMessage: `old_string not found in ${input.path}`,
              durationMs: Date.now() - start,
            };
          }
          const second = content.indexOf(input.old_string, first + input.old_string.length);
          if (second >= 0) {
            return {
              status: "error",
              errorCode: "not_unique",
              errorMessage: `old_string appears more than once in ${input.path}; use replace_all or extend with surrounding context`,
              durationMs: Date.now() - start,
            };
          }
          next =
            content.slice(0, first) + input.new_string + content.slice(first + input.old_string.length);
          replaced = 1;
        }
        // Safe write — re-validate via FD realpath before committing.
        await writeSafe(input.path, next, ws.root);
        return {
          status: "ok",
          output: { path: input.path, replaced },
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
