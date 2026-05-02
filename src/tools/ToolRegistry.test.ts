import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "./ToolRegistry.js";

async function writePromptSkill(
  skillsDir: string,
  name: string,
  body = "# Body\n",
): Promise<void> {
  const dir = path.join(skillsDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Use this skill to ${name.replace(/-/g, " ")}.`,
      "kind: prompt",
      "---",
      "",
      body,
    ].join("\n"),
    "utf8",
  );
}

describe("ToolRegistry skill reload", () => {
  let workspaceRoot: string;
  let skillsDir: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tool-registry-"));
    skillsDir = path.join(workspaceRoot, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("removes stale skill tools before loading the current workspace skills", async () => {
    const registry = new ToolRegistry();
    await writePromptSkill(skillsDir, "custom-old");
    await registry.loadSkills(skillsDir, workspaceRoot);

    expect(registry.resolve("custom-old")).not.toBeNull();

    await fs.rm(path.join(skillsDir, "custom-old"), { recursive: true, force: true });
    await writePromptSkill(skillsDir, "custom-new");
    await registry.loadSkills(skillsDir, workspaceRoot);

    expect(registry.resolve("custom-old")).toBeNull();
    expect(registry.resolve("custom-new")).not.toBeNull();
  });
});
