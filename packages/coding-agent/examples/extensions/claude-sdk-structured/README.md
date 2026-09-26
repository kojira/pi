# Claude Agent SDK structured Pi carrier (experimental)

Opt-in model `claude-sdk-structured/claude-opus-5-5`. It does not change Pi's default model, credentials, or Gateway executable. **Pi's session history is the only conversation state.** Every provider request converts the `Context` supplied by Pi (including earlier assistant messages and Pi tool results) into a new SDK request. This supports an existing Pi session and model switching without creating or resetting a Pi session. It does not use SDK resume IDs, SDK persisted sessions, or Pi assistant response IDs as SDK checkpoints. Sending the full active Pi context each request may consume more subscription allowance than the previous SDK-resident implementation.

Install this example's pinned dependency with pnpm 11.14.0 (also pinned in this directory's `packageManager` and `.mise.toml`):

```sh
cd packages/coding-agent/examples/extensions/claude-sdk-structured
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
cd ../../../../..
pi -e ./packages/coding-agent/examples/extensions/claude-sdk-structured/index.ts
```

Select the model only after signing in to the **unmodified official Claude Code CLI** as the same individual account. The extension checks the CLI login status; it does not extract OAuth credentials or fall back to API-key billing. It refuses `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` overrides. Displayed zero API cost is **not** free subscription usage.

SDK tools and ambient settings are disabled. A structured result proposes one Pi tool call or text response; Pi's existing dispatcher validates and executes new tool calls. Past tool calls and results in Pi's context are passed as conversation history, **not executed again**. Pi owns the work contract and session JSONL. Image inputs and image tool results within the active Pi context are sent to the SDK; unsupported image formats return an error. Pi thinking `off` disables SDK thinking; supported levels use adaptive thinking and matching effort. A failed or aborted provider request does not invalidate Pi's saved history; the next request starts from the context Pi supplies.

For a Gateway-managed `ch_<Discord channel ID>` session, the SDK input identifies that channel and the existing `piscord send --channel ... --file ...` CLI. When the user requests an attachment, Opus can propose Pi's `bash` tool to invoke it; Pi remains the executor. Check the CLI result before claiming delivery. Standalone/non-channel sessions receive no channel hint.

Pi compaction and branch summaries use the same SDK provider with Pi's summarization prompt and return the summary as ordinary assistant text. Pi alone saves the resulting compaction entry; a failed summary does not replace the existing Pi history. Steer and multiple concurrent actions have not been proven equivalent to the default model. The adapter changes two known Pi documentation phrases when present, while retaining Pi identity and document paths. Custom child prompts without those phrases pass through unchanged. No SDK `maxTurns` or estimated USD trial cap is imposed; the official account's own usage limits still apply.
