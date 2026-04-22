/**
 * Unit tests for the schema-migration runner.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  __APPLY_TESTING__,
} from "./applyMigrations.js";
import type { Migration, MigrationLogLevel } from "./types.js";

interface TestShape {
  schemaVersion?: number;
  name: string;
  /** appended to by each migration so we can assert the order of calls */
  trail: string[];
}

function silentLogger(
  _level: MigrationLogLevel,
  _msg: string,
  _meta?: unknown,
): void {
  // no-op for tests
}

const step1: Migration<TestShape> = {
  version: 1,
  description: "v0 → v1",
  async migrate(input) {
    return { ...input, trail: [...input.trail, "v1"] };
  },
};

const step2: Migration<TestShape> = {
  version: 2,
  description: "v1 → v2",
  async migrate(input) {
    return { ...input, trail: [...input.trail, "v2"] };
  },
};

const step3: Migration<TestShape> = {
  version: 3,
  description: "v2 → v3",
  async migrate(input) {
    return { ...input, trail: [...input.trail, "v3"] };
  },
};

describe("applyMigrations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "migrations-test-"));
    __APPLY_TESTING__.afterBackupWrite = null;
  });

  afterEach(async () => {
    __APPLY_TESTING__.afterBackupWrite = null;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("treats missing schemaVersion as 0 and runs v0→v1", async () => {
    const input: TestShape = { name: "fresh", trail: [] };
    const out = await applyMigrations(input, [step1], {
      workspaceRoot: tmp,
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(1);
    expect(out.trail).toEqual(["v1"]);
  });

  it("is a no-op when already at latest version", async () => {
    const input: TestShape = {
      schemaVersion: 1,
      name: "already-v1",
      trail: [],
    };
    const out = await applyMigrations(input, [step1], {
      workspaceRoot: tmp,
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(1);
    expect(out.trail).toEqual([]);
  });

  it("applies three chained migrations v0→v1→v2→v3 in order", async () => {
    const input: TestShape = { name: "chain", trail: [] };
    // Register out of order to prove the runner sorts.
    const out = await applyMigrations(input, [step3, step1, step2], {
      workspaceRoot: tmp,
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(3);
    expect(out.trail).toEqual(["v1", "v2", "v3"]);
  });

  it("rethrows when a migration throws and preserves the on-disk file", async () => {
    const target = path.join(tmp, "meta.json");
    const original: TestShape = {
      name: "pristine",
      trail: [],
    };
    await fs.writeFile(target, JSON.stringify(original, null, 2), "utf8");

    const boom: Migration<TestShape> = {
      version: 1,
      description: "explodes",
      async migrate() {
        throw new Error("intentional failure");
      },
    };

    await expect(
      applyMigrations(original, [boom], {
        workspaceRoot: tmp,
        log: silentLogger,
        targetPath: target,
      }),
    ).rejects.toThrow(/intentional failure/);

    const afterBytes = await fs.readFile(target, "utf8");
    const afterObj = JSON.parse(afterBytes) as TestShape;
    expect(afterObj.name).toBe("pristine");
    expect(afterObj.schemaVersion).toBeUndefined();
  });

  it("writes a backup file before each step", async () => {
    const target = path.join(tmp, "meta.json");
    const original: TestShape = { name: "backup-me", trail: [] };
    await fs.writeFile(target, JSON.stringify(original, null, 2), "utf8");

    await applyMigrations(original, [step1], {
      workspaceRoot: tmp,
      log: silentLogger,
      targetPath: target,
    });

    const backup = `${target}.pre-v1`;
    const backupBytes = await fs.readFile(backup, "utf8");
    expect(JSON.parse(backupBytes).name).toBe("backup-me");
  });

  it("leaves the backup file intact when a mid-step crash is simulated", async () => {
    const target = path.join(tmp, "meta.json");
    const original: TestShape = { name: "crash-sim", trail: [] };
    await fs.writeFile(target, JSON.stringify(original, null, 2), "utf8");

    __APPLY_TESTING__.afterBackupWrite = () => {
      throw new Error("simulated crash between backup + target write");
    };

    // The crash happens inside the runner's test hook BEFORE migrate()
    // runs — so no restore step. The backup + untouched target are
    // left on disk. A subsequent run will re-attempt from the same
    // starting point.
    await expect(
      applyMigrations(original, [step1], {
        workspaceRoot: tmp,
        log: silentLogger,
        targetPath: target,
      }),
    ).rejects.toThrow(/simulated crash/);

    const backup = `${target}.pre-v1`;
    const backupBytes = await fs.readFile(backup, "utf8");
    expect(JSON.parse(backupBytes).name).toBe("crash-sim");

    // Target untouched — still v0 shape.
    const targetBytes = await fs.readFile(target, "utf8");
    expect(JSON.parse(targetBytes).schemaVersion).toBeUndefined();
  });

  it("persists the final migrated object to targetPath", async () => {
    const target = path.join(tmp, "meta.json");
    const original: TestShape = { name: "persist", trail: [] };
    await fs.writeFile(target, JSON.stringify(original, null, 2), "utf8");

    await applyMigrations(original, [step1, step2], {
      workspaceRoot: tmp,
      log: silentLogger,
      targetPath: target,
    });

    const bytes = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(bytes) as TestShape;
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.trail).toEqual(["v1", "v2"]);
  });

  it("rejects a non-contiguous migration chain", async () => {
    const skipStep: Migration<TestShape> = {
      version: 2,
      description: "skips v1",
      async migrate(input) {
        return input;
      },
    };
    const input: TestShape = { name: "gap", trail: [] };
    await expect(
      applyMigrations(input, [skipStep], {
        workspaceRoot: tmp,
        log: silentLogger,
      }),
    ).rejects.toThrow(/non-contiguous/);
  });

  it("stamps schemaVersion even if the migration forgets to", async () => {
    const forgetful: Migration<TestShape> = {
      version: 1,
      description: "doesn't set schemaVersion",
      async migrate(input) {
        return { ...input, name: `${input.name}!` };
      },
    };
    const input: TestShape = { name: "fresh", trail: [] };
    const out = await applyMigrations(input, [forgetful], {
      workspaceRoot: tmp,
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(1);
    expect(out.name).toBe("fresh!");
  });

  it("runs in-memory with no targetPath (no file side-effects)", async () => {
    const input: TestShape = { name: "inmem", trail: [] };
    const out = await applyMigrations(input, [step1], {
      workspaceRoot: tmp,
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(1);
    const dirContents = await fs.readdir(tmp);
    expect(dirContents).toEqual([]);
  });

  it("emits structured log events for each applied step", async () => {
    const events: Array<{ level: string; msg: string }> = [];
    const input: TestShape = { name: "logtest", trail: [] };
    await applyMigrations(input, [step1, step2], {
      workspaceRoot: tmp,
      log: (level, msg) => {
        events.push({ level, msg });
      },
    });
    // Each step logs "applying" and "applied" → two events per step.
    const msgs = events.map((e) => e.msg);
    expect(msgs.filter((m) => m.includes("applying v0 → v1"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("applied v0 → v1"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("applying v1 → v2"))).toHaveLength(1);
    expect(msgs.filter((m) => m.includes("applied v1 → v2"))).toHaveLength(1);
  });
});
