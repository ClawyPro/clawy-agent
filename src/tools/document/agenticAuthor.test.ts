import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../Tool.js";
import type { LLMClient, LLMEvent, LLMStreamRequest } from "../../transport/LLMClient.js";
import { writeDocumentAgentically } from "./agenticAuthor.js";
import { HWPX_RUNTIME_ROOT, writeHwpxFromBlocks } from "./hwpxDriver.js";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-author-"));
  roots.push(root);
  return root;
}

function toolUseEvents(id: string, name: string, input: object): LLMEvent[] {
  return [
    { kind: "tool_use_start", blockIndex: 0, id, name },
    { kind: "tool_use_input_delta", blockIndex: 0, partial: JSON.stringify(input) },
    { kind: "block_stop", blockIndex: 0 },
    {
      kind: "message_end",
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("writeDocumentAgentically", () => {
  it("keeps looping through tool errors until the requested document exists", async () => {
    const root = await makeRoot();
    const requests: LLMStreamRequest[] = [];
    let calls = 0;
    const llm = {
      stream: async function* (request: LLMStreamRequest) {
        requests.push(request);
        calls += 1;
        const events = calls === 1
          ? toolUseEvents("tu_read", "read_file", { filename: "missing.txt" })
          : toolUseEvents("tu_write", "write_file", {
              filename: "output.docx",
              content: "PK agentic docx bytes",
            });
        for (const event of events) {
          yield event;
        }
      },
    } as unknown as LLMClient;

    const absPath = path.join(root, "exports", "memo.docx");
    const result = await writeDocumentAgentically(
      {
        format: "docx",
        mode: "create",
        title: "Agentic Memo",
        filename: "exports/memo.docx",
        absPath,
        workspaceRoot: root,
        sourceMarkdown: "# Agentic Memo\n\nUse an iterative tool loop.",
        ctx: ctx(root),
      },
      { llm, fallbackModel: "test-model", maxTurns: 3 },
    );

    expect(result).toMatchObject({
      mode: "agentic",
      turns: 2,
      toolCallCount: 2,
      model: "test-model",
    });
    expect(calls).toBe(2);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      "write_file",
      "read_file",
      "run_command",
    ]);
    expect(requests[0]?.thinking).toEqual({ type: "disabled" });
    expect(requests[0]?.messages[0]?.content).toContain("# Agentic Memo");
    await expect(fs.readFile(absPath, "utf8")).resolves.toBe("PK agentic docx bytes");
  });

  it("prompts hwpx edits to analyze the reference and run page guard", async () => {
    const root = await makeRoot();
    const referencePath = path.join(root, "reference.hwpx");
    await writeHwpxFromBlocks({
      absPath: referencePath,
      title: "Reference Edit",
      blocks: [
        { type: "heading", level: 1, text: "Reference Edit" },
        { type: "paragraph", text: "Keep the original layout." },
      ],
    });
    const requests: LLMStreamRequest[] = [];
    let calls = 0;
    const llm = {
      stream: async function* (request: LLMStreamRequest) {
        requests.push(request);
        calls += 1;
        const events = calls === 1
          ? toolUseEvents("tu_analyze", "run_command", {
              command: "python3",
              args: [
                path.join(HWPX_RUNTIME_ROOT, "scripts", "analyze_template.py"),
                "reference.hwpx",
                "--extract-header",
                "ref_header.xml",
                "--extract-section",
                "ref_section.xml",
              ],
            })
          : toolUseEvents("tu_build", "run_command", {
              command: "python3",
              args: [
                path.join(HWPX_RUNTIME_ROOT, "scripts", "build_hwpx.py"),
                "--header",
                "ref_header.xml",
                "--section",
                "ref_section.xml",
                "--title",
                "Reference Edit",
                "--output",
                "output.hwpx",
              ],
            });
        for (const event of events) {
          yield event;
        }
      },
    } as unknown as LLMClient;

    const absPath = path.join(root, "exports", "edited.hwpx");
    await writeDocumentAgentically(
      {
        format: "hwpx",
        mode: "edit",
        title: "Reference Edit",
        filename: "exports/edited.hwpx",
        absPath,
        workspaceRoot: root,
        sourceMarkdown: "# Reference Edit\n\nKeep the original layout.",
        referencePath,
        ctx: ctx(root),
      } as never,
      { llm, fallbackModel: "test-model", maxTurns: 3 },
    );

    const system = String(requests[0]?.system ?? "");
    expect(system).toContain("reference.hwpx");
    expect(system).toContain("analyze_template.py");
    expect(system).toContain("page_guard.py");
    expect(system).toMatch(/preserve/i);
    const user = requests[0]?.messages[0]?.content;
    expect(user).toContain("Reference HWPX file available: reference.hwpx");
    expect(calls).toBe(2);
  });

  it("keeps looping when an agent writes a placeholder HWPX instead of a valid package", async () => {
    const root = await makeRoot();
    const requests: LLMStreamRequest[] = [];
    const lastMessageSnapshots: string[] = [];
    const starterSection = await fs.readFile(
      path.join(HWPX_RUNTIME_ROOT, "templates", "base", "Contents", "section0.xml"),
      "utf8",
    );
    let calls = 0;
    const llm = {
      stream: async function* (request: LLMStreamRequest) {
        requests.push(request);
        lastMessageSnapshots.push(JSON.stringify(request.messages.at(-1)?.content));
        calls += 1;
        const events = calls === 1
          ? toolUseEvents("tu_fake", "write_file", {
              filename: "output.hwpx",
              content: "PK placeholder, not a zip",
            })
          : calls === 2
            ? toolUseEvents("tu_section", "write_file", {
                filename: "section0.xml",
                content: starterSection.replace(
                  "<hp:t/>",
                  "<hp:t>Validated HWPX 검증된 파일만 통과해야 합니다</hp:t>",
                ),
              })
            : toolUseEvents("tu_build", "run_command", {
                command: "python3",
                args: [
                  path.join(HWPX_RUNTIME_ROOT, "scripts", "build_hwpx.py"),
                  "--section",
                  "section0.xml",
                  "--title",
                  "Validated HWPX",
                  "--output",
                  "output.hwpx",
                ],
              });
        for (const event of events) {
          yield event;
        }
      },
    } as unknown as LLMClient;

    const absPath = path.join(root, "exports", "validated.hwpx");
    const result = await writeDocumentAgentically(
      {
        format: "hwpx",
        mode: "create",
        title: "Validated HWPX",
        filename: "exports/validated.hwpx",
        absPath,
        workspaceRoot: root,
        sourceMarkdown: "# Validated HWPX\n\n검증된 파일만 통과해야 합니다.",
        ctx: ctx(root),
      },
      { llm, fallbackModel: "test-model", maxTurns: 4 },
    );

    expect(result).toMatchObject({
      mode: "agentic",
      turns: 3,
      toolCallCount: 3,
    });
    expect(calls).toBe(3);
    expect(String(requests[0]?.system ?? "")).toContain("--template report");
    expect(lastMessageSnapshots[1]).toContain("not ready");
    const bytes = await fs.readFile(absPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("keeps looping when an agent builds an empty starter HWPX without source content", async () => {
    const root = await makeRoot();
    const requests: LLMStreamRequest[] = [];
    const lastMessageSnapshots: string[] = [];
    const starterSection = await fs.readFile(
      path.join(HWPX_RUNTIME_ROOT, "templates", "report", "section0.xml"),
      "utf8",
    );
    let calls = 0;
    const llm = {
      stream: async function* (request: LLMStreamRequest) {
        requests.push(request);
        lastMessageSnapshots.push(JSON.stringify(request.messages.at(-1)?.content));
        calls += 1;
        const events = calls === 1
          ? toolUseEvents("tu_empty_build", "run_command", {
              command: "python3",
              args: [
                path.join(HWPX_RUNTIME_ROOT, "scripts", "build_hwpx.py"),
                "--template",
                "report",
                "--section",
                "starter_section0.xml",
                "--title",
                "NAEOE Investment Report",
                "--output",
                "output.hwpx",
              ],
            })
          : calls === 2
            ? toolUseEvents("tu_section", "write_file", {
                filename: "section0.xml",
                content: starterSection
                  .replace("{{보고서 제목}}", "NAEOE Investment Report")
                  .replace("{{본문 내용}}", "핵심 매출 2억원 흑자전환 기능성 원료 ORYZEN")
                  .replace("{{결론 내용}}", "STRONG PASS 투자 권고"),
              })
            : toolUseEvents("tu_build", "run_command", {
                command: "python3",
                args: [
                  path.join(HWPX_RUNTIME_ROOT, "scripts", "build_hwpx.py"),
                  "--template",
                  "report",
                  "--section",
                  "section0.xml",
                  "--title",
                  "NAEOE Investment Report",
                  "--output",
                  "output.hwpx",
                ],
              });
        for (const event of events) {
          yield event;
        }
      },
    } as unknown as LLMClient;

    const absPath = path.join(root, "exports", "naioe.hwpx");
    const result = await writeDocumentAgentically(
      {
        format: "hwpx",
        mode: "create",
        title: "NAEOE Investment Report",
        filename: "exports/naioe.hwpx",
        absPath,
        workspaceRoot: root,
        sourceMarkdown:
          "# NAEOE Investment Report\n\n핵심 매출 2억원 흑자전환 기능성 원료 ORYZEN\n\nSTRONG PASS 투자 권고",
        ctx: ctx(root),
      },
      { llm, fallbackModel: "test-model", maxTurns: 4 },
    );

    expect(result).toMatchObject({
      mode: "agentic",
      turns: 3,
      toolCallCount: 3,
    });
    expect(calls).toBe(3);
    expect(lastMessageSnapshots[1]).toContain("source content");
    const bytes = await fs.readFile(absPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });
});
