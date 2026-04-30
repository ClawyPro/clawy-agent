import { describe, expect, it } from "vitest";
import { ExecutionContractStore } from "../../execution/ExecutionContract.js";
import {
  makeResourceBoundaryHooks,
  type ResourceBoundaryAgent,
} from "./resourceBoundaryGate.js";
import type { HookContext } from "../types.js";
import type { TranscriptEntry } from "../../storage/Transcript.js";

function ctxWithStore(
  store: ExecutionContractStore,
  transcript: TranscriptEntry[] = [],
  events: unknown[] = [],
): HookContext {
  return {
    botId: "bot",
    userId: "user",
    sessionKey: "session",
    turnId: "turn",
    llm: {} as HookContext["llm"],
    transcript,
    emit: (event) => events.push(event),
    log: () => {},
    agentModel: "gpt-5.4",
    abortSignal: new AbortController().signal,
    deadlineMs: 1000,
    executionContract: store,
  };
}

function storeWithBinding(mode: "audit" | "enforce" = "enforce"): ExecutionContractStore {
  const store = new ExecutionContractStore({ now: () => 1 });
  store.startTurn({
    userMessage: [
      "<task_contract>",
      `<resource_bindings mode="${mode}">`,
      "<allowed_workspace_paths><item>reports/</item></allowed_workspace_paths>",
      "</resource_bindings>",
      "</task_contract>",
    ].join("\n"),
  });
  return store;
}

describe("resourceBoundaryGate", () => {
  it("blocks beforeToolUse outside explicit resource bindings", async () => {
    const store = storeWithBinding();
    const hooks = makeResourceBoundaryHooks();

    const out = await hooks.beforeToolUse.handler(
      { toolName: "FileRead", toolUseId: "tu_1", input: { path: "secrets/a.md" } },
      ctxWithStore(store),
    );

    expect(out).toMatchObject({ action: "block" });
  });

  it("records allowed resource usage beforeToolUse", async () => {
    const store = storeWithBinding();
    const hooks = makeResourceBoundaryHooks();

    await hooks.beforeToolUse.handler(
      { toolName: "FileRead", toolUseId: "tu_1", input: { path: "reports/a.md" } },
      ctxWithStore(store),
    );

    expect(store.snapshot().taskState.usedResources).toEqual([
      expect.objectContaining({
        kind: "workspace_path",
        value: "reports/a.md",
        toolName: "FileRead",
      }),
    ]);
  });

  it("blocks beforeCommit when bypass mode skipped beforeToolUse", async () => {
    const store = storeWithBinding();
    const transcript: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: 1,
        turnId: "turn",
        toolUseId: "tu_1",
        name: "Bash",
        input: { command: "cat secrets/a.md" },
      },
      {
        kind: "tool_result",
        ts: 2,
        turnId: "turn",
        toolUseId: "tu_1",
        status: "ok",
        output: "secret",
        isError: false,
      },
    ];
    const agent: ResourceBoundaryAgent = {
      readSessionTranscript: async () => transcript,
    };
    const hooks = makeResourceBoundaryHooks({ agent });

    const out = await hooks.beforeCommit.handler(
      {
        assistantText: "완료했습니다.",
        toolCallCount: 1,
        toolReadHappened: true,
        userMessage: "작업해줘",
        retryCount: 0,
        filesChanged: [],
      },
      ctxWithStore(store),
    );

    expect(out).toMatchObject({ action: "block" });
  });

  it("audit mode records violations without blocking", async () => {
    const store = storeWithBinding("audit");
    const hooks = makeResourceBoundaryHooks();

    const out = await hooks.beforeToolUse.handler(
      { toolName: "FileRead", toolUseId: "tu_1", input: { path: "secrets/a.md" } },
      ctxWithStore(store),
    );

    expect(out).toEqual({ action: "continue" });
    expect(store.snapshot().taskState.usedResources).toEqual([
      expect.objectContaining({ value: "secrets/a.md" }),
    ]);
  });
});
