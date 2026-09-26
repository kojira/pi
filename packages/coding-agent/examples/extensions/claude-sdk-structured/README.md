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

SDK built-in tools and ambient settings sources are disabled. An in-process, side-effect-free `propose_pi_tool` SDK MCP tool transports an **object** with the Pi tool name and arguments. The carrier intercepts its native `tool_use` block, validates the proposal against Pi's current tool names, closes the SDK query before it can continue, and hands the call to Pi's existing dispatcher for validation and execution. There is no nested `args_json` string for the model to escape or parse, and no SDK tool result is treated as proof that a Pi tool ran. A tool mixed with final text, an unknown tool, or non-object arguments is rejected without execution. Ordinary text and compaction summaries use a final-only structured response. Past Pi tool calls and results are conversation history, **not executed again**. Pi owns the work contract and JSONL. Image inputs and image tool results within the active Pi context are sent to the SDK; unsupported image formats return an error. Pi thinking `off` disables SDK thinking; supported levels use adaptive thinking and matching effort. A failed or aborted provider request does not invalidate Pi's saved history; the next request starts from the context Pi supplies. Model usage from an intercepted SDK tool message may not include the SDK's final result-level cost totals; displayed zero API cost does not imply free subscription usage.

For a Gateway-managed `ch_<Discord channel ID>` session, the SDK input identifies that channel and the existing `piscord send --channel ... --file ...` CLI. When the user requests an attachment, Opus can propose Pi's `bash` tool to invoke it; Pi remains the executor. Check the CLI result before claiming delivery. Standalone/non-channel sessions receive no channel hint.

Pi compaction and branch summaries use the same SDK provider with Pi's summarization prompt and return the summary as ordinary assistant text. Pi alone saves the resulting compaction entry; a failed summary does not replace the existing Pi history. Steer and multiple concurrent actions have not been proven equivalent to the default model. Pi's default documentation wording is defined once in `src/core/system-prompt.ts` for all models. This extension forwards Pi's system prompt unchanged, including custom child-agent prompts. No SDK `maxTurns` or estimated USD trial cap is imposed; the official account's own usage limits still apply.
