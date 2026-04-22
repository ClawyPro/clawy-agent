/**
 * Task Lifecycle storage (0.17.1).
 *
 * Runtime-level management of the hipocampus task-tracking trio:
 *   - `TASK-QUEUE.md`          — pending items (append-on-detect)
 *   - `WORKING.md`             — active turn(s) (promoted on beforeLLMCall)
 *   - `memory/YYYY-MM-DD.md`   — daily log (append on afterTurnEnd)
 *
 * Kevin's design goal: bots must NOT rely on prompt instructions to
 * maintain these files. The runtime transparently keeps them coherent
 * via hooks (see ../hooks/builtin/taskLifecycle.ts).
 *
 * All disk ops use the fs-safe wrappers (§15.2) and fail OPEN — a
 * broken file MUST NOT abort a turn. Callers log via the returned
 * boolean / swallowed errors; this module itself does not throw.
 *
 * File formats (locked by Kevin):
 *
 *   TASK-QUEUE.md line:
 *     - [ ] {isoTimestamp} turnId={id} | {message}
 *
 *   WORKING.md entry:
 *     ## {isoTimestamp} turnId={id} · ACTIVE
 *     {message}
 *
 *   memory/YYYY-MM-DD.md entry:
 *     ## {isoTimestamp} turnId={id} · {duration}s · {toolCallCount} tools
 *     **User:** {message}
 *     {#hashtags}
 *     ({artifacts list if any})
 *     ---
 */

import fs from "node:fs/promises";
import path from "node:path";
import { appendSafe, readSafe, writeSafe } from "../util/fsSafe.js";

/** Shape of the metadata passed to `moveWorkingToDaily`. */
export interface DailyLogMeta {
  /** Turn duration in milliseconds (exported to seconds in the log). */
  duration: number;
  /** Total tool calls observed this turn. */
  toolCallCount: number;
  /** Absolute or workspace-relative artifact paths, if any. */
  artifacts?: ReadonlyArray<string>;
  /** Original user message — copied to the daily entry for context. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Hashtag extraction (heuristic)
// ---------------------------------------------------------------------------

/**
 * Stop-words that must NEVER become a hashtag. Tuned for both KO and
 * EN; skewed toward common filler the LLM keeps emitting.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  // EN generic
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "so", "if", "then", "than", "that", "this", "these",
  "those", "to", "of", "in", "on", "at", "by", "for", "with", "from",
  "about", "into", "over", "after", "before", "between", "through", "during",
  "up", "down", "out", "off", "again", "once", "here", "there", "when",
  "where", "why", "how", "what", "who", "which", "can", "will", "would",
  "should", "could", "may", "might", "must", "shall", "not", "no", "yes",
  "do", "does", "did", "have", "has", "had", "get", "got", "make", "made",
  "please", "just", "only", "also", "very", "too", "more", "less", "some",
  "any", "all", "each", "every", "other", "such", "same", "own", "me",
  "my", "mine", "you", "your", "yours", "he", "she", "it", "we", "they",
  "them", "us", "our", "ours", "their", "theirs", "his", "her", "hers",
  "one", "two", "three", "many", "few", "lot", "lots",
  // KO particles / filler (latinised)
  "하다", "되다", "있다", "없다", "이다", "아니", "그리고", "그러나",
  "해줘", "해주세요", "주세요", "네", "아니요", "근데", "그래", "좀",
]);

/**
 * Heuristic KO → EN domain keyword mapping. Kevin-approved seed list;
 * extensible. Unmapped KO tokens fall through to literal stem
 * extraction (Hangul kept as-is — Hashtag spec allows Unicode).
 *
 * 0.17.2: lookup is prefix-based, not exact — a token matches any key
 * it starts with (e.g. "정리해줘".startsWith("정리") → summary). This
 * covers arbitrary Korean verb/noun inflections without requiring a
 * morphological analyzer. Longer keys are checked first so "리팩토링"
 * preempts "리팩터".
 */
const KO_EN_DOMAIN_MAP: ReadonlyMap<string, string> = new Map([
  // Sales / commerce
  ["매출", "sales"],
  ["판매", "sales"],
  ["pos", "pos"],
  ["POS", "pos"],
  ["주문", "order"],
  ["결제", "payment"],
  ["환불", "refund"],
  ["재고", "inventory"],
  ["가격", "price"],
  ["메뉴", "menu"],
  // Finance / billing
  ["청구", "billing"],
  ["요금", "billing"],
  ["크레딧", "credits"],
  ["세금", "tax"],
  // Engineering
  ["배포", "deploy"],
  ["빌드", "build"],
  ["테스트", "test"],
  ["버그", "bug"],
  ["디버그", "debug"],
  ["리팩터", "refactor"],
  ["리팩토링", "refactor"],
  // Infra
  ["서버", "server"],
  ["클러스터", "cluster"],
  ["노드", "node"],
  ["쿠버네티스", "kubernetes"],
  // Research / docs
  ["분석", "analysis"],
  ["보고서", "report"],
  ["리포트", "report"],
  ["문서", "doc"],
  ["정리", "summary"],
  // Communication
  ["메일", "email"],
  ["이메일", "email"],
  ["메시지", "message"],
  ["알림", "notification"],
]);

/**
 * Pre-computed Hangul dict keys, sorted longest-first, so the prefix
 * lookup below prefers the most specific match (e.g. "리팩토링" over
 * "리팩터"). Non-Hangul keys (ASCII like "pos"/"POS") are filtered —
 * ASCII tokens use a separate exact-match path.
 */
const KO_DICT_KEYS: ReadonlyArray<string> = Array.from(KO_EN_DOMAIN_MAP.keys())
  .filter((k) => /^[\uAC00-\uD7A3]+$/.test(k))
  .sort((a, b) => b.length - a.length);

/**
 * Return the mapped EN keyword for a Hangul token if any dict key is a
 * prefix of the token ("정리해줘".startsWith("정리") → "summary"). Null
 * when no key matches — caller falls through to literal token.
 */
function mapHangulPrefix(token: string): string | null {
  for (const key of KO_DICT_KEYS) {
    if (token.startsWith(key)) {
      return KO_EN_DOMAIN_MAP.get(key) ?? null;
    }
  }
  return null;
}

/** Match a run of ASCII word or Hangul syllables — cheap tokeniser. */
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_]*|[\uAC00-\uD7A3]+/g;

/**
 * Extract a small, deterministic list of `#tag` strings from an
 * arbitrary user message. Heuristic:
 *   1. Tokenise ASCII words + Hangul runs.
 *   2. Map via KO_EN_DOMAIN_MAP — exact for ASCII, prefix for Hangul
 *      (handles inflection: "정리해줘".startsWith("정리") → "summary").
 *   3. Lowercase, de-dupe, drop stop-words, drop 1-char tokens.
 *   4. Cap at 6 hashtags.
 */
export function extractHashtags(text: string): string[] {
  if (!text) return [];
  const tokens = text.match(TOKEN_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    let mapped: string;
    const isHangul = /^[\uAC00-\uD7A3]+$/.test(raw);
    if (isHangul) {
      mapped = mapHangulPrefix(raw) ?? raw;
    } else {
      mapped = KO_EN_DOMAIN_MAP.get(raw) ?? raw.toLowerCase();
    }
    if (mapped.length < 2) continue;
    if (STOP_WORDS.has(mapped)) continue;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(`#${mapped}`);
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Minimal multi-line-aware "remove first block referencing turnId"
 * editor. Preserves all other lines / blocks verbatim.
 *
 * TASK-QUEUE.md blocks are single-line. WORKING.md blocks span from a
 * `## ... turnId={id}` heading up to (but not including) the next
 * `##` heading or EOF. Passing `singleLine=true` enforces the former.
 */
function removeTurnIdEntry(
  contents: string,
  turnId: string,
  singleLine: boolean,
): { updated: string; removed: string | null } {
  const marker = `turnId=${turnId}`;
  if (!contents.includes(marker)) {
    return { updated: contents, removed: null };
  }
  const lines = contents.split("\n");
  if (singleLine) {
    const idx = lines.findIndex((l) => l.includes(marker));
    if (idx < 0) return { updated: contents, removed: null };
    const removed = lines[idx] ?? "";
    lines.splice(idx, 1);
    return { updated: lines.join("\n"), removed };
  }
  // Multi-line: find `## ... turnId={id}` heading, take until next `##`.
  const startIdx = lines.findIndex(
    (l) => l.startsWith("## ") && l.includes(marker),
  );
  if (startIdx < 0) return { updated: contents, removed: null };
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (ln !== undefined && ln.startsWith("## ")) {
      endIdx = i;
      break;
    }
  }
  const removed = lines.slice(startIdx, endIdx).join("\n");
  lines.splice(startIdx, endIdx - startIdx);
  return { updated: lines.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a new queued task to `TASK-QUEUE.md`. Creates the file (and
 * parent dir, if unlikely-missing) on first use. Fail-open.
 *
 * Returns `true` on success, `false` when the write failed (logged as
 * warn via console — callers that care can inspect via side-channel).
 */
export async function appendToTaskQueue(
  workspaceRoot: string,
  entry: { turnId: string; message: string; timestamp?: string },
): Promise<boolean> {
  const ts = entry.timestamp ?? nowIso();
  const line = `- [ ] ${ts} turnId=${entry.turnId} | ${singleLine(entry.message)}\n`;
  try {
    await appendSafe("TASK-QUEUE.md", line, workspaceRoot);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[TaskQueue] appendToTaskQueue failed", err);
    return false;
  }
}

/**
 * Pop the matching entry from `TASK-QUEUE.md` and append an ACTIVE
 * block to `WORKING.md`. If no queue entry exists (e.g. heuristic
 * didn't classify the turn as "task" up-front), we still record the
 * active block so WORKING.md stays authoritative for in-flight turns.
 *
 * Returns `true` when at least the WORKING.md write succeeded.
 */
export async function moveQueueToWorking(
  workspaceRoot: string,
  turnId: string,
  fallbackMessage?: string,
): Promise<boolean> {
  const ts = nowIso();
  let promotedMessage: string | null = null;

  // Best-effort queue pop. On failure we still append to WORKING.md.
  try {
    const queue = await readSafe("TASK-QUEUE.md", workspaceRoot);
    const { updated, removed } = removeTurnIdEntry(queue, turnId, true);
    if (removed) {
      // Line format: `- [ ] {ts} turnId={id} | {message}`
      const pipe = removed.indexOf(" | ");
      if (pipe >= 0) promotedMessage = removed.slice(pipe + 3).trim();
      await writeSafe("TASK-QUEUE.md", updated, workspaceRoot);
    }
  } catch (err) {
    // ENOENT is common (no queue yet) — normal path. Log only truly
    // unexpected errors.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[TaskQueue] queue pop failed (continuing)", err);
    }
  }

  const msg = promotedMessage ?? fallbackMessage ?? "";
  const block =
    `## ${ts} turnId=${turnId} · ACTIVE\n` +
    (msg ? `${singleLine(msg)}\n` : "") +
    `\n`;
  try {
    await appendSafe("WORKING.md", block, workspaceRoot);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[TaskQueue] WORKING.md append failed", err);
    return false;
  }
}

/**
 * Remove the active block from `WORKING.md` and append a structured
 * entry to `memory/YYYY-MM-DD.md`. Hashtags are extracted from the
 * original user message (preferred) or the promoted WORKING.md body
 * (fallback). Fail-open.
 */
export async function moveWorkingToDaily(
  workspaceRoot: string,
  turnId: string,
  meta: DailyLogMeta,
): Promise<boolean> {
  const ts = nowIso();
  const date = fmtDate(new Date());

  // 1. Try to pop the matching ACTIVE block from WORKING.md. If absent,
  //    we still append to the daily log — the daily log is the
  //    durable record.
  let workingBody: string | null = null;
  try {
    const working = await readSafe("WORKING.md", workspaceRoot);
    const { updated, removed } = removeTurnIdEntry(working, turnId, false);
    if (removed) {
      // Strip the `## ...` heading line, keep rest (body).
      const nl = removed.indexOf("\n");
      workingBody = nl >= 0 ? removed.slice(nl + 1).trim() : "";
      await writeSafe("WORKING.md", updated, workspaceRoot);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      // eslint-disable-next-line no-console
      console.warn("[TaskQueue] WORKING.md pop failed (continuing)", err);
    }
  }

  const userMessage = meta.message ?? workingBody ?? "";
  const tags = extractHashtags(userMessage);
  const durationSec = Math.max(0, Math.round(meta.duration / 1000));
  const artifactsLine =
    meta.artifacts && meta.artifacts.length > 0
      ? `**Artifacts:** ${meta.artifacts.map((a) => `\`${a}\``).join(", ")}\n`
      : "";

  const entry =
    `\n## ${ts} turnId=${turnId} · ${durationSec}s · ${meta.toolCallCount} tool${
      meta.toolCallCount === 1 ? "" : "s"
    }\n` +
    (userMessage ? `**User:** ${singleLine(userMessage)}\n` : "") +
    (tags.length > 0 ? `${tags.join(" ")}\n` : "") +
    artifactsLine +
    `---\n`;

  try {
    // Ensure memory/ exists — fsSafe's O_CREAT only creates the file,
    // not its parent directory. `mkdir -p` is idempotent.
    await fs.mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
    const relPath = path.posix.join("memory", `${date}.md`);
    await appendSafe(relPath, entry, workspaceRoot);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[TaskQueue] daily log append failed", err);
    return false;
  }
}

/** Collapse a user message to a single line for queue / daily-log use. */
function singleLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
