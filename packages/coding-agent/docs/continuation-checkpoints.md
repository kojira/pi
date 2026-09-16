# Continuation checkpoints

Every main assistant request uses one work-control lifecycle, with no mode or provider-specific restriction.

## Model decisions

Report progress normally, then keep working. To stop, append a standalone final line outside code fences:

```text
Verification passed.
<done reason="Verification passed"/>
```

The reason is nonempty; encode quotes as `&quot;` and ampersands as `&amp;`. There is no continuation marker. When the ending marker is absent or malformed, the main loop proceeds to its next inference using the existing context. It does not ask for a corrected response, add a synthetic user message, fabricate a continuation tool call, or run another classification model.

The runtime automatically starts a persisted checkpoint. A valid done marker supplies its current ID, the reason and the visible text as summary to the finish operation. If there is no visible text, the reason supplies the summary. Text completion uses outcome `completed`; explicit `finish_work` also supports `cancelled`, `waiting`, and `blocked`. Explicit `continue_work` and `finish_work` tools remain available, independently of allowlists for actual work tools.

## Execution and output

The existing agent loop continues after text-only progress while the contract is active. Queued steering and follow-up messages are consumed at normal boundaries. No previous side effects are replayed.

Main responses are buffered to strip the ending marker before complete-message delivery; incremental main-response deltas are not emitted. Auxiliary summaries bypass the work adapter. Ordinary progress is visible, and no correction-generated restatement is requested.

`finish_work` resolves the checkpoint and terminates its batch. It requires a current checkpoint, outcome, reason and summary. Markers mixed with tool calls and mixed finish batches are rejected before execution. Input accepted after inference began invalidates a stale finish; queued input is processed before another decision.

SDK/RPC consumers receive `work_contract` events with the resolution summary. `agent_settled` means physical idle, not successful completion. Consumers should not deliver the same final text both from `message_end` and the resolution event.

## Interruption and recovery

- Missing markers do not cause format errors or bounded repair attempts. A model that never finishes can keep running until interrupted.
- Quoted/fenced markers do not end work. Output truncation cannot finish and retains existing bounded compaction recovery.
- Abort and provider errors are not implicit completion. Persisted active records restore suspended rather than starting themselves.
- Contract records survive compaction. Tool-result tails retain their associated assistant calls.
- Abort prevents continuation recovery. Terminating tool boundaries defer post-run compaction until new input.
- The model can still choose an incorrect finish. This mechanism does not validate semantic task completion.

See [text work control](text-work-control.md) for the approved design and validation scope.
