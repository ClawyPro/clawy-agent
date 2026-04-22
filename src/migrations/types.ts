/**
 * Schema-migration framework — public types (CC P0-3 step 1).
 *
 * Design reference:
 * - `docs/plans/2026-04-20-cc-learnings-port-plan.md` §2.3
 *
 * Ports Claude Code's `src/migrations/` shape. Every persistent
 * workspace artefact (Session meta index, Transcript, sealed-manifest,
 * future AuditLog) carries a numeric `schemaVersion`. Migrations are
 * upgrade-only — missing version is treated as `0`. The runner applies
 * each registered migration whose version is strictly greater than the
 * object's current version, one step at a time, atomically.
 *
 * Invariants:
 * - A migration NEVER mutates input in place. It returns a new object.
 * - A migration MUST be idempotent — running it twice against its own
 *   output must leave the object unchanged semantically.
 * - A migration MUST NOT throw for a forwards-compatible input. It MAY
 *   throw on truly-corrupt input; the runner will restore the pre-step
 *   backup and rethrow, letting `Agent.start()` cordon the workspace.
 */

export type MigrationLogLevel = "info" | "warn" | "error";

/**
 * Context handed to every migration step. Carries the workspace root
 * (so migrations can touch sibling files when a refactor splits state)
 * and a structured logger.
 */
export interface MigrationContext {
  /** Absolute path to the workspace root (bot PVC mount point). */
  workspaceRoot: string;
  /**
   * Structured log sink. Migrations SHOULD prefer `info` for
   * per-record progress and `warn`/`error` for anomalies.
   */
  log: (
    level: MigrationLogLevel,
    msg: string,
    meta?: unknown,
  ) => void;
}

/**
 * One schema migration step. `version` is the target version (the
 * object is at version `version - 1` before this step runs; at
 * `version` after). `description` is a human-readable label that the
 * runner stamps into audit events.
 */
export interface Migration<T> {
  version: number;
  description: string;
  /**
   * Transform `input` (already at version `this.version - 1`) into a
   * new object at version `this.version`. MUST NOT mutate `input`.
   */
  migrate(input: T, ctx: MigrationContext): Promise<T>;
}

/**
 * Narrow helper — any object that may carry a `schemaVersion`. All
 * migration-aware shapes extend this.
 */
export interface Versioned {
  schemaVersion?: number;
}
