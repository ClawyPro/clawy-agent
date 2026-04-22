/**
 * Schema-migration registry (CC P0-3 step 1).
 *
 * Single entry-point for every migration-aware subsystem. Callers
 * import the framework via this module:
 *
 *   import {
 *     applyMigrations,
 *     sessionMigrations,
 *     transcriptMigrations,
 *     sealedManifestMigrations,
 *     consoleMigrationLogger,
 *   } from "./migrations/index.js";
 *
 * Adding a new subsystem:
 * 1. Create `src/migrations/{subsystem}Migrations.ts` exporting a
 *    typed `Migration<T>[]` array + `CURRENT_{SUBSYSTEM}_SCHEMA_VERSION`.
 * 2. Re-export from this file.
 * 3. Wire `applyMigrations(...)` into the subsystem's loader.
 * 4. Add a fixture test that loads a pre-migration shape and asserts
 *    the post-migration object.
 */

export {
  applyMigrations,
  consoleMigrationLogger,
  __APPLY_TESTING__,
} from "./applyMigrations.js";
export type { ApplyMigrationsOptions } from "./applyMigrations.js";
export type {
  Migration,
  MigrationContext,
  MigrationLogLevel,
  Versioned,
} from "./types.js";

export {
  sessionMigrations,
  sessionV0ToV1,
  sessionV1ToV2,
  sessionV2ToV3,
  DEFAULT_DISCIPLINE_MIGRATION,
  CURRENT_SESSION_META_SCHEMA_VERSION,
} from "./sessionMigrations.js";
export type { SessionMetaShape } from "./sessionMigrations.js";

export {
  transcriptMigrations,
  transcriptV0ToV1,
  CURRENT_TRANSCRIPT_SCHEMA_VERSION,
} from "./transcriptMigrations.js";
export type { TranscriptShape } from "./transcriptMigrations.js";

export {
  sealedManifestMigrations,
  sealedManifestV0ToV1,
  CURRENT_SEALED_MANIFEST_SCHEMA_VERSION,
  parseSealedManifestJson,
} from "./sealedManifestMigrations.js";
export type { SealedManifestShape } from "./sealedManifestMigrations.js";
