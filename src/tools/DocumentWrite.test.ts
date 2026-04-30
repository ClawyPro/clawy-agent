import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OutputArtifactRegistry } from "../output/OutputArtifactRegistry.js";
import { makeDocumentWriteTool } from "./DocumentWrite.js";
import type { ToolContext } from "../Tool.js";

const roots: string[] = [];

function ctx(root: string): ToolContext {
  return {
    botId: "bot-1",
    sessionKey: "s-1",
    turnId: "t-1",
    workspaceRoot: root,
    askUser: async () => ({ selectedId: "ok" }),
    emitProgress: () => {},
    abortSignal: AbortSignal.timeout(5_000),
    staging: {
      stageFileWrite: () => {},
      stageTranscriptAppend: () => {},
      stageAuditEvent: () => {},
    },
  };
}

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-write-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DocumentWrite", () => {
  it("declares explicit source schema variants for upstream tool callers", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).toContain("\"source\"");
    expect(schema).toContain("\"anyOf\"");
    expect(schema).toContain("\"string\"");
    expect(schema).toContain("\"content\"");
    expect(schema).toContain("\"blocks\"");
  });

  it("creates html from markdown and exposes inline preview", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "html",
        title: "Board Update",
        filename: "exports/board-update.html",
        source: {
          kind: "markdown",
          content: "# Board Update\n\n- Revenue up\n- Burn down",
        },
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const html = await fs.readFile(path.join(root, "exports", "board-update.html"), "utf8");
    expect(html).toContain("<h1>Board Update</h1>");
    expect(html).toContain("<li>Revenue up</li>");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact.previewKind).toBe("inline-html");
  });

  it("creates docx, then edits the same file in place", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const created = await tool.execute(
      {
        mode: "create",
        format: "docx",
        title: "Investor Memo",
        filename: "exports/investor-memo.docx",
        source: {
          kind: "structured",
          blocks: [
            { type: "heading", level: 1, text: "Investor Memo" },
            { type: "paragraph", text: "This document was generated inside the bot pod." },
          ],
        },
      },
      ctx(root),
    );

    expect(created.status).toBe("ok");

    const edited = await tool.execute(
      {
        mode: "edit",
        format: "docx",
        title: "Investor Memo",
        filename: "exports/investor-memo.docx",
        source: {
          kind: "structured",
          blocks: [
            { type: "heading", level: 1, text: "Investor Memo" },
            { type: "paragraph", text: "Updated inside the bot pod." },
          ],
        },
      },
      ctx(root),
    );

    expect(edited.status).toBe("ok");

    const bytes = await fs.readFile(path.join(root, "exports", "investor-memo.docx"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const artifact = await registry.get(edited.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "docx",
      filename: "investor-memo.docx",
      previewKind: "download-only",
    });
  });

  it("creates docx from markdown source", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "docx",
        title: "한글 보고서",
        filename: "exports/korean-report.docx",
        source: {
          kind: "markdown",
          content: "# 한글 보고서\n\n## 요약\n\n본문입니다.",
        },
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const bytes = await fs.readFile(path.join(root, "exports", "korean-report.docx"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "docx",
      sourceKind: "markdown",
      filename: "korean-report.docx",
    });
  });

  it("accepts source.type as a compatibility alias for source.kind", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "docx",
        title: "Compatibility Memo",
        filename: "exports/compatibility-memo.docx",
        source: {
          type: "markdown",
          content: "# Compatibility Memo\n\nGenerated from the legacy alias.",
        } as never,
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const bytes = await fs.readFile(path.join(root, "exports", "compatibility-memo.docx"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("accepts raw string source as markdown content", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "md",
        title: "String Source Memo",
        filename: "exports/string-source.md",
        source: "# String Source Memo\n\nGenerated from a direct source string.",
      } as never,
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const markdown = await fs.readFile(path.join(root, "exports", "string-source.md"), "utf8");
    expect(markdown).toBe("# String Source Memo\n\nGenerated from a direct source string.\n");
  });

  it("infers markdown source from a content-only object", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "pdf",
        title: "Content Source Memo",
        filename: "exports/content-source.pdf",
        source: {
          content: "# Content Source Memo\n\nGenerated without an explicit source kind.",
        },
      } as never,
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const bytes = await fs.readFile(path.join(root, "exports", "content-source.pdf"));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("creates hwpx from structured blocks and registers a downloadable artifact", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "hwpx",
        title: "주간 회의록",
        filename: "exports/weekly-minutes.hwpx",
        template: "minutes",
        source: {
          kind: "structured",
          blocks: [
            { type: "heading", level: 1, text: "주간 회의록" },
            { type: "paragraph", text: "안건 1. 출력 아티팩트 전달" },
          ],
        },
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");

    const bytes = await fs.readFile(path.join(root, "exports", "weekly-minutes.hwpx"));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "hwpx",
      filename: "weekly-minutes.hwpx",
      previewKind: "download-only",
    });
  });

  it("creates markdown from structured blocks and exposes inline markdown preview", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "md",
        title: "Investment Notes",
        filename: "exports/investment-notes.md",
        source: {
          kind: "structured",
          blocks: [
            { type: "heading", level: 1, text: "Investment Notes" },
            { type: "paragraph", text: "Revenue quality is improving." },
          ],
        },
      } as never,
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const markdown = await fs.readFile(path.join(root, "exports", "investment-notes.md"), "utf8");
    expect(markdown).toBe("# Investment Notes\n\nRevenue quality is improving.\n");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "md",
      mimeType: "text/markdown",
      filename: "investment-notes.md",
      previewKind: "inline-markdown",
    });
  });

  it("creates plain text from markdown source", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "txt",
        title: "Summary",
        filename: "exports/summary.txt",
        source: {
          kind: "markdown",
          content: "# Summary\n\n- First point\n- Second point",
        },
      } as never,
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const text = await fs.readFile(path.join(root, "exports", "summary.txt"), "utf8");
    expect(text).toBe("Summary\n\nFirst point\nSecond point\n");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "txt",
      mimeType: "text/plain",
      filename: "summary.txt",
      previewKind: "download-only",
    });
  });

  it("creates pdf from markdown source and registers a downloadable artifact", async () => {
    const root = await makeRoot();
    const registry = new OutputArtifactRegistry(root);
    const tool = makeDocumentWriteTool(root, registry);

    const result = await tool.execute(
      {
        mode: "create",
        format: "pdf",
        title: "Investment Report",
        filename: "exports/investment-report.pdf",
        source: {
          kind: "markdown",
          content: "# Investment Report\n\n## Verdict\n\nStrong pass.",
        },
      } as never,
      ctx(root),
    );

    expect(result.status).toBe("ok");
    const bytes = await fs.readFile(path.join(root, "exports", "investment-report.pdf"));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

    const artifact = await registry.get(result.output!.artifactId);
    expect(artifact).toMatchObject({
      format: "pdf",
      mimeType: "application/pdf",
      filename: "investment-report.pdf",
      previewKind: "download-only",
    });
  });
});
