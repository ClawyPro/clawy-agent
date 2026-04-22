/**
 * Transcript migrations (CC P0-3 step 1).
 *
 * Target on-disk file: `{sessionsDir}/{sha1(sessionKey)}.jsonl` (or
 * per-context `...__{contextId}.jsonl`). Each line is a standalone
 * JSON object with a `kind` discriminator — see
 * `src/storage/Transcript.ts`.
 *
 * Because the transcript is append-only JSONL, "schemaVersion" doesn't
 * fit as a per-line field without breaking every reader. Instead we
 * model the shape that the migration framework operates on as:
 *
 *   { schemaVersion: number; entries: TranscriptEntry[] }
 *
 * The on-disk JSONL is parsed into this shape by the loader
 * (`Transcript.readAllMigrated()`), migrated in-memory, and returned
 * as the migrated entry array. The `schemaVersion` lives on a sibling
 * sentinel file next to the JSONL so the append-only contract of the
 * JSONL itself is preserved.
 *
 * Sentinel path: `{sha1(sessionKey)}{suffix}.schema.json`
 *   → content: `{"schemaVersion": <N>}`
 *
 * v0 → v1 is a data-level no-op (identity) but pins the sentinel.
 */

import type { TranscriptEntry } from "../storage/Transcript.js";
import type { Migration, Versioned } from "./types.js";

export interface TranscriptShape extends Versioned {
  entries: TranscriptEntry[];
}

/**
 * v0 → v1 — no data change; pins schemaVersion=1 so future per-entry
 * field rewrites (e.g. adding `turnSeq` to `tool_call`) have a known
 * baseline.
 */
export const transcriptV0ToV1: Migration<TranscriptShape> = {
  version: 1,
  description: "stamp transcript schemaVersion=1 (baseline)",
  async migrate(input) {
    return { entries: input.entries };
  },
};

export const transcriptMigrations: Migration<TranscriptShape>[] = [
  transcriptV0ToV1,
];

export const CURRENT_TRANSCRIPT_SCHEMA_VERSION = 1;
