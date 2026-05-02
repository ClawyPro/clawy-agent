import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../Tool.js";
import { ExecutionContractStore } from "../execution/ExecutionContract.js";
import { makeCalculationTool } from "./Calculation.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "calculation-tool-"));
  roots.push(root);
  return root;
}

function ctx(root: string, contract?: ExecutionContractStore): ToolContext {
  return {
    botId: "bot-1",
    sessionKey: "s-1",
    turnId: "t-1",
    workspaceRoot: root,
    askUser: async () => ({ selectedId: "ok" }),
    emitProgress: () => {},
    abortSignal: AbortSignal.timeout(5_000),
    executionContract: contract,
    staging: {
      stageFileWrite: () => {},
      stageTranscriptAppend: () => {},
      stageAuditEvent: () => {},
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Calculation", () => {
  it("calculates averages from rows without relying on model arithmetic", async () => {
    const root = await makeRoot();
    const tool = makeCalculationTool();

    const result = await tool.execute(
      {
        operation: "average",
        field: "sales",
        rows: [
          { date: "2026-04-01", sales: "10" },
          { date: "2026-04-02", sales: 20 },
          { date: "2026-04-03", sales: null },
          { date: "2026-04-04", sales: 30 },
        ],
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    expect(result.output).toMatchObject({
      operation: "average",
      field: "sales",
      result: 20,
      rowCount: 4,
      numericCount: 3,
      ignoredCount: 1,
      sum: 60,
    });
  });

  it("calculates percent change from deterministic numeric inputs", async () => {
    const root = await makeRoot();
    const tool = makeCalculationTool();

    const result = await tool.execute(
      { operation: "percent_change", before: 80, after: 100, rows: [] },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    expect(result.output).toMatchObject({
      operation: "percent_change",
      before: 80,
      after: 100,
      result: 25,
    });
  });

  it("records calculation evidence on the execution contract", async () => {
    const root = await makeRoot();
    const contract = new ExecutionContractStore({ now: () => 1 });
    contract.recordDeterministicRequirement({
      requirementId: "dr_calc",
      source: "llm_classifier",
      status: "active",
      kinds: ["calculation"],
      reason: "Need average.",
      suggestedTools: ["Calculation"],
      acceptanceCriteria: [],
    });
    const tool = makeCalculationTool();

    const result = await tool.execute(
      {
        operation: "sum",
        field: "sales",
        rows: [{ sales: 10 }, { sales: 20 }],
        requirementId: "dr_calc",
        resourceIds: ["workspace:data/sales.csv"],
      },
      ctx(root, contract),
    );

    expect(result.status).toBe("ok");
    expect(contract.snapshot().taskState.deterministicEvidence[0]).toMatchObject({
      requirementIds: ["dr_calc"],
      toolName: "Calculation",
      kind: "calculation",
      status: "passed",
      resources: ["workspace:data/sales.csv"],
    });
  });
});
