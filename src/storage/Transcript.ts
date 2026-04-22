/**
 * Transcript — per-session append-only jsonl.
 * Design reference: §5.2, §6-F.
 *
 * Phase 1b: minimal writer. Each line is a standalone JSON object with
 * a `kind` discriminator. Startup-replay logic lives in Session, which
 * ignores any trailing entries without a matching `turn_committed`
 * event (invariant F).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  applyMigrations,
  consoleMigrationLogger,
  transcriptMigrations,
  type TranscriptShape,
} from "../migrations/index.js";

export type TranscriptEntry =
  | {
      kind: "user_message";
      ts: number;
      turnId: string;
      text: string;
    }
  | {
      kind: "assistant_text";
      ts: number;
      turnId: string;
      text: string;
    }
  | {
      kind: "tool_call";
      ts: number;
      turnId: string;
      toolUseId: string;
      name: string;
      input: unknown;
    }
  | {
      kind: "tool_result";
      ts: number;
      turnId: string;
      toolUseId: string;
      status: string;
      output?: string;
      isError?: boolean;
    }
  | {
      kind: "turn_started";
      ts: number;
      turnId: string;
      declaredRoute: string;
    }
  | {
      kind: "turn_committed";
      ts: number;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      kind: "turn_aborted";
      ts: number;
      turnId: string;
      reason: string;
    }
  | {
      kind: "compaction_boundary";
      ts: number;
      turnId: string;
      boundaryId: string;
      beforeTokenCount: number;
      afterTokenCount: number;
      summaryHash: string;
      summaryText: string;
      createdAt: number;
    };

/**
 * Type guard for `compaction_boundary` transcript entries (T1-02).
 * Used by `ContextEngine.buildMessagesFromTranscript` to partition
 * entries into pre-boundary (collapsed to synthetic summary) vs
 * post-boundary (replayed normally).
 */
export function isCompactionBoundary(
  entry: TranscriptEntry,
): entry is Extract<TranscriptEntry, { kind: "compaction_boundary" }> {
  return entry.kind === "compaction_boundary";
}

export interface TranscriptOptions {
  /**
   * Optional explicit file path override. Used by T4-19 Context so a
   * non-default context can live at `{sha1(sessionKey)}__{contextId}.jsonl`
   * while the default context keeps the legacy flat layout.
   */
  filePath?: string;
}

export class Transcript {
  readonly filePath: string;

  constructor(sessionsDir: string, sessionKey: string, opts?: TranscriptOptions) {
    if (opts?.filePath) {
      this.filePath = opts.filePath;
      return;
    }
    // Hash sessionKey into a filesystem-safe filename (colons allowed
    // on ext4 but not portable; strip to be safe).
    const hash = crypto.createHash("sha1").update(sessionKey).digest("hex").slice(0, 16);
    this.filePath = path.join(sessionsDir, `${hash}.jsonl`);
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async append(entry: TranscriptEntry): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(entry) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }

  /**
   * Read the transcript (whole file, Phase 1b is small). Returns all
   * entries including uncommitted tails — the caller is responsible
   * for discarding anything past the last `turn_committed`.
   *
   * Runs any pending transcript schema migrations in-memory. The
   * JSONL on-disk layout is append-only so the framework operates on
   * the parsed entry list without rewriting the file; the per-file
   * schema version lives in the sibling `{stem}.schema.json`
   * sentinel (see `src/migrations/transcriptMigrations.ts`). v0→v1
   * is a no-op today so no sentinel is required for existing data.
   */
  async readAll(): Promise<TranscriptEntry[]> {
    let txt: string;
    try {
      txt = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: TranscriptEntry[] = [];
    for (const line of txt.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as TranscriptEntry);
      } catch {
        // Ignore malformed trailing lines (crash during write).
      }
    }

    // Apply migrations in-memory. Target path omitted on purpose —
    // we never rewrite the append-only JSONL file; future migrations
    // that need to persist per-file version metadata should write to
    // a sibling sentinel, not touch the transcript itself.
    const shape: TranscriptShape = { entries };
    const migrated = await applyMigrations(shape, transcriptMigrations, {
      workspaceRoot: path.dirname(this.filePath),
      log: consoleMigrationLogger,
    });
    return migrated.entries;
  }

  /**
   * All entries that should be visible to the LLM for message
   * construction.
   *
   * 2026-04-21 fix: previously only `turn_committed` boundaries were
   * recognised, so aborted turns (answer-verifier timeout, sealed-file
   * violations, etc.) vanished from the transcript. The LLM then saw
   * no prior conversation and "forgot" everything the user had said.
   *
   * The revised strategy includes ALL entries regardless of whether
   * their owning turn was committed, aborted, or never finished (pod
   * crash / OOM). The user saw the assistant's streamed output and
   * expects continuity — excluding any turn from the transcript creates
   * a conversation-history gap that confuses the model.
   *
   * Uncommitted trailing entries from a turn that is *currently in
   * progress* (i.e. no boundary yet because the turn hasn't finished)
   * are harmless: `buildMessages` is only called at the START of a new
   * turn, and Session.runTurn holds a mutex so no two turns overlap.
   * By the time the next turn reads the transcript, the prior turn has
   * either committed or aborted — both are now included.
   */
  async readCommitted(): Promise<TranscriptEntry[]> {
    return this.readAll();
  }
}
