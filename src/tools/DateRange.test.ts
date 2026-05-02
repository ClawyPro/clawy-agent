import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../Tool.js";
import { makeDateRangeTool } from "./DateRange.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "date-range-tool-"));
  roots.push(root);
  return root;
}

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("DateRange", () => {
  it("computes last N calendar days from the runtime anchor date", async () => {
    const root = await makeRoot();
    const tool = makeDateRangeTool({
      now: () => new Date("2026-05-02T02:30:00.000Z"),
    });

    const result = await tool.execute(
      { mode: "last_n_days", days: 30, timezone: "Asia/Seoul" },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    expect(result.output).toMatchObject({
      mode: "last_n_days",
      startDate: "2026-04-03",
      endDate: "2026-05-02",
      dayCount: 30,
      timezone: "Asia/Seoul",
      inclusiveEnd: true,
    });
  });

  it("normalizes explicit ranges and counts inclusive days", async () => {
    const root = await makeRoot();
    const tool = makeDateRangeTool();

    const result = await tool.execute(
      {
        mode: "explicit",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
        timezone: "UTC",
      },
      ctx(root),
    );

    expect(result.status).toBe("ok");
    expect(result.output).toMatchObject({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
      dayCount: 30,
    });
  });
});
