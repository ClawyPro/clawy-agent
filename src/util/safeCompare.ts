/**
 * Constant-time string/buffer compare.
 *
 * Used by HTTP gateway-token checks (§6 invariant G audit endpoints)
 * to avoid timing attacks that leak secret bytes. Mirrors the
 * `safeCompare` helper shipped in the web app at
 * `src/lib/auth/safe-compare.ts`.
 *
 * Returns false on length mismatch without comparing contents.
 */

import crypto from "node:crypto";

export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
