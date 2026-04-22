/**
 * ArtifactList — T4-20 §7.12.a
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { ArtifactManager, ArtifactMeta } from "../artifacts/ArtifactManager.js";
import { errorResult } from "../util/toolResult.js";

export interface ArtifactListInput {
  kind?: string;
}

export interface ArtifactListOutput {
  artifacts: ArtifactMeta[];
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", description: "Optional filter on artifact.kind" },
  },
} as const;

export function makeArtifactListTool(
  manager: ArtifactManager,
): Tool<ArtifactListInput, ArtifactListOutput> {
  return {
    name: "ArtifactList",
    description:
      "List persistent artifacts (reports, plans, analyses, etc.) in the workspace. " +
      "Returns metadata only — use ArtifactRead to fetch content at a chosen tier.",
    inputSchema: INPUT_SCHEMA,
    permission: "read",
    async execute(
      input: ArtifactListInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<ArtifactListOutput>> {
      const start = Date.now();
      try {
        const artifacts = await manager.list(input.kind ? { kind: input.kind } : undefined);
        return {
          status: "ok",
          output: { artifacts },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
