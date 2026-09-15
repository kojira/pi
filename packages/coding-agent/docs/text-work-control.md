## What happened?

Explicit work completion forces tool calls and suspends active work on a text-only response. A progress report therefore cannot itself select another model turn.

## Steps to reproduce

Enable explicit work completion, create a checkpoint, then return a text-only progress report. The runtime marks it as a protocol error and suspends the contract. This behavior is in core, independently of extensions.

## Expected behavior / design v3

Support a terminal `<work-control>` JSON line as an alternative representation of existing work-control operations:

- `{"action":"continue","nextAction":"Run the focused tests"}`
- `{"action":"finish","outcome":"completed","reason":"Tests passed"}`

Normalize the explicit model decision into the existing checkpoint/finish lifecycle before output delivery. The preceding visible text is the finish summary. Require nonempty nextAction/reason and a valid outcome; do not infer task completion from prose. Keep stale-input protection, abort/error semantics and single-owner continuation. Tool allowlists constrain work tools; the two runtime-owned lifecycle controls remain available even when work tools are disabled. No extra classifier model, Gateway reinvocation, synthetic user message or tool replay.

Use this single lifecycle for every main assistant response, starting a checkpoint automatically at the first request. Remove the CLI/SDK opt-in and provider-specific restriction; there is no legacy prose-ends-work mode. Buffer main assistant responses until normalization, so terminal control bytes do not leak through streaming events. Auxiliary summaries are not work turns and remain unchanged. Text-only active responses missing a valid footer get two protocol-correction turns via the existing checkpoint mechanism, then an explicit suspension error (not successful completion). Valid tool calls remain supported; footer decisions mixed with tool calls are rejected rather than ambiguously executed.

Validation: offline full loop (text continue -> work -> text finish), first-response completion without configuration, provider transcript serialization, hidden footer in events/output, missing/invalid/fenced/truncated controls, input racing finish, abort, compaction and restoration. Truncated output retains its interruption status and existing bounded compaction recovery; it cannot execute a finish decision. Terminating tool boundaries defer compaction until the next input. PR and reviews only; no merge or deployment.

Local validation of this revision passes: 2,219 coding-agent tests (50 skipped), including queue, compaction, event ordering, interruption and output projection; static checks also pass. Earlier successful CI covered the opt-in implementation, not this revision. Fresh CI and final review are still required.

## Design self-review

Using a structured payload avoids falsely mapping every stop to successful completion and preserves a concrete nextAction. Existing tool-result boundaries avoid a new low-level loop or replaying completed side effects. Generated function calls omit provider-owned item IDs; serialization must verify matching call/result IDs. Buffering is an explicit latency and streaming-API tradeoff for main responses, not a selectable mode. Independent review has not been performed.

AI-generated.
