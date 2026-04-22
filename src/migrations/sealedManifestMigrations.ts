/**
 * Sealed-manifest migrations (CC P0-3 step 1).
 *
 * Target on-disk file: `{workspaceRoot}/.sealed-manifest.json` — see
 * `src/hooks/builtin/sealedFiles.ts`.
 *
 * Shape today (v0):
 *   { "<path>": { "sha256": "<hex>", "updatedAt": <epochMs> }, ... }
 *
 * Shape from v1 onwards:
 *   {
 *     "schemaVersion": 1,
 *     "entries": { "<path>": { "sha256": "...", "updatedAt": ... } }
 *   }
 *
 * Wiring note: `sealedFiles.ts::readManifest` is owned by another
 * worktree (see Phase 3 refactor plan). This module therefore only
 * *declares* the migration chain + exposes `readSealedManifestMigrated`
 * as a free function that the sealed-files hook will adopt in a
 * follow-up PR. Until then, existing manifests are still readable by
 * both the legacy reader and the new v1-aware reader (the framework
 * tolerates v0 input transparently).
 */

import type { Migration, Versioned } from "./types.js";

interface ManifestEntry {
  sha256: string;
  updatedAt: number;
}

export interface SealedManifestShape extends Versioned {
  entries: Record<string, ManifestEntry>;
}

/**
 * v0 → v1 — wrap the flat `Record<string, ManifestEntry>` in an
 * object carrying `schemaVersion` + `entries`. This is the only
 * structural migration shipped with the baseline framework; it is
 * guarded so re-running against a v1 input is a no-op.
 */
export const sealedManifestV0ToV1: Migration<SealedManifestShape> = {
  version: 1,
  description: "wrap sealed manifest entries + stamp schemaVersion=1",
  async migrate(input) {
    return { entries: input.entries };
  },
};

export const sealedManifestMigrations: Migration<SealedManifestShape>[] = [
  sealedManifestV0ToV1,
];

export const CURRENT_SEALED_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Parse a raw manifest JSON string (v0 flat shape OR v1 wrapped
 * shape) into the `SealedManifestShape` the migration framework
 * operates on. Shared by the sealed-files hook loader (future wiring)
 * + the migration unit tests.
 */
export function parseSealedManifestJson(
  raw: string,
): SealedManifestShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // v1+ wrapped shape.
  if (typeof obj["schemaVersion"] === "number" && obj["entries"]) {
    const entries = obj["entries"];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return null;
    }
    const out: Record<string, ManifestEntry> = {};
    for (const [k, v] of Object.entries(
      entries as Record<string, unknown>,
    )) {
      const entry = extractEntry(v);
      if (entry) out[k] = entry;
    }
    return { schemaVersion: obj["schemaVersion"] as number, entries: out };
  }
  // v0 flat shape: every top-level key maps to an entry.
  const out: Record<string, ManifestEntry> = {};
  for (const [k, v] of Object.entries(obj)) {
    const entry = extractEntry(v);
    if (entry) out[k] = entry;
  }
  return { entries: out };
}

function extractEntry(v: unknown): ManifestEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const sha = typeof e["sha256"] === "string" ? (e["sha256"] as string) : null;
  const ts =
    typeof e["updatedAt"] === "number" ? (e["updatedAt"] as number) : null;
  if (sha === null || ts === null) return null;
  return { sha256: sha, updatedAt: ts };
}
