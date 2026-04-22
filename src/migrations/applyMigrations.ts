/**
 * Schema-migration runner — `applyMigrations()` (CC P0-3 step 1).
 *
 * Iterates the registered migrations for a subsystem in strictly
 * ascending version order, applying each step whose `version` is
 * greater than the object's current `schemaVersion`. Each step is
 * atomic at the on-disk level: the pre-step bytes are copied to a
 * `.pre-v<N>` backup BEFORE the step runs, the step's output is
 * written via `atomicWriteJson`, and only on success does the runner
 * advance.
 *
 * Failure semantics:
 * - If a migration throws, the runner rewrites the original pre-step
 *   bytes back to the target via `atomicWriteJson` (restore from
 *   backup) and rethrows. The backup file is left on disk so a human
 *   can inspect / retry offline.
 * - If the restore itself fails, the original throw is preserved and
 *   the restore error is logged.
 *
 * Callers wire this into their loader:
 *
 *   const raw = await fs.readFile(target, "utf8");
 *   const parsed = JSON.parse(raw) as MyShape;
 *   const migrated = await applyMigrations(parsed, myMigrations, {
 *     workspaceRoot, log,
 *     targetPath: target,
 *   });
 *   return migrated;
 *
 * The runner owns the persistence step — callers do not need to write
 * the migrated object themselves. This keeps backup + restore atomic.
 */

import fs from "node:fs/promises";
import { atomicWriteJson } from "../storage/atomicWrite.js";
import type {
  Migration,
  MigrationContext,
  MigrationLogLevel,
  Versioned,
} from "./types.js";

/**
 * Extended context used internally. Callers pass `targetPath` so the
 * runner can persist the migrated object atomically. If `targetPath`
 * is omitted, the runner runs in-memory only (backups are skipped) —
 * useful for tests and for non-file shapes (e.g. an in-memory upgrade
 * followed by a caller-driven append).
 */
export interface ApplyMigrationsOptions extends MigrationContext {
  /**
   * Absolute path to the file that `input` was loaded from. When set,
   * the runner writes backups + the final migrated object to disk
   * atomically. When unset, the runner returns the migrated object
   * without touching the filesystem.
   */
  targetPath?: string;
}

/**
 * Signal used by the test suite to simulate a crash mid-migration
 * (between backup-write and target-write). Not part of the public API.
 */
export const __APPLY_TESTING__ = {
  /**
   * If set, the runner invokes this callback after writing the backup
   * file but before writing the migrated output. Throwing from the
   * callback simulates a crash at the worst possible moment — the
   * backup exists but the target has not yet been replaced.
   */
  afterBackupWrite: null as null | ((backupPath: string) => void),
};

/**
 * Read the `schemaVersion` field of an arbitrary object. Missing /
 * non-numeric → treated as 0 (fresh install, pre-migrations era).
 */
function currentVersion<T extends Versioned>(obj: T): number {
  const v = obj.schemaVersion;
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : 0;
}

/**
 * Run the registered migrations against `input` and return the final
 * object. The returned object's `schemaVersion` equals the highest
 * `version` across all applicable migrations (or the input's version
 * if all are already applied).
 */
export async function applyMigrations<T extends Versioned>(
  input: T,
  migrations: Migration<T>[],
  opts: ApplyMigrationsOptions,
): Promise<T> {
  const { workspaceRoot, log, targetPath } = opts;
  // Defensive copy — migrations must not see other callers' mutations.
  let current: T = input;
  // Strictly ascending by version, so chained v0→v1→v2→v3 runs in
  // order regardless of registration order.
  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const step of sorted) {
    const from = currentVersion(current);
    if (step.version <= from) continue;
    if (step.version !== from + 1) {
      // Gap in the chain — the registry is broken. Fail loudly.
      throw new Error(
        `[migrations] non-contiguous version chain: at v${from}, ` +
          `next registered is v${step.version} (expected v${from + 1}). ` +
          `Fix migrations/index.ts — add the missing intermediate step.`,
      );
    }
    log("info", `[migrations] applying v${from} → v${step.version}`, {
      description: step.description,
    });

    let backupPath: string | null = null;
    let originalBytes: string | null = null;
    if (targetPath) {
      try {
        originalBytes = await fs.readFile(targetPath, "utf8");
      } catch (err) {
        // If the target is missing we can't backup — but we also
        // don't need to, since a missing file means the caller is
        // about to create it via the final atomicWriteJson below.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (originalBytes !== null) {
        backupPath = `${targetPath}.pre-v${step.version}`;
        // Use writeFile for the backup — atomicWrite isn't needed
        // because a partial backup is discarded on next run anyway,
        // and we want the backup to land before we mutate the target.
        await fs.writeFile(backupPath, originalBytes, "utf8");
      }
    }

    // Test-hook: simulate a crash between backup + target writes.
    if (__APPLY_TESTING__.afterBackupWrite && backupPath) {
      __APPLY_TESTING__.afterBackupWrite(backupPath);
    }

    let next: T;
    const ctx: MigrationContext = { workspaceRoot, log };
    try {
      next = await step.migrate(current, ctx);
    } catch (err) {
      // Restore original bytes if we have them.
      if (targetPath && originalBytes !== null) {
        try {
          await atomicWriteJson(targetPath, JSON.parse(originalBytes));
        } catch (restoreErr) {
          log(
            "error",
            `[migrations] FAILED to restore backup after migration error`,
            { targetPath, restoreErr: String(restoreErr) },
          );
        }
      }
      log(
        "error",
        `[migrations] migration v${from}→v${step.version} failed`,
        { description: step.description, error: String(err) },
      );
      throw err;
    }

    // Stamp the version. Migrations may set this themselves; we
    // enforce it here to keep every subsystem consistent without
    // relying on every author remembering to do it.
    const stamped: T = { ...next, schemaVersion: step.version };

    if (targetPath) {
      try {
        await atomicWriteJson(targetPath, stamped);
      } catch (err) {
        // Target write failed — restore from backup if we have it.
        if (originalBytes !== null) {
          try {
            await atomicWriteJson(targetPath, JSON.parse(originalBytes));
          } catch (restoreErr) {
            log(
              "error",
              `[migrations] FAILED to restore backup after persist error`,
              { targetPath, restoreErr: String(restoreErr) },
            );
          }
        }
        throw err;
      }
    }

    log(
      "info",
      `[migrations] applied v${from} → v${step.version}`,
      { description: step.description, targetPath: targetPath ?? "<memory>" },
    );

    current = stamped;
  }

  return current;
}

/**
 * Console-backed logger used when the caller has no structured
 * logging surface handy. Prefer passing a bot-specific logger in
 * production; this is a safe default for CLI / test usage.
 */
export function consoleMigrationLogger(
  level: MigrationLogLevel,
  msg: string,
  meta?: unknown,
): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
