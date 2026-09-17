# Explicit work control — approved design

Every main response uses one lifecycle. Only an explicit `finish_work` tool call ends work. Its current checkpoint ID, outcome, nonempty reason and summary are required. The final answer belongs only in `finish_work.summary`, not accompanying assistant text. When user input is required, `wait_for_user` records the complete question, pauses the checkpoint, and stops the current run until new user input arrives.

Ordinary text responses continue inference with the existing transcript. There is no text ending marker, continuation marker, format-correction prompt, synthetic finish/continue tool call, synthetic user input, repair counter or repair-limit error. Former XML and plain-text markers are ordinary text with no control meaning. Normal progress text remains visible. `continue_work` remains available for explicit checkpoints but is not required for progress.

The runtime supplies the current checkpoint ID and validates explicit finish and wait decisions before durably committing them. Tool allowlists still restrict actual work tools. Mixed decision batches are rejected before execution. New input invalidates stale finish or wait decisions.

Main responses remain buffered: if a normal response contains a `finish_work` or `wait_for_user` call, accompanying assistant text is omitted before public events and transcript insertion, preserving the call and its arguments. This prevents delivery of that response's text followed by its finish summary or waiting question. No semantic deduplication is performed against earlier progress responses. Consumers deliver the resolution summary once. Auxiliary compaction and branch summaries bypass the main-response adapter.

The low-level agent loop checks whether its owner needs another inference at the text boundary, after queued input, without replaying tools or ending and relaunching the session. Pi binds this to the active work contract; there is no user-selectable mode. Abort, provider failures, output truncation and existing retry/compaction recovery remain distinct from normal continuation.

This does not guarantee correct model judgment: a model may still finish prematurely or continue unnecessarily. If it never finishes, normal continuation has no repair cap; the operator can cancel.

Validation targets: ordinary text continuation without extra messages or tool calls, explicit finish, explicit wait without another inference, resume on new user input, former markers not ending work, summary/question-only delivery, stale input, abort, provider errors and auxiliary summary isolation. Deterministic tests, live provider tests and transport acceptance are separate evidence. No production cutover is part of implementation approval.
