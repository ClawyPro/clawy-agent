/**
 * AuditLog — append-only per-bot audit trail (§6 invariant G, §11).
 *
 * Separate from the session transcripts so queryable events
 * (policy violations, consent prompts, route changes, cost ticks) can
 * be read without scanning every session's jsonl.
 *
 * Schema: one JSON object per line at
 *   {workspaceRoot}/core-agent/audit.jsonl
 *
 * Entry shape (see §6.G):
 *   { ts, botId, sessionKey, turnId?, event, data }
 *
 * `event` is a short string — design lists:
 *   turn_started, turn_committed, turn_aborted,
 *   llm_call_start, llm_call_end,
 *   tool_call_start, tool_call_end,
 *   permission_denied, hook_block, rule_violation,
 *   consent_requested, consent_granted, consent_denied,
 *   route_change, cost_recorded
 *
 * Phase 2h introduces the file + HTTP read endpoint. Writes are
 * opt-in via `Agent.auditLog` — existing Turn code writes nothing
 * here yet (§11 wires the full emission surface).
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Categories of events considered "policy" — used by the compliance
 * endpoint to filter a session's audit trail down to governance
 * events (what a compliance officer cares about).
 */
export const POLICY_EVENT_NAMES = [
  "permission_denied",
  "hook_block",
  "rule_violation",
  "consent_requested",
  "consent_granted",
  "consent_denied",
  "route_change",
] as const;

export type PolicyEventName = (typeof POLICY_EVENT_NAMES)[number];

export function isPolicyEvent(name: string): name is PolicyEventName {
  return (POLICY_EVENT_NAMES as readonly string[]).includes(name);
}

export interface AuditEntry {
  ts: number;
  botId: string;
  sessionKey: string;
  turnId?: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface AuditQuery {
  sessionKey?: string;
  turnId?: string;
  event?: string;
  since?: number;
  until?: number;
  limit?: number;
  /** Byte-offset cursor returned by a previous call (opaque). */
  cursor?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Byte offset suitable as `cursor` for the next page, or null. */
  nextCursor: number | null;
}

export class AuditLog {
  readonly filePath: string;
  private readonly botId: string;

  constructor(workspaceRoot: string, botId: string) {
    this.filePath = path.join(workspaceRoot, "core-agent", "audit.jsonl");
    this.botId = botId;
  }

  async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  /**
   * Append a structured audit event. Swallows write errors — audit is
   * best-effort and must never abort a turn.
   */
  async append(
    event: string,
    sessionKey: string,
    turnId: string | undefined,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const entry: AuditEntry = {
      ts: Date.now(),
      botId: this.botId,
      sessionKey,
      ...(turnId ? { turnId } : {}),
      event,
      ...(data ? { data } : {}),
    };
    try {
      await this.ensureDir();
      await fs.appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.warn(
        `[audit] append failed event=${event}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Stream the log line-by-line applying the filter. Stops at `limit`.
   * Uses readline so very large logs (tens of MB) don't blow heap.
   */
  async query(q: AuditQuery = {}): Promise<AuditPage> {
    const limit = clampInt(q.limit, 1, 10_000, 200);
    const since = typeof q.since === "number" ? q.since : undefined;
    const until = typeof q.until === "number" ? q.until : undefined;

    const entries: AuditEntry[] = [];
    let exists = true;
    try {
      await fs.access(this.filePath);
    } catch {
      exists = false;
    }
    if (!exists) return { entries, nextCursor: null };

    const stream = fsSync.createReadStream(this.filePath, {
      encoding: "utf8",
      start: q.cursor && q.cursor > 0 ? q.cursor : 0,
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let bytes = q.cursor && q.cursor > 0 ? q.cursor : 0;
    let nextCursor: number | null = null;
    for await (const line of rl) {
      // `line` doesn't include the trailing \n; account for it when
      // producing a byte-offset cursor.
      const consumed = Buffer.byteLength(line, "utf8") + 1;
      bytes += consumed;
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isAuditEntry(parsed)) continue;
      if (q.sessionKey && parsed.sessionKey !== q.sessionKey) continue;
      if (q.turnId && parsed.turnId !== q.turnId) continue;
      if (q.event && parsed.event !== q.event) continue;
      if (since !== undefined && parsed.ts < since) continue;
      if (until !== undefined && parsed.ts > until) continue;
      entries.push(parsed);
      if (entries.length >= limit) {
        nextCursor = bytes;
        break;
      }
    }
    rl.close();
    stream.destroy();
    return { entries, nextCursor };
  }
}

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isAuditEntry(x: unknown): x is AuditEntry {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["ts"] === "number" &&
    typeof o["botId"] === "string" &&
    typeof o["sessionKey"] === "string" &&
    typeof o["event"] === "string" &&
    (o["turnId"] === undefined || typeof o["turnId"] === "string")
  );
}
