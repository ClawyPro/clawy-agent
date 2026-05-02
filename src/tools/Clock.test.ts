import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../Tool.js";
import { ExecutionContractStore } from "../execution/ExecutionContract.js";
import { makeClockTool } from "./Clock.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clock-tool-"));
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

describe("Clock", () => {
  it("returns runtime time in ISO and timezone-local form", async () => {
    const root = await makeRoot();
    const tool = makeClockTool({
      now: () => new Date("2026-05-02T02:30:00.000Z"),
    });

    const result = await tool.execute({ timezone: "Asia/Seoul" }, ctx(root));

    expect(result.status).toBe("ok");
    expect(result.output).toMatchObject({
      iso: "2026-05-02T02:30:00.000Z",
      timezone: "Asia/Seoul",
      localDate: "2026-05-02",
      localTime: "11:30:00",
    });
  });

  it("records clock evidence on the execution contract", async () => {
    const root = await makeRoot();
    const contract = new ExecutionContractStore({ now: () => 1 });
    contract.recordDeterministicRequirement({
      requirementId: "dr_clock",
      source: "llm_classifier",
      status: "active",
      kinds: ["clock"],
      reason: "Need current date.",
      suggestedTools: ["Clock"],
      acceptanceCriteria: [],
    });
    const tool = makeClockTool({
      now: () => new Date("2026-05-02T02:30:00.000Z"),
    });

    const result = await tool.execute(
      { timezone: "Asia/Seoul", requirementId: "dr_clock" },
      ctx(root, contract),
    );

    expect(result.status).toBe("ok");
    expect(contract.snapshot().taskState.deterministicEvidence[0]).toMatchObject({
      requirementIds: ["dr_clock"],
      toolName: "Clock",
      kind: "clock",
      status: "passed",
    });
  });
});
