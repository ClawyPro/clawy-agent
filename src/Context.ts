/**
 * Context — T4-19 §7.10
 *
 * A Session can own multiple parallel conversation contexts (like
 * Claude Code's separate chats inside one project). Each Context has
 * its own transcript, compaction history, and per-context budget
 * stats. The Session is the outer tenant boundary (auth + aggregate
 * budget); Contexts are orthogonal conversation threads inside it.
 *
 * Storage layout:
 *   - Default context (`contextId === "default"`): legacy flat path
 *     `{sessionsDir}/{sha1(sessionKey)}.jsonl` — preserves the
 *     pre-T4-19 layout so existing session data is readable without
 *     any migration step.
 *   - Additional contexts: `{sessionsDir}/{sha1(sessionKey)}__{contextId}.jsonl`
 *
 * The meta index (list of contexts + active pointer) lives at
 *   `{sessionsDir}/{sha1(sessionKey)}.meta.json`
 * and is hydrated lazily on Session construction.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { monotonicFactory } from "ulid";
import { atomicWriteJson } from "./storage/atomicWrite.js";
import { Transcript } from "./storage/Transcript.js";
import {
  applyMigrations,
  consoleMigrationLogger,
  sessionMigrations,
  CURRENT_SESSION_META_SCHEMA_VERSION,
  type SessionMetaShape,
} from "./migrations/index.js";
import type { TokenUsage } from "./util/types.js";

const ulid = monotonicFactory();

export const DEFAULT_CONTEXT_ID = "default";

export interface ContextMeta {
  contextId: string;
  sessionKey: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  systemPromptAddendum?: string;
  archived: boolean;
}

export interface ContextStats {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function hashSessionKey(sessionKey: string): string {
  return crypto.createHash("sha1").update(sessionKey).digest("hex").slice(0, 16);
}

function transcriptPathForContext(
  sessionsDir: string,
  sessionKey: string,
  contextId: string,
): string {
  const hash = hashSessionKey(sessionKey);
  if (contextId === DEFAULT_CONTEXT_ID) {
    return path.join(sessionsDir, `${hash}.jsonl`);
  }
  return path.join(sessionsDir, `${hash}__${contextId}.jsonl`);
}

export function metaIndexPath(sessionsDir: string, sessionKey: string): string {
  const hash = hashSessionKey(sessionKey);
  return path.join(sessionsDir, `${hash}.meta.json`);
}

interface MetaFile {
  /**
   * Populated by the migration framework after `loadMetaIndex`
   * applies `sessionMigrations`. See `src/migrations/sessionMigrations.ts`.
   */
  schemaVersion?: number;
  contexts: ContextMeta[];
  activeContextId: string;
}

/**
 * Load the on-disk meta index and run any pending schema migrations.
 *
 * Migration failure policy: a thrown `applyMigrations` error
 * propagates to the caller (Session hydration) and ultimately aborts
 * `Agent.start()` — matching the design-doc cordon semantics. The
 * backup (`.pre-v<N>`) is left on disk for offline inspection.
 */
export async function loadMetaIndex(
  sessionsDir: string,
  sessionKey: string,
): Promise<MetaFile | null> {
  const p = metaIndexPath(sessionsDir, sessionKey);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: MetaFile;
  try {
    parsed = JSON.parse(raw) as MetaFile;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.contexts)) return null;
  if (typeof parsed.activeContextId !== "string") return null;

  // Apply migrations. `workspaceRoot` is best-effort — the Session
  // meta index lives under sessionsDir which is typically
  // `{workspaceRoot}/core-agent/sessions`. Walk two levels up so
  // future migrations that need sibling files (e.g. an AuditLog
  // merge) have a stable anchor.
  const workspaceRoot = path.resolve(sessionsDir, "..", "..");
  const shape: SessionMetaShape = {
    ...(typeof parsed.schemaVersion === "number"
      ? { schemaVersion: parsed.schemaVersion }
      : {}),
    contexts: parsed.contexts,
    activeContextId: parsed.activeContextId,
  };
  const migrated = await applyMigrations(shape, sessionMigrations, {
    workspaceRoot,
    log: consoleMigrationLogger,
    targetPath: p,
  });
  return {
    schemaVersion: migrated.schemaVersion ?? 0,
    contexts: migrated.contexts,
    activeContextId: migrated.activeContextId,
  };
}

export async function writeMetaIndex(
  sessionsDir: string,
  sessionKey: string,
  meta: MetaFile,
): Promise<void> {
  const p = metaIndexPath(sessionsDir, sessionKey);
  // Stamp the current schema version on every write so newly-created
  // meta files start at the latest version (avoids an immediate
  // noop-migration on the next load).
  const toWrite: MetaFile = {
    schemaVersion: CURRENT_SESSION_META_SCHEMA_VERSION,
    contexts: meta.contexts,
    activeContextId: meta.activeContextId,
  };
  await atomicWriteJson(p, toWrite);
}

export function newContextId(): string {
  return ulid();
}

export class Context {
  readonly meta: ContextMeta;
  readonly transcript: Transcript;

  private cumulativeTurns = 0;
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCostUsd = 0;

  constructor(meta: ContextMeta, sessionsDir: string) {
    this.meta = meta;
    // Transcript expects (dir, sessionKey) — we pass the computed
    // transcript path components. Wrap: override Transcript's internal
    // path by constructing it with a synthesized "sessionKey" that
    // yields the desired hash. Simpler: construct normally, then the
    // transcript writes to its own default path; we instead use the
    // context-specific path via a small wrapper construction below.
    this.transcript = new Transcript(sessionsDir, meta.sessionKey, {
      filePath: transcriptPathForContext(sessionsDir, meta.sessionKey, meta.contextId),
    });
  }

  recordTurn(usage: TokenUsage): void {
    this.cumulativeTurns += 1;
    this.cumulativeInputTokens += usage.inputTokens;
    this.cumulativeOutputTokens += usage.outputTokens;
    this.cumulativeCostUsd += usage.costUsd;
    this.meta.lastActivityAt = Date.now();
  }

  stats(): ContextStats {
    return {
      turns: this.cumulativeTurns,
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      costUsd: this.cumulativeCostUsd,
    };
  }
}
