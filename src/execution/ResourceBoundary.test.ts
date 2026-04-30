import { describe, expect, it } from "vitest";
import {
  inspectToolCallResourceBoundary,
  resourceBindingsAreActive,
} from "./ResourceBoundary.js";
import type { ResourceBindings } from "./ExecutionContract.js";

const bindings: ResourceBindings = {
  mode: "enforce",
  allowedWorkspacePaths: ["reports/", "data/source.csv"],
  allowedSourcePaths: ["kb://sources/customer-a"],
  artifactIds: ["artifact_123"],
  resourceIds: ["source-a"],
  dbHandles: ["primary"],
};

describe("ResourceBoundary", () => {
  it("treats empty bindings as inactive", () => {
    expect(
      resourceBindingsAreActive({
        mode: "audit",
        allowedWorkspacePaths: [],
        allowedSourcePaths: [],
        artifactIds: [],
        resourceIds: [],
        dbHandles: [],
      }),
    ).toBe(false);
  });

  it("allows workspace paths under an allowed directory", () => {
    expect(
      inspectToolCallResourceBoundary({
        toolName: "FileRead",
        toolUseId: "tu_1",
        input: { path: "reports/final.md" },
        bindings,
      }).violations,
    ).toEqual([]);
  });

  it("blocks workspace paths outside the binding", () => {
    const out = inspectToolCallResourceBoundary({
      toolName: "FileRead",
      toolUseId: "tu_1",
      input: { path: "secrets/customer.md" },
      bindings,
    });

    expect(out.violations).toEqual([
      expect.objectContaining({
        kind: "workspace_path_outside_binding",
        value: "secrets/customer.md",
        toolName: "FileRead",
      }),
    ]);
  });

  it("blocks Bash commands that read outside allowed workspace paths", () => {
    const out = inspectToolCallResourceBoundary({
      toolName: "Bash",
      toolUseId: "tu_2",
      input: { command: "cat secrets/customer.md", cwd: "." },
      bindings,
    });

    expect(out.violations.map((v) => v.kind)).toContain(
      "workspace_path_outside_binding",
    );
  });

  it("blocks external source downloads when fixed source bindings are active", () => {
    const out = inspectToolCallResourceBoundary({
      toolName: "Bash",
      toolUseId: "tu_3",
      input: { command: "curl https://example.com/data.csv -o reports/data.csv" },
      bindings,
    });

    expect(out.violations).toEqual([
      expect.objectContaining({
        kind: "external_source_outside_binding",
        value: "https://example.com/data.csv",
      }),
    ]);
  });

  it("allows explicitly bound artifact IDs", () => {
    expect(
      inspectToolCallResourceBoundary({
        toolName: "ArtifactRead",
        toolUseId: "tu_4",
        input: { artifactId: "artifact_123" },
        bindings,
      }).violations,
    ).toEqual([]);
  });

  it("blocks unbound artifact IDs", () => {
    expect(
      inspectToolCallResourceBoundary({
        toolName: "ArtifactRead",
        toolUseId: "tu_5",
        input: { artifactId: "artifact_999" },
        bindings,
      }).violations,
    ).toEqual([
      expect.objectContaining({
        kind: "artifact_outside_binding",
        value: "artifact_999",
      }),
    ]);
  });
});
