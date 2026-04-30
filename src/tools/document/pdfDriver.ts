import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { StructuredBlock } from "./docxDriver.js";

const REGULAR_FONT_CANDIDATES = [
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
  "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
  "/System/Library/Fonts/AppleSDGothicNeo.ttc",
];

async function firstExistingPath(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fsPromises.access(candidate);
      return candidate;
    } catch {
      // Try the next known platform font path.
    }
  }
  return null;
}

async function configureBodyFont(doc: PDFKit.PDFDocument): Promise<string> {
  const fontPath = await firstExistingPath(REGULAR_FONT_CANDIDATES);
  if (!fontPath) {
    return "Helvetica";
  }

  try {
    doc.registerFont("ClawyBody", fontPath);
    doc.font("ClawyBody");
    return "ClawyBody";
  } catch {
    return "Helvetica";
  }
}

function addParagraph(doc: PDFKit.PDFDocument, text: string, fontName: string): void {
  doc.font(fontName).fontSize(11).fillColor("black").text(text, {
    align: "left",
    lineGap: 4,
  });
  doc.moveDown(0.8);
}

function addHeading(doc: PDFKit.PDFDocument, block: StructuredBlock, fontName: string): void {
  const level = block.level ?? 1;
  const size = level === 1 ? 20 : level === 2 ? 16 : 13;
  doc.font(fontName).fontSize(size).fillColor("black").text(block.text, {
    align: level === 1 ? "center" : "left",
    lineGap: 3,
  });
  doc.moveDown(level === 1 ? 1 : 0.7);
}

export async function writePdfFromBlocks(
  absPath: string,
  title: string,
  blocks: StructuredBlock[],
): Promise<void> {
  await fsPromises.mkdir(path.dirname(absPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      bufferPages: true,
      info: { Title: title },
    });
    const output = fs.createWriteStream(absPath);
    output.on("finish", resolve);
    output.on("error", reject);
    doc.on("error", reject);
    doc.pipe(output);

    void configureBodyFont(doc)
      .then((fontName) => {
        const documentBlocks = blocks.length > 0
          ? blocks
          : [{ type: "heading" as const, level: 1 as const, text: title }];
        for (const block of documentBlocks) {
          if (block.type === "heading") {
            addHeading(doc, block, fontName);
          } else {
            addParagraph(doc, block.text, fontName);
          }
        }

        const pages = doc.bufferedPageRange();
        for (let i = 0; i < pages.count; i += 1) {
          doc.switchToPage(i);
          doc.font(fontName).fontSize(8).fillColor("gray").text(
            `${i + 1} / ${pages.count}`,
            50,
            doc.page.height - 40,
            { align: "center", width: doc.page.width - 100 },
          );
        }

        doc.end();
      })
      .catch((error: unknown) => {
        doc.destroy();
        reject(error);
      });
  });
}
