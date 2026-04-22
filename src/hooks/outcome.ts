/**
 * HookOutcome — discriminated union describing the result of running a
 * single registered hook under timeout + error guards. Introduced by
 * R6 so HookRegistry.runPre / runPost can share the per-hook execution
 * path instead of each re-implementing the timeout / error-swallow /
 * logging pattern.
 *
 * The four kinds map 1:1 to the four terminal states of a guarded
 * hook invocation:
 *
 *   ok      — handler returned (with an optional HookResult or void)
 *   timeout — handler exceeded its deadlineMs / hook.timeoutMs
 *   error   — handler threw (or rejected) with a non-timeout error
 *   skipped — handler was not run (applicable guard returned false,
 *             or an inline pre-condition decided to bypass it)
 *
 * Callers interpret each kind according to the hook's fail-open vs.
 * fail-closed policy; the helper itself stays policy-agnostic.
 */
import type { HookArgs, HookPoint, HookResult } from "./types.js";

export type HookOutcome<Point extends HookPoint = HookPoint> =
  | { kind: "ok"; result: HookResult<HookArgs[Point]> | void }
  | { kind: "timeout"; hookName: string; ms: number }
  | { kind: "error"; hookName: string; error: unknown }
  | { kind: "skipped"; hookName: string; reason: string };
