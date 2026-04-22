/**
 * .discipline.yaml loader fixture tests.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCIPLINE,
  DISCIPLINE_CONFIG_FILENAME,
  loadDisciplineConfig,
} from "./config.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "discipline-cfg-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("loadDisciplineConfig", () => {
  it("returns null when file is missing", async () => {
    const r = await loadDisciplineConfig(tmp);
    expect(r).toBeNull();
  });

  it("returns null for malformed YAML", async () => {
    await fs.writeFile(
      path.join(tmp, DISCIPLINE_CONFIG_FILENAME),
      "tdd:\n  enabled: [unterminated",
      "utf8",
    );
    const r = await loadDisciplineConfig(tmp);
    expect(r).toBeNull();
  });

  it("parses a full config and flips defaults where set", async () => {
    const yaml = [
      "tdd:",
      "  enabled: true",
      '  testPatterns: ["**/*.test.ts"]',
      '  sourcePatterns: ["src/**/*.ts"]',
      "  enforcement: hard",
      "git:",
      "  enabled: true",
      "  maxChangesBeforeCommit: 5",
      "",
    ].join("\n");
    await fs.writeFile(path.join(tmp, DISCIPLINE_CONFIG_FILENAME), yaml, "utf8");
    const r = await loadDisciplineConfig(tmp);
    expect(r).not.toBeNull();
    expect(r!.tdd).toBe(true);
    expect(r!.git).toBe(true);
    expect(r!.requireCommit).toBe("hard");
    expect(r!.maxChangesBeforeCommit).toBe(5);
    expect(r!.testPatterns).toEqual(["**/*.test.ts"]);
    expect(r!.sourcePatterns).toEqual(["src/**/*.ts"]);
    expect(r!.frozen).toBe(true);
  });

  it("partial config keeps defaults for unset fields", async () => {
    const yaml = ["tdd:", "  enabled: true", ""].join("\n");
    await fs.writeFile(path.join(tmp, DISCIPLINE_CONFIG_FILENAME), yaml, "utf8");
    const r = await loadDisciplineConfig(tmp);
    expect(r!.tdd).toBe(true);
    expect(r!.git).toBe(DEFAULT_DISCIPLINE.git);
    expect(r!.maxChangesBeforeCommit).toBe(
      DEFAULT_DISCIPLINE.maxChangesBeforeCommit,
    );
    expect(r!.testPatterns).toEqual(DEFAULT_DISCIPLINE.testPatterns);
  });

  it("ignores invalid enforcement value", async () => {
    const yaml = ["tdd:", "  enabled: true", "  enforcement: bogus", ""].join(
      "\n",
    );
    await fs.writeFile(path.join(tmp, DISCIPLINE_CONFIG_FILENAME), yaml, "utf8");
    const r = await loadDisciplineConfig(tmp);
    expect(r!.requireCommit).toBe(DEFAULT_DISCIPLINE.requireCommit);
  });

  it("simple schema `{ mode: hard }` maps to full discipline block", async () => {
    await fs.writeFile(
      path.join(tmp, DISCIPLINE_CONFIG_FILENAME),
      "mode: hard\n",
      "utf8",
    );
    const r = await loadDisciplineConfig(tmp);
    expect(r).not.toBeNull();
    expect(r!.requireCommit).toBe("hard");
    expect(r!.tdd).toBe(true);
    expect(r!.git).toBe(true);
    expect(r!.frozen).toBe(true);
    // Glob patterns still come from the baked-in defaults.
    expect(r!.testPatterns).toEqual(DEFAULT_DISCIPLINE.testPatterns);
  });

  it("simple schema `{ mode: soft, skipTdd: true }` disables tdd", async () => {
    await fs.writeFile(
      path.join(tmp, DISCIPLINE_CONFIG_FILENAME),
      "mode: soft\nskipTdd: true\n",
      "utf8",
    );
    const r = await loadDisciplineConfig(tmp);
    expect(r!.requireCommit).toBe("soft");
    expect(r!.skipTdd).toBe(true);
    expect(r!.tdd).toBe(false);
    expect(r!.git).toBe(true);
  });

  it("simple schema `{ mode: off }` forces everything off", async () => {
    await fs.writeFile(
      path.join(tmp, DISCIPLINE_CONFIG_FILENAME),
      "mode: off\n",
      "utf8",
    );
    const r = await loadDisciplineConfig(tmp);
    expect(r!.requireCommit).toBe("off");
    expect(r!.tdd).toBe(false);
    expect(r!.git).toBe(false);
  });

  it("non-object YAML (list) → null", async () => {
    await fs.writeFile(
      path.join(tmp, DISCIPLINE_CONFIG_FILENAME),
      "- 1\n- 2\n",
      "utf8",
    );
    const r = await loadDisciplineConfig(tmp);
    expect(r).toBeNull();
  });
});
