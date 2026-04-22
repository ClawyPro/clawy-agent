/**
 * Subsystem-level fixture tests — load pre-migration shapes and
 * assert the migrated output matches expectations.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./applyMigrations.js";
import {
  sessionMigrations,
  CURRENT_SESSION_META_SCHEMA_VERSION,
  type SessionMetaShape,
} from "./sessionMigrations.js";
import {
  transcriptMigrations,
  CURRENT_TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptShape,
} from "./transcriptMigrations.js";
import {
  sealedManifestMigrations,
  CURRENT_SEALED_MANIFEST_SCHEMA_VERSION,
  parseSealedManifestJson,
  type SealedManifestShape,
} from "./sealedManifestMigrations.js";

function silentLogger(): void {
  // no-op
}

describe("session meta migrations — v0 fixture", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "session-mig-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("loads a pre-migration v0 meta file and returns a v1 shape", async () => {
    const target = path.join(tmp, "meta.json");
    const v0: SessionMetaShape = {
      contexts: [
        {
          contextId: "default",
          sessionKey: "agent:main:app:general:7",
          title: "default",
          createdAt: 1_700_000_000_000,
          lastActivityAt: 1_700_000_500_000,
          archived: false,
        },
      ],
      activeContextId: "default",
    };
    await fs.writeFile(target, JSON.stringify(v0, null, 2), "utf8");

    const parsed = JSON.parse(
      await fs.readFile(target, "utf8"),
    ) as SessionMetaShape;
    const migrated = await applyMigrations(parsed, sessionMigrations, {
      workspaceRoot: tmp,
      log: silentLogger,
      targetPath: target,
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_META_SCHEMA_VERSION);
    expect(migrated.contexts).toHaveLength(1);
    expect(migrated.contexts[0]!.contextId).toBe("default");
    expect(migrated.activeContextId).toBe("default");

    // Persisted to disk with the version stamp.
    const onDisk = JSON.parse(
      await fs.readFile(target, "utf8"),
    ) as SessionMetaShape;
    expect(onDisk.schemaVersion).toBe(CURRENT_SESSION_META_SCHEMA_VERSION);
    expect(onDisk.contexts).toHaveLength(1);
  });

  it("leaves an already-current meta file untouched", async () => {
    const target = path.join(tmp, "meta.json");
    const current: SessionMetaShape = {
      schemaVersion: CURRENT_SESSION_META_SCHEMA_VERSION,
      contexts: [
        {
          contextId: "default",
          sessionKey: "agent:main:app:general:7",
          title: "default",
          createdAt: 1,
          lastActivityAt: 2,
          archived: false,
        },
      ],
      activeContextId: "default",
    };
    await fs.writeFile(target, JSON.stringify(current, null, 2), "utf8");
    const before = await fs.readFile(target, "utf8");

    const parsed = JSON.parse(before) as SessionMetaShape;
    const migrated = await applyMigrations(parsed, sessionMigrations, {
      workspaceRoot: tmp,
      log: silentLogger,
      targetPath: target,
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SESSION_META_SCHEMA_VERSION);
    const after = await fs.readFile(target, "utf8");
    expect(after).toBe(before);
  });
});

describe("transcript migrations", () => {
  it("v0 entries pass through and the shape is stamped v1", async () => {
    const entries: TranscriptShape = {
      entries: [
        {
          kind: "user_message",
          ts: 1_700_000_000_000,
          turnId: "t1",
          text: "hello",
        },
      ],
    };
    const out = await applyMigrations(entries, transcriptMigrations, {
      workspaceRoot: "/tmp",
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(CURRENT_TRANSCRIPT_SCHEMA_VERSION);
    expect(out.entries).toHaveLength(1);
    const first = out.entries[0];
    if (!first) throw new Error("expected at least one entry");
    expect(first.kind).toBe("user_message");
  });
});

describe("sealed manifest migrations", () => {
  it("parses v0 flat shape and migrates to v1 wrapped shape", async () => {
    const v0Json = JSON.stringify({
      "SOUL.md": {
        sha256:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        updatedAt: 1_700_000_000_000,
      },
    });
    const parsed = parseSealedManifestJson(v0Json);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.schemaVersion).toBeUndefined();
    expect(Object.keys(parsed.entries)).toContain("SOUL.md");

    const out = await applyMigrations(parsed, sealedManifestMigrations, {
      workspaceRoot: "/tmp",
      log: silentLogger,
    });
    expect(out.schemaVersion).toBe(CURRENT_SEALED_MANIFEST_SCHEMA_VERSION);
    const soul = out.entries["SOUL.md"];
    if (!soul) throw new Error("missing SOUL.md entry");
    expect(soul.sha256.length).toBe(64);
  });

  it("parses v1 wrapped shape and round-trips unchanged", async () => {
    const v1Json = JSON.stringify({
      schemaVersion: 1,
      entries: {
        "identity.md": {
          sha256:
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
          updatedAt: 1_700_000_500_000,
        },
      },
    });
    const parsed = parseSealedManifestJson(v1Json);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.schemaVersion).toBe(1);

    const out = await applyMigrations(
      parsed as SealedManifestShape,
      sealedManifestMigrations,
      { workspaceRoot: "/tmp", log: silentLogger },
    );
    expect(out.schemaVersion).toBe(1);
    expect(Object.keys(out.entries)).toEqual(["identity.md"]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseSealedManifestJson("not-json")).toBeNull();
    expect(parseSealedManifestJson("[]")).toBeNull();
  });
});
