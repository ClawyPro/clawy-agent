import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OutputArtifactRegistry } from "../output/OutputArtifactRegistry.js";
import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { errorResult } from "../util/toolResult.js";
import { markdownToStructuredBlocks, writeDocxFromBlocks, type StructuredBlock } from "./document/docxDriver.js";
import { renderMarkdownToHtml } from "./document/htmlDriver.js";
import { writeHwpxFromBlocks, type HwpxTemplate } from "./document/hwpxDriver.js";
import { writePdfFromBlocks } from "./document/pdfDriver.js";
import {
  markdownToPlainText,
  structuredBlocksToMarkdown,
  structuredBlocksToPlainText,
  writeTextFile,
} from "./document/textDriver.js";

type DocumentOutputFormat = "html" | "docx" | "hwpx" | "md" | "txt" | "pdf";
type MarkdownSourceKind = "markdown" | "text" | "plain_text";
type DocumentWriteSourceInput =
  | string
  | {
      kind?: MarkdownSourceKind;
      type?: MarkdownSourceKind;
      content?: string;
      markdown?: string;
      text?: string;
    }
  | {
      kind?: "structured";
      type?: "structured";
      blocks: StructuredBlock[];
    };

const SUPPORTED_FORMATS: readonly DocumentOutputFormat[] = [
  "html",
  "docx",
  "hwpx",
  "md",
  "txt",
  "pdf",
];

export interface DocumentWriteInput {
  mode: "create" | "edit";
  format: DocumentOutputFormat;
  title: string;
  filename: string;
  template?: HwpxTemplate;
  source: DocumentWriteSourceInput;
}

type NormalizedDocumentSource =
  | { kind: "markdown"; content: string }
  | { kind: "structured"; blocks: StructuredBlock[] };

export interface DocumentWriteOutput {
  artifactId: string;
  workspacePath: string;
  filename: string;
}

const STRUCTURED_BLOCK_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["heading", "paragraph"] },
    text: { type: "string" },
    level: { type: "number", enum: [1, 2, 3] },
  },
  required: ["type", "text"],
  additionalProperties: false,
} as const;

const SOURCE_SCHEMA = {
  anyOf: [
    {
      type: "string",
      description: "Markdown or plain text document content.",
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["markdown", "text", "plain_text"] },
        type: { type: "string", enum: ["markdown", "text", "plain_text"] },
        content: { type: "string" },
        markdown: { type: "string" },
        text: { type: "string" },
      },
      anyOf: [
        { required: ["content"] },
        { required: ["markdown"] },
        { required: ["text"] },
      ],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["structured"] },
        type: { type: "string", enum: ["structured"] },
        blocks: {
          type: "array",
          items: STRUCTURED_BLOCK_SCHEMA,
        },
      },
      required: ["blocks"],
      additionalProperties: false,
    },
  ],
} as const;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["create", "edit"] },
    format: { type: "string", enum: SUPPORTED_FORMATS },
    title: { type: "string" },
    filename: { type: "string" },
    template: { type: "string", enum: ["base", "gonmun", "report", "minutes"] },
    source: SOURCE_SCHEMA,
  },
  required: ["mode", "format", "title", "filename", "source"],
  additionalProperties: false,
} as const;

function basename(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function isDocumentOutputFormat(format: unknown): format is DocumentOutputFormat {
  return typeof format === "string" && SUPPORTED_FORMATS.includes(format as DocumentOutputFormat);
}

function mimeTypeFor(format: DocumentOutputFormat): string {
  switch (format) {
    case "html":
      return "text/html";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "hwpx":
      return "application/hwp+zip";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "pdf":
      return "application/pdf";
  }
}

function previewKindFor(format: DocumentOutputFormat): "inline-html" | "inline-markdown" | "download-only" {
  if (format === "html") return "inline-html";
  if (format === "md") return "inline-markdown";
  return "download-only";
}

function isMarkdownSourceKind(kind: string | undefined): kind is MarkdownSourceKind | undefined {
  return kind === undefined || kind === "markdown" || kind === "text" || kind === "plain_text";
}

function firstStringField(raw: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "string") return value;
  }
  return null;
}

function normalizeSource(source: DocumentWriteInput["source"]): NormalizedDocumentSource {
  if (typeof source === "string") {
    return { kind: "markdown", content: source };
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("source must be a markdown string or an object with content or blocks");
  }

  const raw = source as Record<string, unknown>;
  const kind = typeof raw.kind === "string"
    ? raw.kind
    : typeof raw.type === "string"
      ? raw.type
      : undefined;

  const content = firstStringField(raw, ["content", "markdown", "text"]);
  if (content !== null && isMarkdownSourceKind(kind)) {
    return { kind: "markdown", content };
  }
  if ((kind === undefined || kind === "structured") && Array.isArray(raw.blocks)) {
    return { kind: "structured", blocks: raw.blocks as StructuredBlock[] };
  }
  if (kind === "structured") {
    throw new Error("source.blocks must be an array for structured source");
  }
  if (isMarkdownSourceKind(kind)) {
    throw new Error("source.content must be a string for markdown source");
  }
  throw new Error(`unsupported source: ${kind ?? "undefined"}`);
}

async function maybeCreateHwpxReferenceCopy(
  workspaceRoot: string,
  input: DocumentWriteInput,
): Promise<string | null> {
  if (input.mode !== "edit" || input.format !== "hwpx") {
    return null;
  }
  const sourcePath = path.join(workspaceRoot, input.filename);
  try {
    await fs.access(sourcePath);
  } catch {
    return null;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "document-write-hwpx-ref-"));
  const referencePath = path.join(tempRoot, path.basename(input.filename));
  await fs.copyFile(sourcePath, referencePath);
  return referencePath;
}

export function makeDocumentWriteTool(
  workspaceRoot: string,
  outputRegistry: OutputArtifactRegistry,
): Tool<DocumentWriteInput, DocumentWriteOutput> {
  return {
    name: "DocumentWrite",
    description:
      "Create or edit user-facing md, txt, html, pdf, docx, and hwpx documents inside the bot workspace and register the result as an output artifact.",
    inputSchema: INPUT_SCHEMA,
    permission: "write",
    validate(input) {
      if (!input || (input.mode !== "create" && input.mode !== "edit")) {
        return "`mode` must be create or edit";
      }
      if (!isDocumentOutputFormat(input.format)) {
        return "`format` must be md, txt, html, pdf, docx, or hwpx";
      }
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        return "`title` is required";
      }
      if (typeof input.filename !== "string" || input.filename.trim().length === 0) {
        return "`filename` is required";
      }
      try {
        normalizeSource(input.source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `invalid source: ${message}`;
      }
      return null;
    },
    async execute(
      input: DocumentWriteInput,
      ctx: ToolContext,
    ): Promise<ToolResult<DocumentWriteOutput>> {
      const start = Date.now();
      let referencePath: string | null = null;
      try {
        const source = normalizeSource(input.source);
        const absPath = path.join(workspaceRoot, input.filename);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        referencePath = await maybeCreateHwpxReferenceCopy(workspaceRoot, input);

        if (input.format === "html" && source.kind === "markdown") {
          await fs.writeFile(absPath, renderMarkdownToHtml(source.content), "utf8");
        } else if (input.format === "html" && source.kind === "structured") {
          await fs.writeFile(absPath, renderMarkdownToHtml(structuredBlocksToMarkdown(source.blocks)), "utf8");
        } else if (input.format === "docx" && source.kind === "structured") {
          await writeDocxFromBlocks(absPath, source.blocks);
        } else if (input.format === "docx" && source.kind === "markdown") {
          await writeDocxFromBlocks(absPath, markdownToStructuredBlocks(source.content));
        } else if (input.format === "hwpx" && source.kind === "structured") {
          await writeHwpxFromBlocks({
            absPath,
            title: input.title,
            template: input.template,
            blocks: source.blocks,
            referencePath: referencePath ?? undefined,
          });
        } else if (input.format === "md" && source.kind === "structured") {
          await writeTextFile(absPath, structuredBlocksToMarkdown(source.blocks));
        } else if (input.format === "md" && source.kind === "markdown") {
          await writeTextFile(absPath, source.content);
        } else if (input.format === "txt" && source.kind === "structured") {
          await writeTextFile(absPath, structuredBlocksToPlainText(source.blocks));
        } else if (input.format === "txt" && source.kind === "markdown") {
          await writeTextFile(absPath, markdownToPlainText(source.content));
        } else if (input.format === "pdf" && source.kind === "structured") {
          await writePdfFromBlocks(absPath, input.title, source.blocks);
        } else if (input.format === "pdf" && source.kind === "markdown") {
          await writePdfFromBlocks(absPath, input.title, markdownToStructuredBlocks(source.content));
        } else {
          throw new Error(`unsupported combination: ${input.format}/${source.kind}`);
        }

        const artifact = await outputRegistry.register({
          sessionKey: ctx.sessionKey,
          turnId: ctx.turnId,
          kind: "document",
          format: input.format,
          title: input.title,
          filename: basename(input.filename),
          mimeType: mimeTypeFor(input.format),
          workspacePath: input.filename,
          previewKind: previewKindFor(input.format),
          createdByTool: "DocumentWrite",
          sourceKind: source.kind,
        });

        return {
          status: "ok",
          output: {
            artifactId: artifact.artifactId,
            workspacePath: input.filename,
            filename: basename(input.filename),
          },
          durationMs: Date.now() - start,
        };
      } catch (error) {
        return errorResult(error, start);
      } finally {
        if (referencePath) {
          await fs.rm(path.dirname(referencePath), { recursive: true, force: true });
        }
      }
    },
  };
}
