# Core-Agent Execution Discipline Coverage Map

## Covered In This PR

| Invariant | Runtime owner | Behavior |
| --- | --- | --- |
| Completion claim without same-turn evidence | `builtin:completion-evidence-gate` | Blocks once, then fail-open with warning |
| Completion claim with unmet criteria | `builtin:execution-contract-verifier` | Blocks while required criteria are `pending` or `failed` |
| Explicit resource/source mismatch | `builtin:resource-boundary` | Blocks tool use when bindings are in `enforce` mode |
| Bypass skipped `beforeToolUse` | `builtin:resource-boundary-before-commit` | Re-scans current-turn transcript before commit |
| Used-resource provenance | `ExecutionContractStore` | Records resource kind, value, tool name, and tool use id |
| Child work-order dilution | `buildSpawnWorkOrderPrompt()` | Propagates structured criteria and resource bindings into child prompts |

## Existing Coverage

| Invariant | Runtime owner | Behavior |
| --- | --- | --- |
| Unread file content claim | `builtin:resource-existence-checker` | Blocks content claims without current-turn read evidence |
| Undelivered generated artifact | `builtin:artifact-delivery-gate` and `builtin:output-delivery-gate` | Blocks final answer until delivery path is completed or risk is explicit |
| Internal reasoning/tool leak | `builtin:output-purity-gate` | Blocks leaked internal markers |
| Provider degraded but used | `builtin:provider-health-verifier` | Raises verification pressure from provider health metadata |
| Simple read/explain over-control | `ExecutionContractStore.classifyExecutionControl()` | Keeps simple file understanding and existing-file delivery on light mode |

## Remaining Follow-Ups

| Gap | Planned layer |
| --- | --- |
| Iteration node pass/reject loop | P1 task graph |
| Child `writeSet` enforcement | P1 child scope verifier |
| Child final text verification | P1 child result verifier |
| Structured Current Run trace | P2 observability |
| `strict` / `regulated` policy modes | P2 policy mode |

## Fail-Open / Fail-Closed Policy

- Resource-boundary `audit` mode records provenance and emits `rule_check`, but does not block.
- Resource-boundary `enforce` mode blocks on the first attempt and fails open after retry exhaustion to avoid dead-ending the turn.
- Execution criteria block only completion claims in heavy mode. Light read/explain turns are intentionally not blocked by old criteria state.
- Transcript read failure in beforeCommit gates falls back to `ctx.transcript` or fail-open, matching the existing anti-hallucination hook pattern.
