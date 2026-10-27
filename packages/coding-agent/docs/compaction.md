# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, Pi uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([pi](https://github.com/earendil-works/pi)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@earendil-works/pi-coding-agent/dist/`.

## Overview

Pi has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively. Compaction and branch-summary requests use fresh routing session IDs and, where supported by the provider, disable prompt-cache writes because these one-off prompts are unlikely to be reused.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > contextWindow - reserveTokens
```

By default, `reserveTokens` is 16384 tokens (configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`). This leaves room for the LLM's response.

During a multi-turn agent run, Pi checks this threshold after tools finish and their results are appended, before starting the next assistant response. If the threshold is crossed, Pi compacts inside the same agent run and resumes with the summary and retained messages. It skips this between-turn check when the completed tool batch terminates the run and no queued message requires another response. Pi also checks the threshold before a new user prompt and after a low-level agent run ends.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Bound the fully constructed summary request, including previous summary, instructions and wrappers, to at most 80% of the model's registered context window. A content-aware estimate charges ASCII about 2.5 characters per token and kana/han/Hangul/fullwidth 1.5 tokens per character, so Japanese-heavy or JSON-dense history is not underestimated; the unused fifth of the window absorbs tokenizer drift and request overhead. Use one request if it fits; otherwise split the summary-only text into chronological structural leaves, summarize up to four leaves concurrently, then reduce the largest fitting adjacent groups serially in source order after all leaves validate. Validate every output before using it.
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Rebuilds context**: Session rebuilds the context for the next request, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Pi also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, the previous summary is the oldest source, followed by history and the turn prefix. Fitting input uses one bounded request. Oversized input uses the same structural leaves and adjacent reduction; the retained raw suffix is not counted as new coverage.

### Size bounds and failure boundaries

The built-in native compactor follows [D-COMP-002](D-COMP-002.md). Branch summaries and extension-supplied compaction results retain their existing ownership paths; the direct standalone `generateSummary` APIs are not native compaction jobs.

- Each fully constructed leaf or adjacent-group merge uses the registered model window C: input allowance is min(80% of C, C minus reserved wire output minus safety margin max(4096, 5% of C)). There is no fixed 48k-token/128KB input cap. The caller output allowance is min(floor(0.8 × configured reserve), positive model output limit), matching the native summary reserve policy; fewer than 1024 tokens fails before requests. The prompt targets half that allowance and completes all six sections, without an exhaustive updates/source ledger. Known adapter-added reasoning allowance is reserved separately without changing reasoning policy; unknown reasoning expansion fails preflight.
- Whole messages and assistant/tool-result groups are preferred. Oversized records use paragraphs/newlines, Japanese sentence hints for prose, then code-point-safe measured splits. Each disjoint owned span has source indices, entry IDs when available and UTF-16 offsets. Preceding overlap is labelled context-only and capped at 512 estimated tokens and 2048 bytes; overlap consumes actual input/usage but never new coverage. No Japanese NLP dependency is required.
- Outputs must be complete nonempty six-section plain structured text within the reserve/model-derived summary allowance. Length stops, tool calls, empty, malformed, aborted and oversized responses are rejected, not trimmed into success. Preserve meaningful changes and uncertainty in the relevant sections, not an exhaustive per-source ledger. Input source identities and authority labels remain unchanged.
- The full cumulative file lists remain in native entry `details`. The LLM sees only a bounded recent-reference preview with total/omitted counts (at most 2048 estimated tokens and 8192 bytes, separate from the body allowance; final checkpoint must fit the native next-turn rebuild). Long paths may be omitted, never sliced. SDK `getEntry`/`getEntries` and RPC `get_entries` retrieve full details; there is no implicit model tool for retrieving them. Only an exactly recognized native terminal suffix agreeing with details is removed from a subsequent summary prompt. User-authored and extension-owned lookalikes remain data.
- A fitting whole history uses exactly one request and no final merge. Otherwise use the largest legal structural leaves and combine all validated adjacent children that fit. One job has at most 32 leaves, 31 serial adjacent merges, depth 5, 64 physical attempts including retries, 2,000,000 cumulative estimated input tokens, 524,288 reserved output tokens and an eight-minute deadline including backoff. At most four leaf workers run concurrently, including bounded retry/backoff; merges remain serial. Four concurrent requests can still encounter rate limits; Retry-After and the shared job budgets remain authoritative. Results are stored by chronological leaf index, never completion order. The conservative preflight still charges planned calls a serial 15-second minimum allowance per request; this is an admission heuristic, not a promise of provider latency or an expanded deadline. Shared attempt/input/output budgets are reserved synchronously before every dispatch, including retries. On the first terminal failure or cancellation, stop admitting leaves, abort siblings and settle all workers before returning. Uncooperative provider promises remain observed, but their late results cannot enter reduction or append a checkpoint. The first causal error is preserved rather than replaced by sibling cancellation. These are resource ceilings, not authorization for paid calls. Provider retries are disabled only on these requests; bounded transient retries and Retry-After remain inside the job ceiling. Terminal invalid/auth/billing/quota failures do not trigger fallback. Validated siblings live only in memory during that attempt; no persisted journal or automatic restart/resume is added.
- Native next-turn headroom is checked using an in-memory native context rebuild, current available system/tools, known work-control strings, pending next-turn context, ordinary output allowance and safety margin. An **additional 4096 estimated input-token overhead reserve** covers unobserved dynamic injection; it does not replace either ordinary output reservation or the configured auto-compaction reserve. The estimate must fit below the next auto-compaction threshold too. Arbitrarily large future user messages, stateful extension transforms and opaque stream-wrapper injections are **not** completely previewed or guaranteed; callbacks are never run speculatively.
- A retained raw tail/system/tool schema that cannot fit causes explicit failure, preferably before summary calls. The compactor never moves the kept pointer, drops live results, splits stored messages or changes `keepRecentTokens` to manufacture success. Signal and branch/model/settings identity are checked before native append. Success appends exactly one checkpoint; failure preserves history and installs no partial checkpoint. Existing automatic same-turn failure suppression also covers deterministic size/output failures; new user/model/settings conditions or an explicit successful compact permit retry. When required automatic compaction fails or is suppressed and native context remains unsafe, initial prompt submission and subsequent assistant continuation stop before an ordinary provider request. Initial prompt failure rejects to the caller without appending or replaying the unsubmitted user message; caller intent remains with the caller. The unsafe-context error includes the original compaction failure message and `Error.cause`, including when the same failed preparation is suppressed. Failure diagnostics do not expand the suppression policy. A historical failure alone never blocks currently safe small context. Extension-supplied successful summaries retain their existing ownership path.

The summary planner measures the actual constructed system/prompt/JSON with a content-aware estimate (ASCII/2.5; kana/han/Hangul/fullwidth × 1.5 per code point; other non-ASCII × 1; astral × 2), at least the installed estimator. This is not a provider-exact tokenizer, particularly for Japanese, unusual scripts or opaque adapter wrappers; margin does not make backend size errors impossible. Native next-turn rebuilding remains an estimate, not a new outgoing-request preview authority. Actual cache/auth/reasoning defaults are preserved; resource bounds do not imply price neutrality or a contractual currency ceiling. Where tariff metadata is trustworthy, a conservative uncached estimate is `2 × max(input, cacheWrite, cacheRead) + 0.524288 × output` in per-million-token currency units; unknown upstream/subscription tariffs are not zero merely because model metadata says zero. A separately approved provider/cost cap is required for paid live QC. Offline faux streams establish mechanical bounds and native lifecycle, **not semantic fidelity**; live human acceptance remains a separate gate.

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Pi offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, pi extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Both compaction and branch summarization use the same structured format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant thinking]: Internal reasoning
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

This prevents the model from treating it as a conversation to continue.

Tool results are truncated to 2000 characters during serialization. Content beyond that limit is replaced with a marker indicating how many characters were truncated. This keeps summarization requests within reasonable token budgets, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant thinking]: thinking content
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_compact_failed

Fired when manual or automatic compaction fails or is aborted. This is useful for telemetry extensions that need to pair `session_before_compact` attempts with terminal outcomes.

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact), "threshold", or "overflow"
  // errorMessage - present for non-abort failures
  // aborted - true for cancelled/aborted compactions
  // willRetry - whether the aborted turn would have retried after compaction
  // fromExtension - whether extension-provided compaction content was being used
});
```

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.pi/agent/settings.json` or `<project-dir>/.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `reserveTokens` | `16384` | Tokens to reserve for LLM response |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Disable auto-compaction with `"enabled": false`. You can still compact manually with `/compact`.
