/**
 * Session meta-index migrations (CC P0-3 step 1).
 *
 * Target on-disk file: `{sessionsDir}/{sha1(sessionKey)}.meta.json`.
 * Shape today (see `src/Context.ts::loadMetaIndex`):
 *
 *   { contexts: ContextMeta[], activeContextId: string }
 *
 * After v1 the shape is:
 *
 *   { schemaVersion: 1, contexts: ContextMeta[], activeContextId: string }
 *
 * The v0→v1 migration is a pure no-op at the data level: it simply
 * stamps `schemaVersion: 1` so subsequent steps can reason about a
 * known baseline. Existing 30+ days of bot workspace data is
 * byte-compatible with v1 readers (the extra field is ignored).
 */

import type { ContextMeta } from "../Context.js";
import type { Migration, Versioned } from "./types.js";

export interface SessionMetaShape extends Versioned {
  contexts: ContextMeta[];
  activeContextId: string;
}

/**
 * v0 → v1 — stamp version, no data change.
 *
 * Intentionally trivial so the framework itself is exercised in
 * production from day one without any risk to existing data. Future
 * steps (e.g. adding `ContextMeta.ownerUserId`) will do real work.
 */
export const sessionV0ToV1: Migration<SessionMetaShape> = {
  version: 1,
  description: "stamp session meta schemaVersion=1 (baseline)",
  async migrate(input) {
    return {
      contexts: input.contexts,
      activeContextId: input.activeContextId,
    };
  },
};

/**
 * v1 → v2 — Session.meta schema bump for the Cron `durable` flag
 * (§2.2 of docs/plans/2026-04-20-cc-learnings-port-plan.md).
 *
 * Session-scoped (non-durable) crons are tracked on
 * `Session.meta.crons: string[]`. The on-disk meta index file does
 * not itself carry that array today (Session.meta is in-memory only),
 * but the framework demands a version bump for any shape change to
 * Session-level state so that future loaders can reason about a
 * known baseline. Concretely:
 *
 *   - v1 files on disk remain byte-compatible with v2 readers.
 *   - The migration simply stamps `schemaVersion: 2`; runtime logic
 *     treats a missing `crons` as `[]`.
 *   - Once we decide to persist `Session.meta.crons` the migration
 *     here is the natural place to materialise the empty array on
 *     previously-stored meta files.
 */
export const sessionV1ToV2: Migration<SessionMetaShape> = {
  version: 2,
  description: "stamp session meta schemaVersion=2 (Cron durable flag)",
  async migrate(input) {
    return {
      contexts: input.contexts,
      activeContextId: input.activeContextId,
    };
  },
};

/**
 * Default Discipline block stamped into Session.meta by the v2→v3
 * migration. Mirrors {@link DEFAULT_DISCIPLINE} in `src/discipline/`
 * but is duplicated here to avoid a reverse import from migrations
 * into a runtime subsystem (migrations must stay dependency-light).
 * Any change must be mirrored in both locations.
 */
export const DEFAULT_DISCIPLINE_MIGRATION = {
  tdd: false,
  git: false,
  requireCommit: "off" as const,
  maxChangesBeforeCommit: 10,
  testPatterns: [
    "**/*.test.{ts,tsx,js,jsx}",
    "**/*.spec.{ts,tsx,js,jsx}",
    "**/*.test.py",
    "**/*.spec.py",
  ],
  sourcePatterns: ["src/**/*.{ts,tsx,js,jsx}", "src/**/*.py"],
};

/**
 * v2 → v3 — Session.meta.discipline default stamp for the Coding
 * Discipline subsystem (docs/plans/2026-04-20-coding-discipline-design.md).
 *
 * Like v1/v2, the on-disk session meta index file does not itself
 * persist per-session Session.meta (that lives in-memory + transcript
 * replay), so the migration is a structural no-op at the data level.
 * It stamps schemaVersion=3 so loaders reading a v2 meta file know the
 * runtime expects discipline-aware Session construction and can warn /
 * reject mismatches.
 *
 * Runtime behaviour on hydration:
 *   - Live sessions constructed from hydrate / createSession receive
 *     the {@link DEFAULT_DISCIPLINE_MIGRATION} object unless
 *     workspace/.discipline.yaml or the mode classifier overrides it.
 *   - Old session files remain byte-compatible; discipline defaults
 *     to the value above.
 */
export const sessionV2ToV3: Migration<SessionMetaShape> = {
  version: 3,
  description: "stamp session meta schemaVersion=3 (discipline defaults)",
  async migrate(input) {
    return {
      contexts: input.contexts,
      activeContextId: input.activeContextId,
    };
  },
};

export const sessionMigrations: Migration<SessionMetaShape>[] = [
  sessionV0ToV1,
  sessionV1ToV2,
  sessionV2ToV3,
];

/**
 * Highest version number among the registered session migrations.
 * Exported so loaders can assert "we are now at the current schema".
 */
export const CURRENT_SESSION_META_SCHEMA_VERSION = 3;
