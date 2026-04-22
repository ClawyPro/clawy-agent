/**
 * ArtifactUpdate — T4-20 §7.12.a
 * Replaces L0 content and regenerates L1 + L2 sidecars.
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { ArtifactManager, ArtifactMeta } from "../artifacts/ArtifactManager.js";
import { errorResult } from "../util/toolResult.js";

export interface ArtifactUpdateInput {
  artifactId: string;
  content: string;
}

export interface ArtifactUpdateOutput {
  meta: ArtifactMeta;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
    content: { type: "string", description: "New L0 content (full replacement)" },
  },
  required: ["artifactId", "content"],
} as const;

export function makeArtifactUpdateTool(
  manager: ArtifactManager,
): Tool<ArtifactUpdateInput, ArtifactUpdateOutput> {
  return {
    name: "ArtifactUpdate",
    description:
      "Update an artifact's L0 content. L1 overview and L2 abstract sidecars are " +
      "regenerated automatically so downstream consumers pick up the new summary.",
    inputSchema: INPUT_SCHEMA,
    permission: "write",
    async execute(
      input: ArtifactUpdateInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<ArtifactUpdateOutput>> {
      const start = Date.now();
      try {
        const meta = await manager.update(input.artifactId, input.content);
        return {
          status: "ok",
          output: { meta },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
