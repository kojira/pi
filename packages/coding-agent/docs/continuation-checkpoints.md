# Continuation checkpoints

## Status

Implemented on `feature/tracked-task-continuation` as an opt-in built-in tool. The design intentionally leaves `agent_settled` semantics unchanged.

## Problem

Pi ends an agent run when an assistant response has no tool calls and no queued steering or follow-up messages. This is correct for an ordinary final response, but models sometimes use the final assistant response for an intermediate progress report:

```text
The merge is complete. Next I will run the deployment check.
```

If that response contains no tool call, the low-level loop emits `agent_end` and `AgentSession` eventually emits `agent_settled`. An RPC host such as a chat gateway cannot reliably distinguish this mistake from a real final answer.

A three-minute external heartbeat can recover the work, but repeatedly starts new host invocations, adds user messages to the transcript, and delays the next action.

## Constraints

- Do not classify natural-language phrases such as “next I will” or “done”.
- Do not redefine `agent_settled`; it means no automatic retry, compaction retry, tool continuation, or queued message remains.
- Do not continue directly from an assistant-tailed transcript. Providers require a user or tool-result continuation point, and `Agent.continue()` rejects an assistant tail deliberately.
- Do not replay or remove the last assistant response because its preceding tool calls may have side effects.
- Do not inject a generic user message such as “continue”; it can be wrong when the model is complete or waiting for a decision.
- Preserve normal one-shot behavior when the feature is not enabled.

## Decision

Add an opt-in, non-terminating built-in tool named `continue_work`.

The model calls it in the same assistant response as an intermediate progress report and supplies the concrete next action it has already chosen. The tool records that action in its tool result and does not terminate the tool loop. The existing agent loop therefore performs another provider request from a valid tool-result boundary.

Trace:

```text
assistant: progress text + continue_work({ nextAction })
  -> toolResult: continuation checkpoint
  -> ordinary agent tool loop requests the next assistant turn
  -> assistant performs nextAction
```

No synthetic user message is added. No host or gateway decides whether the task is complete. `agent_settled` is emitted only after a later assistant response has neither a tool call nor a queued continuation.

## Model contract

When `continue_work` is active, its prompt metadata instructs the model to:

1. call it only when the current text is an intermediate progress update;
2. provide a concrete, already-authorized `nextAction`;
3. perform that action after the checkpoint result rather than emitting another progress-only response;
4. avoid the tool when work is complete, blocked, cancelled, or waiting for user input.

The tool is opt-in because adding an autonomous continuation mechanism to every coding session would change established completion behavior. Enable it with `--tools`, the SDK `tools` option, or `defaultTools` in settings.

Example project setting:

```json
{
  "defaultTools": ["read", "bash", "edit", "write", "continue_work"]
}
```

## Safety and failure behavior

- The tool has no external side effects.
- A checkpoint is one normal tool call, so abort, compaction, steering, and session persistence use existing code paths.
- The tool does not enqueue a follow-up; doing both would duplicate continuation.
- The tool is not a completion claim and cannot suppress a legitimate final response.
- If a model ignores the contract and emits progress-only prose without the tool, Pi still settles. Preventing that without a structured model signal would require prose inference or mandatory explicit-completion mode. Both are separate, larger policy changes.
- Repeated `continue_work` calls are visible in the transcript and remain abortable. The prompt contract prohibits checkpoint-only loops; hosts may additionally apply existing turn or usage budgets.

## Alternatives rejected

### Gateway reinvocation

A gateway lacks authoritative task state. Reinvocation also requires adding a new user message and makes completion policy host-specific.

### Continue from an assistant tail

Provider message ordering does not offer a portable continuation point after a completed assistant message. Replaying the last turn can duplicate tool side effects.

### Natural-language detection

Phrase matching is language-dependent and confuses plans, quotations, explanations, completion summaries, and genuine requests for user input.

### Redefining `agent_settled`

RPC waiters and shutdown logic rely on settlement as physical session idleness. Logical task completion is a different concept.

### Mandatory task-state tools

Forcing every response through complete/wait/progress tools can provide a stronger tracked-task contract, but requires provider-neutral required-tool-choice support, terminal-state persistence, budgets, and a suspension lifecycle. This checkpoint tool is the minimal provider-portable mechanism for the reported failure mode.

## Validation

Tests cover:

- schema and neutral checkpoint result;
- non-terminating behavior;
- registration in the built-in tool catalog;
- prompt metadata describing when to continue and when to stop;
- preservation of the existing default active tool set.
