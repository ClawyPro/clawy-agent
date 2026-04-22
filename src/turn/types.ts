/**
 * Turn-scope types. Extracted from Turn.ts (R3 refactor) so Turn.ts
 * stays at coordinator scope.
 */

import type { TokenUsage } from "../util/types.js";

export type TurnRoute = "direct" | "subagent" | "pipeline";

export type TurnStatus =
  | "pending"
  | "planning"
  | "executing"
  | "verifying"
  | "committing"
  | "committed"
  | "aborted";

export interface TurnMeta {
  turnId: string;
  sessionKey: string;
  startedAt: number;
  endedAt?: number;
  declaredRoute: TurnRoute;
  status: TurnStatus;
  usage: TokenUsage;
}

export interface PlanResult {
  plan: string;
  estimatedSteps: number;
  needsApproval: boolean;
}

export interface VerificationReport {
  ok: boolean;
  violations: string[];
}

export interface TurnResult {
  meta: TurnMeta;
  assistantText: string;
}
