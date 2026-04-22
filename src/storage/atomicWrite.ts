/**
 * Atomic write helpers used across storage / cron / task / artifact
 * modules. Pattern: write to a tmp sibling → rename → filesystem-
 * atomic visibility. POSIX `rename` is atomic within the same
 * filesystem, which is all we use (workspace PVC).
 *
 * Callers MUST NOT rely on atomicity across different volume mounts.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Build a per-write unique tmp sibling path. Using pid + hrtime +
 * random bytes prevents collisions when two in-flight writers race
 * on the same target within the same millisecond (Date.now() alone
 * is not sufficient under tight concurrency).
 */
function tmpNameFor(target: string): string {
  const rand = crypto.randomBytes(6).toString("hex");
  return `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

/**
 * Write JSON to `target` atomically via tmp-rename. Creates parent
 * dirs with { recursive: true }. Uses pretty-print (2-space indent)
 * since all our use-cases are human-inspectable state files.
 */
export async function atomicWriteJson(
  target: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpNameFor(target);
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Write raw bytes/string to `target` atomically.
 */
export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = tmpNameFor(target);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, target);
}
