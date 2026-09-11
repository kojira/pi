# Continuation checkpoints

This page distinguishes the portable checkpoint-only tool from the opt-in explicit-completion mode below.

## Explicit-completion mode

Enable with `--explicit-work-completion` or SDK `explicitWorkCompletion: true`. Only the `openai-codex-responses` API is currently accepted. When using a tool allowlist, include both `continue_work` and `finish_work`; exclusions are not bypassed.

A successful `continue_work` creates a persisted active contract and returns its checkpoint ID. Active requests enforce `tool_choice: "required"` after request extensions have run. Ordinary work tools and user comments do not clear the contract. To resolve it, the model calls `finish_work` alone with `checkpointId`, `outcome` (`completed`, `cancelled`, `waiting`, or `blocked`), `reason`, and `summary`.

Mixed finish batches are rejected before any tool in the batch executes. Input accepted after the request began invalidates its finish decision. A stale finish ends only that tool batch, allowing the existing loop to consume queued follow-up input and reconsider the decision; it does not resolve the contract or inject a user message.

A text-only provider response during active work is a protocol error and suspends the contract. Abort, disposal, and settlement without a finish decision do not mean completion. Active persisted records restore as suspended and are never automatically executed. Contract records survive transcript compaction.

SDK/RPC consumers receive `work_contract` events and can inspect `session.workContract`. A resolved event carries the model's final summary, without another provider request. `agent_settled` still means physical idle. Print mode outputs the resolution summary or a suspension error. The gateway uses the resolution summary as the final response.

The remaining sections describe checkpoint-only mode, which remains unchanged unless explicit-completion mode is enabled.

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

## Recovery after in-loop compaction

A non-terminating tool result normally causes the low-level loop to prepare and request the next assistant response. Automatic threshold compaction can run during that preparation. If the low-level run then returns without starting the expected assistant response, the compacted session is left at a valid tool-result boundary but would otherwise settle.

`AgentSession` records a pending continuation only when threshold compaction succeeds inside this pre-response preparation path. Starting any assistant response clears the marker. If the low-level run ends while the marker remains, the existing post-run loop calls `Agent.continue()` once.

This recovery is based on lifecycle events, not prose. Explicitly terminating tool batches and host `shouldStopAfterTurn` decisions never enter pre-response preparation, so they do not create the marker. The marker retains the low-level run signal, so direct agent aborts as well as session abort and disposal prevent recovery. The recovery adds no message, does not replay the completed tool, and delays `agent_settled` until the resumed run physically becomes idle.

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

### Mandatory task-state tools for all sessions

Explicit-completion mode provides a stronger contract for supported APIs, but remains opt-in. The checkpoint-only tool remains the provider-portable alternative; it does not guarantee explicit termination.

## Validation

Tests cover:

- schema validation and the neutral checkpoint result;
- a complete offline provider loop through the checkpoint to a final response;
- tool-result persistence without a synthetic user message;
- one final `agent_settled` event after continuation;
- registration in the built-in tool catalog and public package entry point;
- prompt metadata describing when to continue and when to stop;
- preservation of the existing default active tool set.
