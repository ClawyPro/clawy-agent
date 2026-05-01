import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { StructuredBlock } from "./docxDriver.js";
import { writeHwpxFromBlocks } from "./hwpxDriver.js";

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HWPX_VALIDATE_SCRIPT = path.resolve(MODULE_DIR, "../../../runtime/hwpx/scripts/validate.py");
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hwpx-driver-"));
  roots.push(root);
  return root;
}

async function readHwpxEntry(absPath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync("python3", [
    "-c",
    [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1]) as zf:",
      "    sys.stdout.write(zf.read(sys.argv[2]).decode('utf-8'))",
    ].join("\n"),
    absPath,
    entry,
  ]);
  return stdout;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("writeHwpxFromBlocks", () => {
  it("creates a structurally valid hwpx package with the bundled runtime", async () => {
    const root = await makeRoot();
    const absPath = path.join(root, "minutes.hwpx");
    const blocks: StructuredBlock[] = [
      { type: "heading", level: 1, text: "회의록" },
      { type: "paragraph", text: "참석자: 제품팀, 플랫폼팀" },
      { type: "paragraph", text: "안건: 문서 출력 기능 네이티브 승격" },
    ];

    await writeHwpxFromBlocks({
      absPath,
      title: "회의록",
      template: "minutes",
      blocks,
    });

    const { stdout } = await execFileAsync("python3", [
      HWPX_VALIDATE_SCRIPT,
      absPath,
    ]);

    expect(stdout).toContain("VALID:");
  });

  it("renders headings, bullets, and markdown-like tables as styled HWPX structure", async () => {
    const root = await makeRoot();
    const absPath = path.join(root, "investment-report.hwpx");
    const blocks: StructuredBlock[] = [
      { type: "heading", level: 1, text: "투자심사 리포트" },
      { type: "paragraph", text: "요약: 프리미엄 증류주 시장성과 수익성을 확인했습니다." },
      { type: "heading", level: 2, text: "핵심 지표" },
      { type: "paragraph", text: "지표 | 값 | 판단\n매출 | 2.1억 | 성장\n영업이익 | 0.01억 | 흑자 전환" },
      { type: "heading", level: 2, text: "실행 과제" },
      { type: "paragraph", text: "• 브랜드 스토리 정리\n• 원료 IP 확장" },
    ];

    await writeHwpxFromBlocks({
      absPath,
      title: "투자심사 리포트",
      blocks,
    });

    const section = await readHwpxEntry(absPath, "Contents/section0.xml");
    expect(section).toMatch(/charPrIDRef="7"[\s\S]*<hp:t>투자심사 리포트<\/hp:t>/);
    expect(section).toMatch(/charPrIDRef="8"[\s\S]*<hp:t>핵심 지표<\/hp:t>/);
    expect(section).toContain("<hp:tbl");
    expect(section).toContain('rowCnt="3"');
    expect(section).toContain('colCnt="3"');
    expect(section).toContain("<hp:t>매출</hp:t>");
    expect(section).not.toContain("지표 | 값 | 판단");
    expect(section).toContain("<hp:t>• 브랜드 스토리 정리</hp:t>");
    expect(section).toContain("<hp:t>• 원료 IP 확장</hp:t>");

    const { stdout } = await execFileAsync("python3", [
      HWPX_VALIDATE_SCRIPT,
      absPath,
    ]);
    expect(stdout).toContain("VALID:");
  });

  it("rewrites an existing hwpx file in place for edit flows", async () => {
    const root = await makeRoot();
    const absPath = path.join(root, "memo.hwpx");

    await writeHwpxFromBlocks({
      absPath,
      title: "초안",
      template: "report",
      blocks: [{ type: "paragraph", text: "초안 본문" }],
    });

    await writeHwpxFromBlocks({
      absPath,
      title: "수정본",
      template: "report",
      blocks: [{ type: "paragraph", text: "수정된 본문" }],
    });

    const bytes = await fs.readFile(absPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });
});
