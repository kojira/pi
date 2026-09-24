# Claude Agent SDK structured Pi carrier (experimental)

Opt-in **text-only trial** for a newly started Pi session. It does not change Pi's default model, credentials, or Gateway executable. It is not a drop-in replacement for other models; compaction, resume, images, and mid-session model changes have the restrictions below.

Install this example's pinned dependency with pnpm 11.14.0 (pinned in this directory's `packageManager` and `.mise.toml`; the root project is pinned to the same pnpm 11 version). This directory has its own 7-day `.npmrc` policy. pnpm 11 checks even *frozen lockfile* entries against that policy; CI runs both root and standalone installs. Then load it explicitly:

```sh
cd packages/coding-agent/examples/extensions/claude-sdk-structured
pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts
cd ../../../../..
pi -e ./packages/coding-agent/examples/extensions/claude-sdk-structured/index.ts
```

Select `claude-sdk-structured/claude-opus-5-5` only after logging in to the **unmodified official Claude Code CLI** as the same individual account. The extension reads only the CLI's login status; it does not extract OAuth credentials or fall back to API-key billing. It refuses `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` environment overrides. The displayed zero API cost is **not** free subscription usage; the subscription allowance is still consumed.

SDK tools and ambient settings are disabled. A structured result proposes **one** Pi tool call per turn; Pi's existing dispatcher validates and executes it. A finish/wait decision remains subject to Pi's work contract. An abort, unknown tool, inconsistent result, changed system prompt/tool list/context, image, old session, or exhausted estimated per-query budget fails closed. The resident SDK query is closed on session shutdown. This text-only model does not advertise Pi's thinking-level control; the SDK may reason independently. **Discord selection:** In a newly registered channel with no history, select `claude-sdk-structured/claude-opus-5-5` with `/pi model`, then send a text prompt. For an existing channel, wait until all work and background children have finished; `/pi stop` closes its retained RPC connection, then `/pi new` archives the previous conversation and creates an empty session, then `/pi model` selects Claude. Do **not** stop or reset an active channel; do not silently discard an existing transcript. Gateway launches Pi with `--continue`, so selecting Claude on a non-empty transcript is rejected *before* an SDK request. A mid-session model switch also fails closed.

Pi compaction and branch summaries with this model return an explicit error without destroying the active SDK conversation; switch to a supported model before summarizing. Abort closes the SDK session; use a fresh Pi session to recover. Steer, context mutation, multiple concurrent actions, and images are not yet proven equivalent to the default model. Pi owns tool execution. This text-only model does not advertise Pi's thinking-level control; the SDK may reason independently.

The adapter changes only two Pi documentation instructions in the SDK request while retaining Pi identity and document paths. If those source instructions change, it refuses to run rather than silently dropping them. This is a legitimate prompt presentation adjustment, not a credential or client-identity change.

One isolated five-response Opus 5.5 Pi session succeeded (`read` → four `finish_work` decisions). The second response wrote **54,985** 1-hour cache tokens and read **2,683**; responses 3–5 each read **over 99%** of their input from cache. Cache read exceeded 99% from response three in that one resident session, but subscription allowance consumption is not directly measurable from SDK token usage. For a real channel, expose this model **only as an optional text-only trial**, require a fresh empty Pi session, and retain the existing default and rollback path.

**Safety warning:** SDK `maxTurns: 1` did *not* limit internal model round-trips to one; SDK reported `num_turns: 2` for each Pi response. The five-response probe therefore exceeded a five-round-trip interpretation of the authorized limit. This extension does **not** guarantee a strict model-call budget; its estimated $2/query and 100 Pi-response limits are safety brakes, **not actual charges or subscription limits**. Further provider calls require an explicit testing purpose, not a cache experiment. For normal operation, resolve the documented recovery, compaction, steer, and image limitations first.
