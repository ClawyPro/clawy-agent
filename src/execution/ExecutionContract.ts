export type VerificationMode = "none" | "sample" | "full";
export type ExecutionControlMode = "light" | "heavy";

export interface ExecutionControlState {
  mode: ExecutionControlMode;
  reason: string;
}

export interface VerificationEvidenceRecord {
  source: "beforeCommit" | "tool" | "hook" | "manual";
  status: "passed" | "failed" | "partial" | "unknown";
  recordedAt: number;
  command?: string;
  detail?: string;
}

export interface ExecutionTaskState {
  goal: string | null;
  constraints: string[];
  currentPlan: string[];
  completedSteps: string[];
  blockers: string[];
  acceptanceCriteria: string[];
  verificationMode: VerificationMode;
  verificationEvidence: VerificationEvidenceRecord[];
  artifacts: string[];
  updatedAt: number;
}

export interface WorkOrder {
  persona: string;
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  allowedTools: string[];
  childPrompt: string;
}

export interface ExecutionContractSnapshot {
  taskState: ExecutionTaskState;
  workOrders: WorkOrder[];
  control: ExecutionControlState;
}

export interface ExecutionContractStoreOptions {
  now?: () => number;
}

const COMPLETION_CLAIM_RE =
  /(?:완료|끝났|반영|구현|처리|해결|고쳤|통과|verified|completed|done|implemented|fixed|resolved|passed)/i;

const TAG_LIST_RE = /<(constraints|acceptance_criteria|current_plan|completed_steps|blockers|artifacts)>\s*([\s\S]*?)\s*<\/\1>/gi;
const ITEM_RE = /<item>\s*([\s\S]*?)\s*<\/item>/gi;
const CONTRACT_TRIGGER_RE = /<task_contract\b|verification_mode|acceptance_criteria|검증\s*모드|수락\s*기준/i;
const CREATE_OR_EXPORT_RE =
  /(?:create|generate|write|draft|render|export|convert|make|build|작성|생성|만들|써줘|문서화|렌더|변환|내보내|저장|docx|hwpx|xlsx|pptx|pdf|html)/i;
const HEAVY_ACTION_RE =
  /(?:create|generate|write|draft|render|export|convert|edit|modify|delete|remove|deploy|push|commit|merge|schedule|background|subagent|spawn|send\s+(?:email|message)|작성|생성|만들|써줘|수정|편집|삭제|배포|커밋|머지|예약|백그라운드|서브에이전트|하위\s*에이전트|전송|이메일|문자|KB에\s*저장|지식\s*베이스에\s*저장)/i;
const SIMPLE_FILE_UNDERSTANDING_RE =
  /(?:(?:파일|문서|파이프라인|pipeline|file|document).{0,40}(?:뭐|무엇|설명|알려|요약|읽어|분석|what|explain|summari[sz]e|read)|(?:뭐|무엇|설명|알려|요약|읽어|what|explain|summari[sz]e|read).{0,40}(?:파일|문서|파이프라인|pipeline|file|document))/i;
const EXISTING_FILE_DELIVERY_RE =
  /(?:(?:여기서|이거|기존|방금|that|this|existing).{0,30}(?:파일로|첨부|다운로드|보내|send|attach|download)|(?:파일로|첨부|다운로드|보내|send|attach|download).{0,30}(?:여기|이거|기존|방금|that|this|existing))/i;
const CONTINUE_RE = /(?:continue|keep going|resume|finish|마저|계속|이어|끝까지|진행)/i;

export class ExecutionContractStore {
  private readonly now: () => number;
  private snapshotValue: ExecutionContractSnapshot;

  constructor(opts: ExecutionContractStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.snapshotValue = {
      taskState: {
        goal: null,
        constraints: [],
        currentPlan: [],
        completedSteps: [],
        blockers: [],
        acceptanceCriteria: [],
        verificationMode: "none",
        verificationEvidence: [],
        artifacts: [],
        updatedAt: this.now(),
      },
      workOrders: [],
      control: {
        mode: "light",
        reason: "initial",
      },
    };
  }

  startTurn(input: { userMessage: string }): void {
    const parsed = parseTaskContract(input.userMessage);
    const goal = firstNonContractLine(input.userMessage);
    const control = classifyExecutionControl(input.userMessage, parsed, this.snapshotValue);
    this.patchTaskState({
      goal: parsed.goal ?? this.snapshotValue.taskState.goal ?? goal,
      constraints: mergeUnique(this.snapshotValue.taskState.constraints, parsed.constraints),
      currentPlan: mergeUnique(this.snapshotValue.taskState.currentPlan, parsed.currentPlan),
      completedSteps: mergeUnique(this.snapshotValue.taskState.completedSteps, parsed.completedSteps),
      blockers: mergeUnique(this.snapshotValue.taskState.blockers, parsed.blockers),
      acceptanceCriteria: mergeUnique(
        this.snapshotValue.taskState.acceptanceCriteria,
        parsed.acceptanceCriteria,
      ),
      artifacts: mergeUnique(this.snapshotValue.taskState.artifacts, parsed.artifacts),
      verificationMode: parsed.verificationMode ?? this.snapshotValue.taskState.verificationMode,
    });
    this.snapshotValue = {
      ...this.snapshotValue,
      control,
    };
  }

  patchTaskState(patch: Partial<Omit<ExecutionTaskState, "updatedAt">>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      taskState: {
        ...this.snapshotValue.taskState,
        ...patch,
        updatedAt: this.now(),
      },
    };
  }

  recordVerificationEvidence(
    evidence: Omit<VerificationEvidenceRecord, "recordedAt">,
  ): void {
    this.patchTaskState({
      verificationEvidence: [
        ...this.snapshotValue.taskState.verificationEvidence,
        { ...evidence, recordedAt: this.now() },
      ],
    });
  }

  recordWorkOrder(order: WorkOrder): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      workOrders: [...this.snapshotValue.workOrders, order],
    };
  }

  snapshot(): ExecutionContractSnapshot {
    return JSON.parse(JSON.stringify(this.snapshotValue)) as ExecutionContractSnapshot;
  }

  renderPromptBlock(): string {
    return renderExecutionContractBlock(this.snapshotValue);
  }
}

export function renderExecutionContractBlock(
  snapshot: ExecutionContractSnapshot,
): string {
  const task = snapshot.taskState;
  const lines = [
    `<execution_contract source="runtime">`,
    `goal: ${task.goal ?? "(unset)"}`,
    `verification_mode: ${task.verificationMode}`,
    renderList("constraints", task.constraints),
    renderList("current_plan", task.currentPlan),
    renderList("completed_steps", task.completedSteps),
    renderList("blockers", task.blockers),
    renderList("acceptance_criteria", task.acceptanceCriteria),
    renderList(
      "verification_evidence",
      task.verificationEvidence.map((e) =>
        [e.status, e.command, e.detail].filter(Boolean).join(" | "),
      ),
    ),
    renderList("artifacts", task.artifacts),
    `</execution_contract>`,
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

export function completionClaimNeedsContractVerification(
  snapshot: ExecutionContractSnapshot,
  assistantText: string,
): boolean {
  if (snapshot.control.mode !== "heavy") return false;
  const task = snapshot.taskState;
  if (task.acceptanceCriteria.length === 0 && task.verificationMode !== "full") {
    return false;
  }
  if (!COMPLETION_CLAIM_RE.test(assistantText)) return false;
  return !task.verificationEvidence.some((e) => e.status === "passed");
}

export function shouldInjectExecutionContract(
  snapshot: ExecutionContractSnapshot,
): boolean {
  return snapshot.control.mode === "heavy";
}

export function classifyExecutionControl(
  userText: string,
  parsed: Partial<Omit<ExecutionTaskState, "updatedAt">> = {},
  current?: ExecutionContractSnapshot,
): ExecutionControlState {
  const text = normalizeWhitespace(userText);
  if (!text) return { mode: "light", reason: "empty" };

  if (CONTRACT_TRIGGER_RE.test(userText)) {
    return { mode: "heavy", reason: "explicit_contract" };
  }
  if (parsed.verificationMode === "full" || parsed.acceptanceCriteria?.length) {
    return { mode: "heavy", reason: "explicit_acceptance_or_full_verification" };
  }
  if (HEAVY_ACTION_RE.test(text)) {
    return { mode: "heavy", reason: "state_changing_or_risky_action" };
  }
  if (CONTINUE_RE.test(text) && hasActiveHeavyContract(current)) {
    return { mode: "heavy", reason: "continue_active_contract" };
  }
  if (SIMPLE_FILE_UNDERSTANDING_RE.test(text)) {
    return { mode: "light", reason: "simple_file_understanding" };
  }
  if (EXISTING_FILE_DELIVERY_RE.test(text) && !CREATE_OR_EXPORT_RE.test(text)) {
    return { mode: "light", reason: "deliver_existing_file" };
  }
  return { mode: "light", reason: "default" };
}

export function buildSpawnWorkOrderPrompt(input: {
  parent: ExecutionContractSnapshot;
  childPrompt: string;
  persona: string;
  allowedTools?: string[];
}): string {
  const task = input.parent.taskState;
  const order: WorkOrder = {
    persona: input.persona,
    goal: task.goal ?? input.childPrompt,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    allowedTools: input.allowedTools ?? [],
    childPrompt: input.childPrompt,
  };

  return [
    "<work_order>",
    `persona: ${order.persona}`,
    `parent_goal: ${order.goal}`,
    renderList("constraints", order.constraints),
    "<acceptance_criteria>",
    ...order.acceptanceCriteria.map((value) => `<item>${value}</item>`),
    "</acceptance_criteria>",
    renderList("allowed_tools", order.allowedTools),
    "rules:",
    "- Do not modify files outside your assigned scope.",
    "- Return the evidence needed to judge the acceptance criteria.",
    "- Report blockers explicitly instead of silently skipping them.",
    "</work_order>",
    "",
    input.childPrompt,
  ].join("\n");
}

function parseTaskContract(text: string): Partial<Omit<ExecutionTaskState, "updatedAt">> {
  const out: Partial<Omit<ExecutionTaskState, "updatedAt">> = {};
  const goal = text.match(/<goal>\s*([\s\S]*?)\s*<\/goal>/i)?.[1]?.trim();
  if (goal) out.goal = normalizeWhitespace(goal);

  const verificationMode =
    text.match(/<verification_mode>\s*([^<\s]+)\s*<\/verification_mode>/i)?.[1] ??
    text.match(/verification_mode\s*[:=]\s*["']?([a-z]+)/i)?.[1];
  if (verificationMode) {
    const normalized = verificationMode.toLowerCase();
    if (normalized === "full" || normalized === "sample" || normalized === "none") {
      out.verificationMode = normalized;
    }
  }

  for (const match of text.matchAll(TAG_LIST_RE)) {
    const tag = match[1];
    const values = extractItems(match[2] ?? "");
    if (values.length === 0) continue;
    if (tag === "constraints") out.constraints = values;
    if (tag === "acceptance_criteria") out.acceptanceCriteria = values;
    if (tag === "current_plan") out.currentPlan = values;
    if (tag === "completed_steps") out.completedSteps = values;
    if (tag === "blockers") out.blockers = values;
    if (tag === "artifacts") out.artifacts = values;
  }
  return out;
}

function extractItems(raw: string): string[] {
  const items = [...raw.matchAll(ITEM_RE)]
    .map((match) => normalizeWhitespace(match[1] ?? ""))
    .filter((item) => item.length > 0);
  if (items.length > 0) return items;
  return raw
    .split("\n")
    .map((line) => normalizeWhitespace(line.replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")))
    .filter((line) => line.length > 0);
}

function firstNonContractLine(text: string): string | null {
  const stripped = text.replace(/<task_contract>[\s\S]*?<\/task_contract>/gi, "");
  const first = stripped
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0);
  return first ?? null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mergeUnique(existing: string[], next?: string[]): string[] {
  if (!next || next.length === 0) return existing;
  return [...new Set([...existing, ...next])];
}

function hasActiveHeavyContract(snapshot?: ExecutionContractSnapshot): boolean {
  if (!snapshot) return false;
  return (
    snapshot.control.mode === "heavy" ||
    snapshot.taskState.verificationMode === "full" ||
    snapshot.taskState.acceptanceCriteria.length > 0
  );
}

function renderList(label: string, values: string[]): string {
  if (values.length === 0) return `${label}: []`;
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join("\n");
}
