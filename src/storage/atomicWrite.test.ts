import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./atomicWrite.js";

describe("atomicWrite", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-write-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("atomicWriteJson writes pretty JSON and creates parent dir", async () => {
    const target = path.join(root, "nested", "deeper", "out.json");
    const data = { a: 1, b: [2, 3], c: { nested: true } };
    await atomicWriteJson(target, data);

    const raw = await fs.readFile(target, "utf8");
    expect(raw).toBe(JSON.stringify(data, null, 2));
    expect(JSON.parse(raw)).toEqual(data);
  });

  it("atomicWriteFile writes raw string and creates parent dir", async () => {
    const target = path.join(root, "fresh", "dir", "blob.txt");
    const body = "hello\nworld\n";
    await atomicWriteFile(target, body);

    const raw = await fs.readFile(target, "utf8");
    expect(raw).toBe(body);
  });

  it("concurrent writes to same target do not corrupt (last-write-wins)", async () => {
    const target = path.join(root, "race.json");
    const writes = Array.from({ length: 10 }, (_, i) =>
      atomicWriteJson(target, { writer: i }),
    );
    await Promise.all(writes);

    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw) as { writer: number };
    expect(typeof parsed.writer).toBe("number");
    expect(parsed.writer).toBeGreaterThanOrEqual(0);
    expect(parsed.writer).toBeLessThan(10);
  });

  it("tmp file is cleaned up after rename (no .tmp residue in parent dir)", async () => {
    const target = path.join(root, "final.json");
    await atomicWriteJson(target, { ok: true });

    const entries = await fs.readdir(root);
    const tmpResidue = entries.filter((name) => name.includes(".tmp"));
    expect(tmpResidue).toEqual([]);
    expect(entries).toContain("final.json");
  });
});
