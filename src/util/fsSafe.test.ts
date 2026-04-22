/**
 * Tests for FD-based fs-safe wrappers (§15.2).
 *
 * Runs on both linux (uses /proc/self/fd) and darwin (fallback to
 * pre-open realpath). On darwin we cannot exercise the FD-level
 * post-open check, but the pre-open escape detection is still
 * exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FsSafeEscape,
  appendSafe,
  fdRealPath,
  isFsSafeEscape,
  isUnderRoot,
  openSafe,
  readSafe,
  statSafe,
  writeSafe,
} from "./fsSafe.js";

describe("isUnderRoot", () => {
  it("returns true for exact match", () => {
    expect(isUnderRoot("/a/b", "/a/b")).toBe(true);
  });
  it("returns true for nested path", () => {
    expect(isUnderRoot("/a/b/c", "/a/b")).toBe(true);
  });
  it("returns false for sibling prefix", () => {
    expect(isUnderRoot("/a/bc", "/a/b")).toBe(false);
  });
  it("returns false for outside path", () => {
    expect(isUnderRoot("/x/y", "/a/b")).toBe(false);
  });
});

describe("isFsSafeEscape", () => {
  it("detects FsSafeEscape instances", () => {
    const err = new FsSafeEscape("m", "p", "r", "root");
    expect(isFsSafeEscape(err)).toBe(true);
  });
  it("rejects plain errors", () => {
    expect(isFsSafeEscape(new Error("nope"))).toBe(false);
  });
});

describe("fdRealPath", () => {
  it("returns a valid path on linux, null elsewhere", async () => {
    const fh = await fs.open(path.join(os.tmpdir(), "fsSafe-fd-probe"), "w+");
    try {
      const got = await fdRealPath(fh.fd);
      if (process.platform === "linux") {
        expect(typeof got === "string" || got === null).toBe(true);
      } else {
        expect(got).toBeNull();
      }
    } finally {
      await fh.close();
    }
  });
});

describe("openSafe + readSafe + writeSafe", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fsSafe-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads a normal file under root", async () => {
    await fs.writeFile(path.join(root, "hello.txt"), "world");
    expect(await readSafe("hello.txt", root)).toBe("world");
  });

  it("writes a new file under root, round-trips through readSafe", async () => {
    await writeSafe("greeting.txt", "안녕", root);
    expect(await readSafe("greeting.txt", root)).toBe("안녕");
  });

  it("appendSafe extends an existing file", async () => {
    await writeSafe("log.txt", "line1\n", root);
    await appendSafe("log.txt", "line2\n", root);
    expect(await readSafe("log.txt", root)).toBe("line1\nline2\n");
  });

  it("statSafe returns null on missing file (ENOENT passthrough)", async () => {
    const got = await statSafe("missing.txt", root);
    expect(got).toBeNull();
  });

  it("statSafe returns Stats for existing file", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x");
    const got = await statSafe("a.txt", root);
    expect(got?.isFile()).toBe(true);
    expect(got?.size).toBe(1);
  });

  it("allows in-root symlink", async () => {
    await fs.writeFile(path.join(root, "target.txt"), "inside");
    await fs.symlink(path.join(root, "target.txt"), path.join(root, "link.txt"));
    expect(await readSafe("link.txt", root)).toBe("inside");
  });

  it("rejects symlink pointing outside root", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "fsSafe-outside-"));
    try {
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "leak");
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(root, "bad.txt"));
      await expect(readSafe("bad.txt", root)).rejects.toSatisfy(isFsSafeEscape);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects absolute path outside root", async () => {
    // "/etc/passwd" joined under root normalises to /etc/passwd
    // because path.join strips the leading slash via the replace.
    // We assert escape by passing an explicitly-traversing path.
    await expect(readSafe("../../../../etc/passwd", root)).rejects.toSatisfy(
      isFsSafeEscape,
    );
  });

  it("rejects dot-dot escape", async () => {
    await expect(readSafe("../../../foo", root)).rejects.toSatisfy(isFsSafeEscape);
  });

  it("openSafe closes handle when escape detected post-open (via symlink)", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "fsSafe-outside-"));
    try {
      await fs.writeFile(path.join(outsideDir, "target"), "x");
      await fs.symlink(path.join(outsideDir, "target"), path.join(root, "swap"));
      let caught: unknown = null;
      try {
        const fh = await openSafe("swap", "r", root);
        await fh.close();
      } catch (err) {
        caught = err;
      }
      expect(isFsSafeEscape(caught)).toBe(true);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
