# Text work control — approved design v4

Every main response uses one lifecycle. The only text control is a standalone final line:

```text
Verification passed.
<done reason="Verification passed"/>
```

The reason must be nonempty. Use `&quot;` for embedded quotes and `&amp;` for ampersands. A marker in a code fence or quotation is literal, not a decision.

Without a valid done marker, Pi continues inference with the existing transcript. There is no continuation marker, JSON control payload, format-correction prompt, synthetic continue tool, synthetic user input, repair counter or repair-limit error. Old work-control markers have no control meaning. Normal progress text remains visible. Auxiliary compaction and branch summaries are not main work turns.

A valid marker is stripped before delivery and normalized to the existing finish operation with its reason, current checkpoint ID and visible text as summary (or the reason when there is no visible text). Explicit work tools remain available. Tool allowlists still restrict actual work tools. Markers mixed with tool calls are rejected before execution.

The low-level agent loop checks whether its owner needs another inference at the text boundary, after queued input, without replaying tools or ending and relaunching the session. Pi always binds this to the active work contract; there is no user-selectable mode. Abort, provider failures, output truncation and existing retry/compaction recovery remain distinct from normal continuation. New input invalidates stale finish decisions.

This does not guarantee correct model judgment: a model may still finish prematurely or continue unnecessarily. If it never finishes, normal continuation has no format-repair cap; the operator can cancel. Main responses remain buffered to hide terminal markers.

Validation targets: consecutive text-only inference without extra messages or tool calls, tools followed by completion, no legacy marker compatibility, literal/malformed markers, reason escaping, stale input, abort, provider errors, compaction and single delivery of the final summary. Deterministic tests must be distinguished from live provider and transport acceptance. No production cutover is part of implementation approval.
