import { describe, it, expect } from "vitest";
import { parseRule, matchesRule, projectToolArgs } from "./ruleMatcher.js";

describe("parseRule", () => {
  it("parses '*' as any", () => {
    const r = parseRule("*");
    expect(r.kind).toBe("any");
  });

  it("parses 'Tool:*' as any", () => {
    const r = parseRule("Tool:*");
    expect(r.kind).toBe("any");
  });

  it("parses bare tool name as tool rule with no arg glob", () => {
    const r = parseRule("Bash");
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.toolName).toBe("Bash");
      expect(r.argGlob).toBeNull();
    }
  });

  it("parses 'Bash()' as tool with no arg glob", () => {
    const r = parseRule("Bash()");
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") expect(r.argGlob).toBeNull();
  });

  it("parses 'Bash(*)' as tool with no arg glob", () => {
    const r = parseRule("Bash(*)");
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") expect(r.argGlob).toBeNull();
  });

  it("parses 'Bash(git *)' as tool + glob", () => {
    const r = parseRule("Bash(git *)");
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.toolName).toBe("Bash");
      expect(r.argGlob).not.toBeNull();
      expect(r.argGlob!.test("git status")).toBe(true);
      expect(r.argGlob!.test("rm -rf /")).toBe(false);
    }
  });

  it("parses 'Read(*.ts)' escaping dot", () => {
    const r = parseRule("Read(*.ts)");
    expect(r.kind).toBe("tool");
    if (r.kind === "tool" && r.argGlob) {
      expect(r.argGlob.test("foo.ts")).toBe(true);
      expect(r.argGlob.test("foo.tsx")).toBe(false);
      expect(r.argGlob.test("fooxts")).toBe(false);
    }
  });

  it("parses camelCase identifier as point rule", () => {
    const r = parseRule("beforeCommit");
    expect(r.kind).toBe("point");
    if (r.kind === "point") expect(r.pointName).toBe("beforeCommit");
  });

  it("treats empty string as malformed (NOT as any)", () => {
    const r = parseRule("");
    expect(r.kind).toBe("malformed");
  });

  it("treats whitespace-only as malformed", () => {
    const r = parseRule("   ");
    expect(r.kind).toBe("malformed");
  });

  it("treats garbage as malformed", () => {
    const r = parseRule("!!invalid!!");
    expect(r.kind).toBe("malformed");
  });

  it("handles non-string input without throwing", () => {
    // @ts-expect-error — intentional type bypass
    const r = parseRule(null);
    expect(r.kind).toBe("malformed");
  });
});

describe("matchesRule — point", () => {
  it("point rule matches exact point name", () => {
    const r = parseRule("beforeCommit");
    expect(matchesRule(r, { point: "beforeCommit" })).toBe(true);
  });

  it("point rule rejects different point", () => {
    const r = parseRule("beforeCommit");
    expect(matchesRule(r, { point: "beforeLLMCall" })).toBe(false);
  });
});

describe("matchesRule — tool", () => {
  it("bare tool rule matches any args", () => {
    const r = parseRule("Bash");
    expect(matchesRule(r, { point: "beforeToolUse", toolName: "Bash" })).toBe(true);
    expect(
      matchesRule(r, {
        point: "beforeToolUse",
        toolName: "Bash",
        toolArgs: { command: "anything" },
      }),
    ).toBe(true);
  });

  it("tool rule rejects different tool", () => {
    const r = parseRule("Bash");
    expect(matchesRule(r, { point: "beforeToolUse", toolName: "FileWrite" })).toBe(false);
  });

  it("tool rule with no toolName in ctx → false", () => {
    const r = parseRule("Bash");
    expect(matchesRule(r, { point: "beforeLLMCall" })).toBe(false);
  });

  it("arg glob matches projected string", () => {
    const r = parseRule("Bash(git *)");
    expect(
      matchesRule(r, {
        point: "beforeToolUse",
        toolName: "Bash",
        toolArgs: { command: "git status" },
      }),
    ).toBe(true);
  });

  it("arg glob rejects non-matching projection", () => {
    const r = parseRule("Bash(git *)");
    expect(
      matchesRule(r, {
        point: "beforeToolUse",
        toolName: "Bash",
        toolArgs: { command: "rm -rf /" },
      }),
    ).toBe(false);
  });

  it("arg glob accepts pre-projected string", () => {
    const r = parseRule("Bash(git *)");
    expect(
      matchesRule(r, {
        point: "beforeToolUse",
        toolName: "Bash",
        toolArgs: "git commit",
      }),
    ).toBe(true);
  });

  it("file_path key projects bare", () => {
    const r = parseRule("FileWrite(*.ts)");
    expect(
      matchesRule(r, {
        point: "beforeToolUse",
        toolName: "FileWrite",
        toolArgs: { file_path: "src/foo.ts" },
      }),
    ).toBe(true);
  });
});

describe("matchesRule — any / malformed", () => {
  it("any always matches", () => {
    const r = parseRule("*");
    expect(matchesRule(r, { point: "whatever" })).toBe(true);
    expect(matchesRule(r, { point: "beforeToolUse", toolName: "X" })).toBe(true);
  });

  it("malformed never matches", () => {
    const r = parseRule("");
    expect(matchesRule(r, { point: "beforeCommit" })).toBe(false);
  });
});

describe("projectToolArgs", () => {
  it("returns string verbatim", () => {
    expect(projectToolArgs("git status")).toBe("git status");
  });

  it("returns empty for null/undefined", () => {
    expect(projectToolArgs(null)).toBe("");
    expect(projectToolArgs(undefined)).toBe("");
  });

  it("projects command bare", () => {
    expect(projectToolArgs({ command: "ls -la" })).toBe("ls -la");
  });

  it("projects object with sorted keys", () => {
    expect(projectToolArgs({ b: "2", a: "1" })).toBe("a=1 b=2");
  });
});
