# Continuation checkpoints

Every main assistant request uses one work-control lifecycle. There is no opt-in mode or provider-specific restriction. The former `--explicit-work-completion` CLI flag and SDK option have been removed.

## Model decisions

A text-only response ends with one standalone structured decision outside code fences:

```text
Progress report.
<work-control>{"action":"continue","nextAction":"Run verification"}</work-control>
```

or:

```text
Verification passed.
<work-control>{"action":"finish","outcome":"completed","reason":"Verification passed"}</work-control>
```

Finish outcomes are `completed`, `cancelled`, `waiting`, or `blocked`. The preceding text supplies the visible summary. Continue requires a concrete, already-authorized next action. The runtime executes the model's decision; it does not classify prose or independently decide whether the work is complete.

The runtime starts a persisted checkpoint automatically when a main request has no active contract. It strips the terminal control and normalizes the decision into `continue_work` or `finish_work`. These side-effect-free lifecycle controls remain available regardless of work-tool allowlists, exclusions, or `noTools`. Restrictions on actual work tools remain enforced. The model may also call these controls explicitly, or use ordinary tools; a footer cannot be mixed with tool calls.

## Execution and output

`continue_work` returns a normal tool result. The existing agent loop then requests the next assistant response from that boundary. There is no synthetic user message, Gateway reinvocation, second model, or replay of previous side effects.

`finish_work` resolves the active checkpoint and terminates its tool batch. It requires the current checkpoint ID, outcome, nonempty reason and summary. A footer supplies the current checkpoint ID internally. Main responses are buffered until normalization, including ordinary tool responses. This deliberately replaces incremental main-response deltas with complete normalized messages so the control suffix is not exposed. Auxiliary summaries are not work turns and bypass this adapter.

Mixed finish batches are rejected before any tool in the batch executes. Input accepted after the request began invalidates its finish decision. A stale finish ends only that batch, allowing the normal loop to consume queued input and reconsider; it does not resolve the contract.

SDK/RPC consumers receive `work_contract` events and can inspect `session.workContract`. A resolved event carries the model's summary without another provider request. `agent_settled` continues to mean physical idle, not successful completion. Print mode outputs the resolution summary or a suspension error.

## Failure and recovery

- Missing or invalid text decisions receive at most two correction turns, then a protocol error, never implicit successful completion.
- Fenced and quoted markers do not resolve work. Truncated output cannot execute a finish decision and retains existing bounded compaction recovery.
- Abort, provider error, disposal and settlement without a finish decision do not claim completion. Persisted active records restore as suspended and do not execute automatically.
- Contract records survive compaction. A tool-result tail retains its associated assistant call when choosing a compaction cut point.
- If in-loop compaction succeeds but the low-level run returns before the expected next response, the existing pending-continuation marker resumes once. Abort prevents this recovery; completed tools are not replayed.
- Terminating tool boundaries defer post-run compaction until new input. Queued input still uses the normal delivery loop.
- The model can still make an incorrect finish decision. This mechanism executes explicit decisions; it is not a semantic correctness guarantee.

## Validation

Tests cover continuation into actual work, first-response finish without configuration, stale input, correction bounds, interruption, restoration, compaction, tool restrictions, history ordering, output projection and provider serialization. See [text work control](text-work-control.md) for revision status.
