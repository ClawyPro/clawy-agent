/**
 * ArtifactCreate — T4-20 §7.12.a
 *
 * Creates a new tiered artifact (L0 full + auto-generated L1 overview
 * + L2 abstract sidecars). See src/artifacts/ArtifactManager.ts.
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import type { ArtifactManager, ArtifactMeta } from "../artifacts/ArtifactManager.js";
import { errorResult } from "../util/toolResult.js";

export interface ArtifactCreateInput {
  kind: string;
  title: string;
  content: string;
  producedBy?: string;
  sources?: string[];
  slug?: string;
}

export interface ArtifactCreateOutput {
  artifactId: string;
  meta: ArtifactMeta;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", description: "Artifact category (report, plan, analysis, doc, ...)" },
    title: { type: "string", description: "Human-readable title" },
    content: { type: "string", description: "Full L0 content (markdown)" },
    producedBy: { type: "string", description: "Persona / tool that produced this artifact" },
    sources: { type: "array", items: { type: "string" } },
    slug: { type: "string", description: "Optional URL-safe slug; derived from title otherwise" },
  },
  required: ["kind", "title", "content"],
} as const;

export function makeArtifactCreateTool(
  manager: ArtifactManager,
): Tool<ArtifactCreateInput, ArtifactCreateOutput> {
  return {
    name: "ArtifactCreate",
    description:
      "Create a persistent artifact (report, plan, analysis, etc.) in the workspace. " +
      "Generates L1 overview + L2 abstract sidecars automatically so later turns can " +
      "inject lightweight summaries instead of the full content. Returns artifactId.",
    inputSchema: INPUT_SCHEMA,
    permission: "write",
    async execute(
      input: ArtifactCreateInput,
      _ctx: ToolContext,
    ): Promise<ToolResult<ArtifactCreateOutput>> {
      const start = Date.now();
      try {
        const meta = await manager.create(input);
        return {
          status: "ok",
          output: { artifactId: meta.artifactId, meta },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
