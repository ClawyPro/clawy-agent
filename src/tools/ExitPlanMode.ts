/**
 * ExitPlanMode — used by the model to leave plan mode with a final
 * plan artifact. Emits a `plan_ready` AgentEvent, flips the Turn's
 * `planMode` flag off, and returns `{planApproved: true}`.
 *
 * The actual approval UX happens client-side; this tool only signals
 * "I'm done planning, here's the plan." Future work wires a full
 * consent workflow (§7.2 AWAITING_PLAN_APPROVAL state).
 *
 * T2-08 — calling {@link PlanModeController.exitPlanMode} is wired
 * through the Turn instance, which in turn invokes
 * `Session.exitPlanMode()`. That method restores the pre-plan
 * permission posture captured on entry (default / auto / bypass),
 * rather than hard-coding back to `default`. Resolves the plan-vs-
 * permission coupling from DEBT-PLAN-PERMS-01.
 *
 * Design reference: §7.2.
 */

import type { Tool, ToolContext, ToolResult } from "../Tool.js";
import { errorResult } from "../util/toolResult.js";

export interface ExitPlanModeInput {
  plan: string;
}

export interface ExitPlanModeOutput {
  planApproved: true;
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    plan: {
      type: "string",
      minLength: 1,
      description:
        "The final plan text (typically markdown bullets). This will be shown to the user for approval before execute-mode tools are unlocked.",
    },
  },
  required: ["plan"],
} as const;

/**
 * Surface that the ExitPlanMode tool needs to flip the containing
 * Turn's plan-mode state. Kept as a bare interface so we don't have to
 * import Turn here (which would create a cycle with Tool.ts).
 */
export interface PlanModeController {
  /** Returns true if the turn is currently in plan mode. */
  isPlanMode(): boolean;
  /** Turn plan mode off for the rest of this turn. */
  exitPlanMode(): void;
}

export function makeExitPlanModeTool(
  getController: (turnId: string) => PlanModeController | null,
): Tool<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: "ExitPlanMode",
    description:
      "Signal that you are done planning and ready to execute. Pass the final plan text. The runtime emits a `plan_ready` event; the client UI may request user approval before subsequent write/execute tools are unlocked. Only callable while in plan mode.",
    inputSchema: INPUT_SCHEMA,
    permission: "meta",
    validate(input) {
      if (!input || typeof input.plan !== "string" || input.plan.trim().length === 0) {
        return "`plan` is required and must be non-empty";
      }
      return null;
    },
    async execute(
      input: ExitPlanModeInput,
      ctx: ToolContext,
    ): Promise<ToolResult<ExitPlanModeOutput>> {
      const start = Date.now();
      try {
        const controller = getController(ctx.turnId);
        if (!controller) {
          return {
            status: "error",
            errorCode: "no_controller",
            errorMessage: "ExitPlanMode called but no plan-mode controller is registered",
            durationMs: Date.now() - start,
          };
        }
        if (!controller.isPlanMode()) {
          return {
            status: "error",
            errorCode: "not_in_plan_mode",
            errorMessage: "ExitPlanMode called while the turn was not in plan mode",
            durationMs: Date.now() - start,
          };
        }
        ctx.emitAgentEvent?.({
          type: "plan_ready",
          plan: input.plan,
        });
        controller.exitPlanMode();
        return {
          status: "ok",
          output: { planApproved: true },
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return errorResult(err, start);
      }
    },
  };
}
