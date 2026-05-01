import { describe, expect, it } from "vitest";
import {
  GENERATED_OUTPUT_DIR,
  resolveGeneratedOutputPath,
} from "./generatedOutputPath.js";

describe("generated output paths", () => {
  it("places bare generated filenames under the first-class outputs directory", () => {
    expect(resolveGeneratedOutputPath("report.pdf")).toEqual({
      workspacePath: `${GENERATED_OUTPUT_DIR}/report.pdf`,
      filename: "report.pdf",
    });
  });

  it("preserves nested paths under outputs without duplicating the directory", () => {
    expect(resolveGeneratedOutputPath("outputs/reports/q1.xlsx")).toEqual({
      workspacePath: "outputs/reports/q1.xlsx",
      filename: "q1.xlsx",
    });
  });

  it("redirects legacy explicit folders underneath outputs", () => {
    expect(resolveGeneratedOutputPath("exports/board-update.docx")).toEqual({
      workspacePath: "outputs/exports/board-update.docx",
      filename: "board-update.docx",
    });
  });

  it("rejects absolute paths and path traversal", () => {
    expect(() => resolveGeneratedOutputPath("/tmp/report.pdf")).toThrow(/workspace-relative/);
    expect(() => resolveGeneratedOutputPath("../report.pdf")).toThrow(/path traversal/);
    expect(() => resolveGeneratedOutputPath("reports/../../report.pdf")).toThrow(/path traversal/);
  });
});
