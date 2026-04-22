/**
 * ArtifactDelete — T4-20 §7.12.a
 * Removes the artifact directory + drops its index entry.
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { ArtifactManager } from "../artifacts/ArtifactManager.js";
import { errorResult } from "../util/toolResult.js";

export interface ArtifactDeleteInput {
  artifactId: string;
}

export interface ArtifactDeleteOutput {
  deleted: boolean;
  artifactId: string;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
  },
  required: ["artifactId"],
} as const;

export function makeArtifactDeleteTool(
  manager: ArtifactManager,
): Tool<ArtifactDeleteInput, ArtifactDeleteOutput> {
  return {
    name: "ArtifactDelete",
    description:
      "Delete a persistent artifact (L0 + L1 + L2 sidecars + index entry). Irreversible.",
    inputSchema: INPUT_SCHEMA,
    permission: "write",
    dangerous: true,
    async execute(
      input: ArtifactDeleteInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<ArtifactDeleteOutput>> {
      const start = Date.now();
      try {
        await manager.delete(input.artifactId);
        return {
          status: "ok",
          output: { deleted: true, artifactId: input.artifactId },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
