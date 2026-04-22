/**
 * ArtifactRead — T4-20 §7.12.a
 *
 * Reads an artifact at a chosen tier. Use L2 when you need structured
 * fields (cheap), L1 for a 2-line summary (also cheap), L0 for full
 * content (heaviest — only when you actually need to quote/transform).
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { ArtifactManager, ArtifactMeta } from "../artifacts/ArtifactManager.js";
import { errorResult } from "../util/toolResult.js";

export interface ArtifactReadInput {
  artifactId: string;
  tier?: "L0" | "L1" | "L2";
}

export interface ArtifactReadOutput {
  content: string;
  meta: ArtifactMeta;
  tier: "L0" | "L1" | "L2";
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    artifactId: { type: "string" },
    tier: {
      type: "string",
      enum: ["L0", "L1", "L2"],
      description: "L0=full | L1=2-line overview | L2=structured abstract. Defaults to L0.",
    },
  },
  required: ["artifactId"],
} as const;

export function makeArtifactReadTool(
  manager: ArtifactManager,
): Tool<ArtifactReadInput, ArtifactReadOutput> {
  return {
    name: "ArtifactRead",
    description:
      "Read an artifact at a chosen tier. L2 (structured fields) and L1 (2-line summary) " +
      "are cheap and good for most situations. Only request L0 (full content) when you " +
      "need to quote or transform the original.",
    inputSchema: INPUT_SCHEMA,
    permission: "read",
    async execute(
      input: ArtifactReadInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<ArtifactReadOutput>> {
      const start = Date.now();
      try {
        const tier = input.tier ?? "L0";
        const meta = await manager.getMeta(input.artifactId);
        const content =
          tier === "L0"
            ? await manager.readL0(input.artifactId)
            : tier === "L1"
              ? await manager.readL1(input.artifactId)
              : await manager.readL2(input.artifactId);
        return {
          status: "ok",
          output: { content, meta, tier },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
