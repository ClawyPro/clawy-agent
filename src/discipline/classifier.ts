/**
 * Turn-mode classifier for the Coding Discipline subsystem
 * (docs/plans/2026-04-20-coding-discipline-design.md §"Session.meta.discipline").
 *
 * Pure heuristic — no LLM call, no external I/O. Classifies a user
 * message into one of three buckets so the classifier hook can set
 * Session.meta.discipline.{tdd,git}:
 *
 *   - `"coding"`:      TDD + git hygiene active, soft enforcement
 *   - `"exploratory"`: git hygiene only (commit checkpoints); no TDD
 *                      (prototype / throwaway scripts)
 *   - `"other"`:       no discipline (docs, analysis, plain chat)
 *
 * Confidence is a crude 0..1 score capturing "how many positive
 * signals did we see". Callers should treat confidence < 0.6 as
 * unreliable and fall through to `other` — the caller is responsible
 * for enforcing that floor (the classifier returns the raw label +
 * confidence so tests can observe both).
 *
 * Determinism invariant: same input → same output. No hidden state.
 * No Date.now(), no Math.random(). This is load-bearing for the
 * classifier.test.ts fixture suite.
 */

export type ModeLabel = "coding" | "exploratory" | "other";

export interface ModeClassification {
  label: ModeLabel;
  confidence: number;
}

/**
 * Signals for `coding` — explicit implementation verbs, test-oriented
 * requests, code-fence presence, code-file path mentions. Regexes are
 * compiled once at module-load time; iteration order matches the
 * order below.
 */
const CODING_SIGNALS: readonly RegExp[] = [
  /\b(implement|refactor|fix\s+(?:a|the|this)?\s*bug|add\s+(?:a\s+)?test|debug|unit\s+test|integration\s+test|tdd)\b/i,
  /\b(write|make|build|create)\s+(?:a\s+|the\s+|an\s+)?(?:\w+\s+){0,3}?(?:function|class|module|component|hook|endpoint|handler|route|test|spec)\b/i,
  /\bfix(?:ing)?\b.*\b(bug|error|crash|failure|regression)\b/i,
  /\b(type|compile|lint)\s*(?:error|issue|problem)\b/i,
  /```[a-z]*\n/, // fenced code block
  /\b(add|update|modify|change)\b.*\.(?:ts|tsx|js|jsx|py|rs|go|java|rb|swift|kt)\b/i,
  /\bpull\s+request\b|\bcommit\b|\bgit\s+(?:add|commit|rebase|merge)\b/i,
  /\b(failing\s+test|test\s+first|passing\s+tests?|red[-/]\s*green|green[-/]\s*refactor)\b/i,
];

/**
 * Signals for `exploratory` — explicit prototype / throwaway intent.
 * These override coding only when they appear alongside weaker coding
 * signals (code fences alone, or a single path mention). A strong
 * coding verb plus an exploratory hedge is still coding — people say
 * "implement a quick prototype" and mean it.
 */
const EXPLORATORY_SIGNALS: readonly RegExp[] = [
  /\b(let\s+me\s+try|just\s+trying|experimenting|exploring)\b/i,
  /\b(prototype|proof[- ]of[- ]concept|poc|scratch\s*(?:pad|file)?)\b/i,
  /\bjust\s+for\s+fun\b/i,
  /\bquick\s+script\b|\bthrow[- ]away\b|\bthrowaway\b/i,
  /\bsandbox(?:ing)?\b/i,
];

/**
 * Signals that explicitly want discipline OFF for this turn. Checked
 * by the classifier hook (not here) to short-circuit the classifier
 * output — see {@link hasSkipTddSignal}.
 */
const SKIP_TDD_SIGNALS: readonly RegExp[] = [
  /\bskip\s+tdd\b/i,
  /\bno\s+tests?\b(?!\s+ran)/i, // "no tests" but not "no tests ran"
  /\bwithout\s+tests?\b/i,
  /\bdisable\s+discipline\b/i,
];

/** Returns true when the user's message explicitly opts out of TDD. */
export function hasSkipTddSignal(text: string): boolean {
  for (const re of SKIP_TDD_SIGNALS) if (re.test(text)) return true;
  return false;
}

/**
 * Count how many patterns in `patterns` match `text`. Each pattern
 * contributes at most 1 hit regardless of how many times it matches
 * — we're measuring signal variety, not frequency (a user who says
 * "test" 10 times isn't 10x more likely to be coding than someone
 * who said it once + mentioned a filename).
 */
function countHits(text: string, patterns: readonly RegExp[]): number {
  let n = 0;
  for (const re of patterns) if (re.test(text)) n++;
  return n;
}

/**
 * Classify a user message into a mode bucket. Pure function — safe
 * to call on every turn without caching.
 *
 * Algorithm:
 *   1. Count coding + exploratory signal hits.
 *   2. Confidence for the winning label = hits / (hits_cap) where
 *      hits_cap is the number of signal patterns for that label. A
 *      message matching every coding pattern scores 1.0.
 *   3. Label selection:
 *        - 0 coding + 0 exploratory  → other, confidence 1.0 (sure)
 *        - coding > exploratory       → coding
 *        - exploratory > coding       → exploratory
 *        - tie (both > 0)             → coding (TDD is the safer default
 *                                       when a prototype turns real)
 *   4. If confidence < 0.6 (< 60% of the label's signal set matched),
 *      callers should demote to `other` — this function emits the raw
 *      label + confidence; gating is the caller's responsibility.
 */
export function classifyTurnMode(text: string): ModeClassification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { label: "other", confidence: 1 };
  }

  const codingHits = countHits(trimmed, CODING_SIGNALS);
  const exploratoryHits = countHits(trimmed, EXPLORATORY_SIGNALS);

  if (codingHits === 0 && exploratoryHits === 0) {
    return { label: "other", confidence: 1 };
  }

  // "Exploratory" is really "coding with a different flavour" — the
  // presence of ANY coding verb alongside an exploratory hedge is
  // still coding, because the exploratory signal usually modifies a
  // coding verb ("let me try implementing X"). Only when exploratory
  // is the dominant signal do we flip the label.
  let label: ModeLabel;
  if (exploratoryHits > codingHits) {
    label = "exploratory";
  } else {
    // ties broken to coding — safer default (TDD is opt-out).
    label = "coding";
  }

  const denom =
    label === "coding" ? CODING_SIGNALS.length : EXPLORATORY_SIGNALS.length;
  const hits = label === "coding" ? codingHits : exploratoryHits;
  // Boost: a single strong signal (code fence, test verb) is already
  // meaningful, so normalise with a small floor so one hit doesn't
  // give a 14%-ish confidence that gets demoted downstream.
  const raw = hits / denom;
  const boosted = Math.min(1, raw + 0.4); // floor at ~0.4 for 0 hits
  const confidence = hits === 0 ? 0 : boosted;
  return { label, confidence };
}

/**
 * Convenience wrapper applying the 0.6 confidence floor described in
 * the design doc. Below the floor, the label is demoted to `other`.
 */
export function classifyTurnModeGated(
  text: string,
  floor = 0.6,
): ModeClassification {
  const raw = classifyTurnMode(text);
  if (raw.label === "other") return raw;
  if (raw.confidence < floor) {
    return { label: "other", confidence: raw.confidence };
  }
  return raw;
}
