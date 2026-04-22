/**
 * Discipline config loader —
 * reads `workspace/.discipline.yaml` on Agent.start and returns the
 * materialised {@link Discipline} block (or null when absent/malformed).
 *
 * Shape (per design doc):
 *
 *   tdd:
 *     enabled: true
 *     testPatterns: ["**\/*.test.ts", "**\/*.spec.ts"]
 *     sourcePatterns: ["src/**\/*.ts"]
 *     enforcement: soft         # off | soft | hard
 *   git:
 *     enabled: true
 *     maxChangesBeforeCommit: 10
 *     autoCheckpoint: false     # reserved, ignored for v1
 *
 * Malformed YAML or missing-but-requested keys do NOT throw — this is
 * a best-effort enhancement and the runtime must continue starting.
 * Callers that see `null` should fall back to {@link DEFAULT_DISCIPLINE}.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Discipline } from "../Session.js";

export const DISCIPLINE_CONFIG_FILENAME = ".discipline.yaml";

/**
 * Baked-in defaults (coding axis OFF). Kept in sync with
 * {@link DEFAULT_DISCIPLINE_MIGRATION} in migrations/sessionMigrations.ts
 * — if you update one, update both. The duplication exists so
 * migrations stay free of runtime imports.
 */
export const DEFAULT_DISCIPLINE: Discipline = {
  tdd: false,
  git: false,
  requireCommit: "off",
  maxChangesBeforeCommit: 10,
  testPatterns: [
    "**/*.test.{ts,tsx,js,jsx}",
    "**/*.spec.{ts,tsx,js,jsx}",
    "**/*.test.py",
    "**/*.spec.py",
  ],
  sourcePatterns: ["src/**/*.{ts,tsx,js,jsx}", "src/**/*.py"],
};

function asBool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const el of v) {
    if (typeof el === "string" && el.length > 0) out.push(el);
  }
  return out.length > 0 ? out : undefined;
}

function asEnforcement(v: unknown): Discipline["requireCommit"] | undefined {
  if (v === "off" || v === "soft" || v === "hard") return v;
  return undefined;
}

/**
 * Read and parse `.discipline.yaml` from the workspace root. Returns
 * null when the file does not exist, cannot be read, or is malformed.
 *
 * Never throws — any I/O or parse error is swallowed and null is
 * returned, matching the "best-effort enhancement" contract.
 *
 * When present and valid, the returned Discipline block has
 * {@link Discipline.frozen} = true, signalling to the classifier hook
 * that it should not overwrite these values per-turn (operators who
 * wrote a config expect it to be honoured).
 *
 * Two schemas are accepted:
 *
 * 1. Kevin's A/A/A simple schema (preferred):
 *
 *        mode: "off" | "soft" | "hard"
 *        skipTdd: false
 *
 *    Maps to `{ tdd: mode !== "off" && !skipTdd, git: mode !== "off",
 *    requireCommit: mode, skipTdd }`.
 *
 * 2. Original nested schema (still honoured for operators who pinned
 *    fine-grained patterns):
 *
 *        tdd: { enabled, testPatterns, sourcePatterns, enforcement }
 *        git: { enabled, maxChangesBeforeCommit }
 *
 * When the top-level `mode` key is present it wins over the nested
 * blocks; when absent, the nested blocks apply (back-compat).
 */
export async function loadDisciplineConfig(
  workspaceRoot: string,
): Promise<Discipline | null> {
  const target = path.join(workspaceRoot, DISCIPLINE_CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const root = parsed as Record<string, unknown>;

  const out: Discipline = { ...DEFAULT_DISCIPLINE, frozen: true };

  // --- Simple schema path — `{ mode, skipTdd }` ------------------
  const mode = asEnforcement(root["mode"]);
  if (mode !== undefined) {
    out.requireCommit = mode;
    const skip = asBool(root["skipTdd"]);
    if (skip !== undefined) out.skipTdd = skip;
    if (mode === "off") {
      out.tdd = false;
      out.git = false;
    } else {
      out.git = true;
      out.tdd = out.skipTdd === true ? false : true;
    }
    return out;
  }

  // --- Nested schema path — `{ tdd: {...}, git: {...} }` ---------
  const tddBlock =
    root["tdd"] && typeof root["tdd"] === "object" && !Array.isArray(root["tdd"])
      ? (root["tdd"] as Record<string, unknown>)
      : null;
  const gitBlock =
    root["git"] && typeof root["git"] === "object" && !Array.isArray(root["git"])
      ? (root["git"] as Record<string, unknown>)
      : null;

  if (tddBlock) {
    const enabled = asBool(tddBlock["enabled"]);
    if (enabled !== undefined) out.tdd = enabled;
    const tp = asStringArray(tddBlock["testPatterns"]);
    if (tp) out.testPatterns = tp;
    const sp = asStringArray(tddBlock["sourcePatterns"]);
    if (sp) out.sourcePatterns = sp;
    const enf = asEnforcement(tddBlock["enforcement"]);
    if (enf !== undefined) out.requireCommit = enf;
  }
  if (gitBlock) {
    const enabled = asBool(gitBlock["enabled"]);
    if (enabled !== undefined) out.git = enabled;
    const mc = asNumber(gitBlock["maxChangesBeforeCommit"]);
    if (mc !== undefined && mc > 0) out.maxChangesBeforeCommit = Math.floor(mc);
  }
  return out;
}
