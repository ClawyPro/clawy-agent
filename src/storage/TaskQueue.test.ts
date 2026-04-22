/**
 * Unit tests for TaskQueue storage helpers (0.17.1).
 *
 * Uses a real tmp workspace per test to exercise the fs-safe wrappers
 * end-to-end. All helpers fail-open, so the tests assert both the
 * happy path AND the silent-failure contract on a bad root.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendToTaskQueue,
  extractHashtags,
  moveQueueToWorking,
  moveWorkingToDaily,
} from "./TaskQueue.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "taskqueue-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("extractHashtags", () => {
  it("maps Korean domain keywords via the seed dictionary", () => {
    const tags = extractHashtags("POS 매출 정리해줘");
    expect(tags).toContain("#pos");
    expect(tags).toContain("#sales");
    expect(tags).toContain("#summary");
  });

  it("lowercases and dedupes English tokens", () => {
    const tags = extractHashtags("Deploy the Service and deploy again");
    // 'deploy' should appear exactly once
    const deployCount = tags.filter((t) => t === "#deploy").length;
    expect(deployCount).toBe(1);
    expect(tags).toContain("#service");
  });

  it("filters stop-words and 1-char tokens", () => {
    const tags = extractHashtags("the and a or to of in on");
    expect(tags).toEqual([]);
  });
});

describe("appendToTaskQueue", () => {
  it("creates TASK-QUEUE.md with the entry on first call", async () => {
    const ok = await appendToTaskQueue(root, {
      turnId: "t1",
      message: "please analyze sales",
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    expect(ok).toBe(true);
    const contents = await fs.readFile(path.join(root, "TASK-QUEUE.md"), "utf8");
    expect(contents).toContain("- [ ] 2026-04-20T00:00:00.000Z turnId=t1 | please analyze sales");
  });

  it("appends additional entries preserving earlier ones", async () => {
    await appendToTaskQueue(root, {
      turnId: "t1",
      message: "first task",
      timestamp: "2026-04-20T00:00:00.000Z",
    });
    await appendToTaskQueue(root, {
      turnId: "t2",
      message: "second task",
      timestamp: "2026-04-20T00:00:01.000Z",
    });
    const contents = await fs.readFile(path.join(root, "TASK-QUEUE.md"), "utf8");
    expect(contents).toMatch(/turnId=t1/);
    expect(contents).toMatch(/turnId=t2/);
  });

  it("collapses multi-line messages to a single line", async () => {
    await appendToTaskQueue(root, {
      turnId: "t1",
      message: "line one\nline two\n   line three",
    });
    const contents = await fs.readFile(path.join(root, "TASK-QUEUE.md"), "utf8");
    // No embedded newlines in the single queue line
    const queueLines = contents.split("\n").filter((l) => l.startsWith("- [ ]"));
    expect(queueLines).toHaveLength(1);
    expect(queueLines[0]).toContain("line one line two line three");
  });
});

describe("moveQueueToWorking + moveWorkingToDaily (lifecycle)", () => {
  it("promotes queue entry to WORKING.md then appends to daily log", async () => {
    await appendToTaskQueue(root, {
      turnId: "t-life",
      message: "POS 매출 분석해줘",
    });

    // Activate
    const activateOk = await moveQueueToWorking(root, "t-life");
    expect(activateOk).toBe(true);

    const queueAfter = await fs.readFile(
      path.join(root, "TASK-QUEUE.md"),
      "utf8",
    );
    expect(queueAfter).not.toContain("turnId=t-life");

    const working = await fs.readFile(path.join(root, "WORKING.md"), "utf8");
    expect(working).toContain("turnId=t-life · ACTIVE");
    expect(working).toContain("POS 매출 분석해줘");

    // Resolve
    const resolveOk = await moveWorkingToDaily(root, "t-life", {
      duration: 2_500,
      toolCallCount: 3,
      message: "POS 매출 분석해줘",
      artifacts: ["/tmp/report.csv"],
    });
    expect(resolveOk).toBe(true);

    const workingAfter = await fs.readFile(
      path.join(root, "WORKING.md"),
      "utf8",
    );
    expect(workingAfter).not.toContain("turnId=t-life");

    const todayIso = new Date().toISOString().slice(0, 10);
    const daily = await fs.readFile(
      path.join(root, "memory", `${todayIso}.md`),
      "utf8",
    );
    expect(daily).toContain("turnId=t-life");
    expect(daily).toContain("3 tools");
    expect(daily).toContain("**User:** POS 매출 분석해줘");
    expect(daily).toMatch(/#pos|#sales/);
    expect(daily).toContain("/tmp/report.csv");
  });

  it("works even when no queue entry exists (direct activate)", async () => {
    // No appendToTaskQueue first — activate should still record.
    const ok = await moveQueueToWorking(root, "t-orphan", "fallback body");
    expect(ok).toBe(true);
    const working = await fs.readFile(path.join(root, "WORKING.md"), "utf8");
    expect(working).toContain("turnId=t-orphan · ACTIVE");
    expect(working).toContain("fallback body");
  });
});

describe("fail-open on disk errors", () => {
  it("returns false when workspaceRoot points to a non-directory", async () => {
    const filePath = path.join(root, "not-a-dir.txt");
    await fs.writeFile(filePath, "x");
    const ok = await appendToTaskQueue(filePath, {
      turnId: "t-bad",
      message: "hi",
    });
    expect(ok).toBe(false);
  });
});
