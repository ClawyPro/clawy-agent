/**
 * CommitCheckpoint tool — commit roundtrip in a temp git repo.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeCommitCheckpointTool,
  runGit,
  type CommitCheckpointAgent,
} from "./CommitCheckpoint.js";
import type { ToolContext } from "../Tool.js";
import type { Discipline } from "../Session.js";
import type { DisciplineSessionCounter } from "../hooks/builtin/disciplineHook.js";
import { DEFAULT_DISCIPLINE } from "../discipline/config.js";

let tmp: string;

async function makeCtx(workspaceRoot: string): Promise<ToolContext> {
  const audit: Array<{ event: string; data?: Record<string, unknown> }> = [];
  return {
    botId: "bot-test",
    sessionKey: "s-test",
    turnId: "t-test",
    workspaceRoot,
    askUser: async () => ({}),
    emitProgress: () => {},
    abortSignal: new AbortController().signal,
    staging: {
      stageFileWrite: () => {},
      stageTranscriptAppend: () => {},
      stageAuditEvent: (event, data) => audit.push({ event, data }),
    },
  };
}

function makeAgent(discipline: Discipline): {
  agent: CommitCheckpointAgent;
  counter: DisciplineSessionCounter;
} {
  const counter: DisciplineSessionCounter = {
    sourceMutations: 0,
    testMutations: 0,
    dirtyFilesSinceCommit: 5,
  };
  return {
    counter,
    agent: {
      getSessionDiscipline: () => discipline,
      getSessionCounter: () => counter,
    },
  };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "commit-cp-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("CommitCheckpoint", () => {
  it("errors with DISCIPLINE_GIT_OFF when git half is disabled", async () => {
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE, git: false };
    const { agent } = makeAgent(discipline);
    const tool = makeCommitCheckpointTool({ workspaceRoot: tmp, agent });
    const ctx = await makeCtx(tmp);
    const r = await tool.execute({ message: "x" }, ctx);
    expect(r.status).toBe("permission_denied");
    expect(r.errorCode).toBe("DISCIPLINE_GIT_OFF");
  });

  it("errors with GIT_NOT_INITIALIZED when no .git exists", async () => {
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE, git: true };
    const { agent } = makeAgent(discipline);
    const tool = makeCommitCheckpointTool({ workspaceRoot: tmp, agent });
    const ctx = await makeCtx(tmp);
    const r = await tool.execute({ message: "first" }, ctx);
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("GIT_NOT_INITIALIZED");
  });

  it("returns empty when nothing staged", async () => {
    // init fresh repo
    const init = await runGit(tmp, ["init"]);
    expect(init.code).toBe(0);
    // git init leaves the tree clean
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE, git: true };
    const { agent } = makeAgent(discipline);
    const tool = makeCommitCheckpointTool({ workspaceRoot: tmp, agent });
    const ctx = await makeCtx(tmp);
    const r = await tool.execute({ message: "nothing" }, ctx);
    expect(r.status).toBe("empty");
    expect(r.errorCode).toBe("NOTHING_TO_COMMIT");
  });

  it("commits changes and returns sha + file count", async () => {
    const init = await runGit(tmp, ["init"]);
    expect(init.code).toBe(0);
    // Stage a file.
    await fs.writeFile(path.join(tmp, "a.txt"), "hello", "utf8");
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE, git: true };
    const { agent, counter } = makeAgent(discipline);
    const tool = makeCommitCheckpointTool({
      workspaceRoot: tmp,
      agent,
      now: () => 12345,
    });
    const ctx = await makeCtx(tmp);
    const r = await tool.execute({ message: "add a.txt" }, ctx);
    expect(r.status).toBe("ok");
    expect(r.output?.filesChanged).toBe(1);
    expect(r.output?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    // git log confirms the commit is present.
    const log = await runGit(tmp, ["log", "--pretty=%s"]);
    expect(log.stdout.trim()).toBe("add a.txt");
    // counter was reset.
    expect(counter.dirtyFilesSinceCommit).toBe(0);
    expect(counter.lastCommitAt).toBe(12345);
  });

  it("validate() rejects empty / missing message", async () => {
    const discipline: Discipline = { ...DEFAULT_DISCIPLINE, git: true };
    const { agent } = makeAgent(discipline);
    const tool = makeCommitCheckpointTool({ workspaceRoot: tmp, agent });
    expect(tool.validate!({ message: "" } as never)).not.toBeNull();
    expect(
      tool.validate!({ message: "   " } as never),
    ).not.toBeNull();
    expect(tool.validate!({ message: "ok" } as never)).toBeNull();
  });
});
