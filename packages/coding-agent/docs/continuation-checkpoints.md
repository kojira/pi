# Continuation checkpoints

Every main assistant request uses one work-control lifecycle, with no mode or provider-specific restriction.

## Model decisions

Report progress normally, then keep working. To end work, call `finish_work` with the current checkpoint ID, outcome (`completed`, `cancelled`, `waiting`, or `blocked`), nonempty reason and summary. Put the final answer only in the summary, without accompanying assistant text.

Text responses do not end work. The main loop proceeds to its next inference using the existing context. It does not ask for a corrected response, add a synthetic user message, fabricate a continuation tool call, or run another classification model. No text ending or continuation marker exists; former markers have no control meaning.

The runtime automatically starts a persisted checkpoint and supplies its ID. Explicit `continue_work` remains available when a tool-result checkpoint is useful, but is not required for ordinary progress. Work-control tools remain available independently of allowlists for actual work tools.

## Execution and output

The existing agent loop continues after text-only progress while the contract is active. Queued steering and follow-up messages are consumed at normal boundaries. No previous side effects are replayed.

Main responses are buffered so accompanying text on a `finish_work` response is omitted before public delivery and transcript insertion. The final answer is delivered from the resolution summary alone. Incremental main-response deltas are not emitted. Ordinary progress remains visible; earlier responses are not semantically deduplicated. Auxiliary summaries bypass the main work adapter.

`finish_work` resolves the checkpoint and terminates its batch. Mixed finish batches are rejected before execution. Input accepted after inference began invalidates a stale finish; queued input is processed before another decision.

SDK/RPC consumers receive `work_contract` events with the resolution summary. `agent_settled` means physical idle, not successful completion. Consumers should deliver the resolution summary once, rather than also rendering a finish tool result as another answer.

## Interruption and recovery

- A model that never calls `finish_work` can keep running until interrupted; there is no bounded format repair.
- Output truncation cannot finish and retains existing bounded compaction recovery.
- Abort and provider errors are not implicit completion. Persisted active records restore suspended rather than starting themselves.
- Contract records survive compaction. Tool-result tails retain their associated assistant calls.
- Abort prevents continuation recovery. Terminating tool boundaries defer post-run compaction until new input.
- The model can still choose an incorrect finish. This mechanism does not validate semantic task completion.

See [explicit work control](text-work-control.md) for the approved design and validation scope.
