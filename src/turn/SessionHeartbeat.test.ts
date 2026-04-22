/**
 * SessionHeartbeat unit tests — B5 session-alive heartbeat file.
 *
 * Uses an in-memory filesystem stub to avoid real disk I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SessionHeartbeat,
  HEARTBEAT_FILE_INTERVAL_MS,
  type HeartbeatFileData,
  type HeartbeatFs,
} from "./SessionHeartbeat.js";

function makeFakeFs(): HeartbeatFs & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    async mkdir(p: string) {
      /* no-op */
    },
    async writeFile(p: string, data: string) {
      written.set(p, data);
    },
    async readFile(p: string) {
      const d = written.get(p);
      if (d === undefined) throw new Error("ENOENT");
      return d;
    },
    async unlink(p: string) {
      written.delete(p);
    },
  };
}

describe("SessionHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes heartbeat file on start", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs,
    });

    await hb.start("turn-1", 0);
    expect(fs.written.size).toBe(1);
    const filePath = Array.from(fs.written.keys())[0]!;
    expect(filePath).toContain("main");
    expect(filePath).toContain("heartbeat.json");

    const data: HeartbeatFileData = JSON.parse(fs.written.get(filePath)!);
    expect(data.alive).toBe(true);
    expect(data.sessionKey).toBe("main");
    expect(data.turnId).toBe("turn-1");
    expect(data.iteration).toBe(0);

    hb.stop();
  });

  it("updates file every HEARTBEAT_FILE_INTERVAL_MS", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "sess-1",
      fs,
    });

    await hb.start("turn-1", 0);
    const filePath = Array.from(fs.written.keys())[0]!;
    const first = JSON.parse(fs.written.get(filePath)!) as HeartbeatFileData;

    // Advance past interval
    await vi.advanceTimersByTimeAsync(HEARTBEAT_FILE_INTERVAL_MS + 100);
    const second = JSON.parse(fs.written.get(filePath)!) as HeartbeatFileData;
    expect(second.updatedAt).not.toBe(first.updatedAt);

    hb.stop();
  });

  it("updates iteration via updateIteration()", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs,
    });

    await hb.start("turn-1", 0);
    hb.updateIteration(5);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_FILE_INTERVAL_MS + 100);
    const filePath = Array.from(fs.written.keys())[0]!;
    const data = JSON.parse(fs.written.get(filePath)!) as HeartbeatFileData;
    expect(data.iteration).toBe(5);

    hb.stop();
  });

  it("stop() writes alive:false", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs,
    });

    await hb.start("turn-1", 0);
    await hb.stop();
    const filePath = Array.from(fs.written.keys())[0]!;
    const data = JSON.parse(fs.written.get(filePath)!) as HeartbeatFileData;
    expect(data.alive).toBe(false);
    expect(data.completedAt).toBeDefined();
  });

  it("stop() is idempotent", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs,
    });

    await hb.start("turn-1", 0);
    await hb.stop();
    await hb.stop(); // should not throw
  });

  it("readHeartbeat returns parsed data", async () => {
    const fs = makeFakeFs();
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs,
    });

    await hb.start("turn-1", 3);
    const data = await SessionHeartbeat.readHeartbeat(
      "/workspace",
      "main",
      fs,
    );
    expect(data).not.toBeNull();
    expect(data!.alive).toBe(true);
    expect(data!.sessionKey).toBe("main");
    expect(data!.iteration).toBe(3);
  });

  it("readHeartbeat returns null for missing file", async () => {
    const fs = makeFakeFs();
    const data = await SessionHeartbeat.readHeartbeat(
      "/workspace",
      "nonexistent",
      fs,
    );
    expect(data).toBeNull();
  });

  it("filesystem errors in tick are swallowed", async () => {
    const failFs: HeartbeatFs = {
      async mkdir() {},
      async writeFile() {
        throw new Error("disk full");
      },
      async readFile() {
        throw new Error("ENOENT");
      },
      async unlink() {},
    };
    const hb = new SessionHeartbeat({
      workspaceRoot: "/workspace",
      sessionKey: "main",
      fs: failFs,
    });

    // start() itself may throw on first write — that's acceptable
    // but should not crash
    await hb.start("turn-1", 0).catch(() => {});
    // tick should not throw
    await vi.advanceTimersByTimeAsync(HEARTBEAT_FILE_INTERVAL_MS + 100);
    hb.stop();
  });
});
