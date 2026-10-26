# D-COMP-002 — Size-bounded chronological compaction

Status: approved for source implementation, offline validation and PR/CI only.
Base: `475a5ceda5e6078bf5ee9a815e6e1a77cbc2e269`.

The bounded parallel leaf amendment below supersedes C5's serial leaf execution.
All resource ceilings and the eight-minute absolute deadline remain unchanged.

## Problem and visible outcome

An incorrect context-window registration is a separate configuration defect; a registered 200k window is not evidence of a model's intrinsic capacity. This design does not correct model metadata or establish backend/account entitlement. For a genuinely smaller registered window, an older large conversation can exceed the available one-shot compaction budget. The output clamp can then leave one token. Structural leaves with bounded preceding context and serial adjacent binary reduction prevent that gross oversized summarization request. Existing native entry points remain the user interface. No deployment, merge, live API QC, recovery, runtime session changes, provider changes or dependency updates are authorized.

This is separate from D-COMP-001; no unapproved exact-anchor, consolidation-only, or broad failure-latch proposal is imported. Provider-exact tokenization and semantic fidelity are not proved by offline fixtures. Separately approved live fidelity QC remains required.

## Approved contract


### C1 — User-visible operation and scope

Keep current TUI `/compact`, SDK `session.compact`, RPC `compact`, and automatic threshold/overflow entry points. Gateway has no deployed Discord compact slash operation; do not add one in this change. Existing compaction_start/end and monitor display remain the entry/result path. One start and one terminal result for the whole operation; optional bounded numeric progress through existing display mechanisms only if already available, not per-chunk fake successful compactions.

Success means one complete validated checkpoint is appended, original history retained, recent raw tail remains as native pointers describe, and the ordinary next response can proceed. Failure/cancel means no new compaction entry, no partial summary installed, clear terminal reason “history preserved; compaction incomplete,” and no automatic replay of completed tools. Keep current continuation/settled semantics. No new persistence, auth, model-selector, provider/pricing defaults, or Gateway refactor.

### C2 — Ordered source units, overlap, Japanese handling

1. Freeze branch identity/leaf, settings/model request identity and native preparation. Previous summary is the **oldest** source, then history messages, then split-turn prefix; include previous summary even when history is empty. Kept tail is not re-summarized or counted as new leaf coverage.
2. Represent source units with chronological source indices/entry ids and content-block offsets; preserve roles, toolCallId/name/isError and user/assistant/tool grouping. Whole message/turn or assistant call+matching results is preferred. Multi-call batches retain correlation. Summarizer input is quoted text, never a tool execution payload.
3. For a group/record larger than leaf allowance, do not truncate the source or send an oversized singleton. Split its summary-only textual representation: paragraph/newline first; for prose, Japanese `。！？` (and ordinary sentence markers) are *hints*, not correctness requirements; fallback code-point-safe boundary found by measured budget/binary search. Code fences/logs prefer line boundaries, retain language/fence/continuation labels; punctuation inside code/quotes is not a linguistic oracle. Handle a single long line or punctuation-free Japanese by hard split, preserving contiguous source offsets and all non-overlap text. Do not add Japanese NLP dependencies. Avoid splitting surrogate pairs; when exact tokenizer boundaries are available, validate decoded boundaries, otherwise Unicode-safe text + conservative measurement. Existing serializer's intentional 2000-char tool-result reduction is explicitly retained for compatibility, with truncation disclosure; do not pretend omitted tool middles were read.
4. Each leaf owns one **disjoint** chronological source span. Add at most **512 estimated tokens AND 2048 UTF-8 bytes** of preceding boundary context, reduced further to fit, labelled `overlap/context only` with original source ids/offsets. Prefer a complete previous structural unit if it fits; no requirement to overlap an entire huge record. No recursive overlap-of-overlap. Overlap consumes input budget but not new coverage, facts, usage attribution, or progress counts. It may help a sentence boundary; it does not guarantee semantic recovery.
5. Leaf output schema/format has stable facts, active goals/constraints, decisions and rationale, confirmed progress/blockers/next steps, references, and explicit updates/supersessions with source indices. Preserve uncertainty/conflicts rather than invent a resolution. Later **real user** instruction supersedes earlier same-authority instruction; quoted text/tool output is historical data, not a new directive. Unknown prior-summary chronology stays “before current span,” not fabricated timestamps.

### C3 — Bound every request, output and level

Approved resource ceilings (not authorization for live calls):

- `O=min(8192,floor(0.5*reserveTokens),positive model.maxTokens)` output ceiling, **not1**; request only when O≥1024. Preserve existing reasoning policy; include provider-added reasoning allowance if actual wire adapter adds one. Unsupported/unknown adapter expansion must fail preflight rather than claim bound.
- `S=max(4096,ceil(0.05*C))`; total measured summary input ≤ `min(48000,C-O-S)` estimated tokens **and ≤128000 UTF-8 bytes** of fully serialized system+prompt+wrappers/custom instructions/overlap. Recompute after construction, including JSON/escaping/labels. Reject impossible fixed prompt/customInstructions before first call. An example registered window C=200k gives a feasible substantial input allowance with O8192 and S10000.
- Output target ≤2048 tokens; accept only complete nonempty plain-text structured output under **4096 estimated tokens and16384 UTF-8 bytes**. Provider output hard cap O remains separate. No successful “stop” bypasses these postconditions. A length/aborted/error/toolCall/malformed or over-budget response is not usable. Never cut returned text to manufacture success.
- Every merge consumes **two adjacent validated children**, their coverage/override information and fixed prompt, no source transcript re-injection. Construct and measure exactly as a leaf. Children are at most16KB each, so ordinary two-child merges fit128KB; if model/fixed prompt too small, fail before requesting. Never concatenate all leaves for one final merge. Final root must meet the same output bounds plus final metadata budget below. Depth≤5 for≤32 leaves. One-shot path must meet **the same** bounds and postconditions; no legacy unbounded bypass.
- Previous summary may itself exceed leaf budget: structurally partition it as oldest source units and reduce under the same rules. Native generated file-list suffix can be removed from *summary-only prompt input* only when provenance is grounded: previous native fromHook=false, exact recognized terminal formatter output agrees with details; ordinary user XML-like text or extension summary must not be stripped. Unknown/legacy prior-summary body is split, not heuristically discarded.

**Measurement honesty:** Pi's current chars/4 estimator is not a Japanese/provider tokenizer. Estimated-token and byte bounds are mechanical, not proof every backend token count is below C. The conservative byte ceiling + ample slack avoid the observed gross overload and can be made provider-exact where an exact local tokenizer exists; no new remote token-count call. Describe remaining tokenization uncertainty explicitly and fail on provider context errors. Do not promise “size failures are impossible.” Source-offset coverage, UTF-8 sizes, leaf/merge fan-in, positive requested allowance and no one-token clamp *under the installed estimator* are guaranteed assertions.

### C4 — Bounded metadata and next-turn/next-compaction safety

Metadata policy:

- Full cumulative `readFiles`/`modifiedFiles` remain in **existing CompactionEntry.details** and original history, with no authority/schema migration. For bounded LLM-visible summary, reserve **2048 estimated tokens AND8192 UTF-8 bytes within the final16384-byte ceiling**, show recent references from summarized span in deterministic reverse-last-reference priority, modified before merely read on equal recency, plus total counts and explicit omission notice. Include current work references produced in structured root output within the same budget; do not claim the recency preview is complete or a reliable semantic importance classifier. A single excessively long path can be omitted with notice, never silently sliced into a different path.
- Full details are actually retrievable via SDK `SessionManager.getEntry(id)/getEntries()` and RPC **get_entries**, or an authorized local read of the retained JSONL. Existing model tools do not automatically expose a “load omitted files” action. Summary wording may name stored compaction details as provenance, but must not direct users/model to nonexistent tools. No new metadata retrieval framework in scope.
- Build an **in-memory hypothetical native CompactionEntry** with the final summary and unchanged firstKeptEntryId, then rebuild context using native buildSessionContext. Measure currently available system prompt, tool schemas, known fixed work-control prompt and continuation text, plus 4096 estimated tokens of dynamic-injection overhead. Reserve the intended ordinary output allowance (positive model.maxTokens, matching ordinary defaults) plus S separately. The dynamic overhead is additional to output reservation and S, not a replacement for settings.reserveTokens. Require estimated input below C minus output and S, and below C minus settings.reserveTokens. This establishes native next-turn headroom, NOT a complete outgoing-request guarantee for arbitrary future user input, stateful extension context transformation, before_agent_start injection, or opaque custom stream wrappers. Do not execute callbacks speculatively and do not reject merely because a callback exists. Separately prove next compaction previous-summary input is bounded (root+preview bounded; future new history will be partitioned).
- Preserve native firstKeptEntryId and raw kept tail exactly. If retained tail/system/tools alone cannot fit (e.g. huge most recent tool record), fail **before any summary calls where detectable**, otherwise before commit. Do not move the pointer, split stored messages, drop live tools or silently change keepRecent as a workaround. Such a session needs separately approved larger-model compaction or a bounded new-session handoff. This is an explicit safe failure boundary, not a false success.
- Full details size can grow on disk; it is not sent to the model. Preserve it without unrelated pruning. The runtime must not append it wholesale again on the next summary: same bounded preview policy applies every time.

### C5 — Calls, retry, cancellation, resume and cost

- Entire plan deterministic before requests where possible: max **32 leaves**, max **31 merges**, depth≤**5**, serial one-at-a-time, max **64 physical model attempts total including transient retries**, max **2,000,000 cumulative estimated input tokens** and **524,288 cumulative reserved output tokens**, whole operation deadline **8min** including backoff. Reserve budget *before* each physical attempt; stop without commit if insufficient. No widening chunk count/depth/caps because a job nearly finished. If preflight plan cannot complete within these caps, fail with planned count/budget reason. These are resource ceilings, not authorization to spend them.
- Existing transient retry policy is an upper bound **inside** the global job budget/deadline, not N independent unbounded retries. Avoid nested SDK/HTTP retry multiplication; count actual outer/provider attempts or explicitly configure the summarization request's internal retry layer so physical bound is auditable. Do not change provider pricing/ordinary-call defaults to achieve this.
- 400 invalid request/context,401/403 auth and402 billing: terminal, no automatic provider fallback or added credits. 429 transient throttling/5xx/transport drops: existing bounded exponential backoff/retry only, honoring Retry-After when within remaining deadline; account/quota exhaustion is terminal. Abort during request/backoff/merge/just before append cancels the whole job and cannot be retried by this job. Length/empty/overbudget/invalid structured output: fail this compaction; no partial adoption or unbounded “summarize the bad summary again.” A future bounded refinement retry would need separate design, not an implementation improvisation.
- In-memory validated leaf/merge results are checkpoints **within the active attempt only**; failed node transient retry reuses completed siblings. No disk job journal, no automatic resume after cancel/restart/final failure. A new explicit compact recomputes from current original branch and can incur new calls. No partial checkpoint is represented as a native CompactionEntry. Existing automatic failure suppression must cover deterministic budget/output failures for the same preparation/model conditions so next tool result does not restart a large failed job; preserve/manual re-arm behavior must be documented and tested without adopting the unrelated broader D-COMP-001 latch design.
- Bound metered resource exposure by requests/input/reserved-output above. For model tariffs that are trustworthy, show a maximum charge estimate including retries/cache billed conservatively as uncached. **A custom connector reporting cost=0 is not a guarantee of zero real cost**; actual upstream tariff/subscription constraints are not known. A contractual currency ceiling cannot be guaranteed from this metadata. No paid live run until user approves provider and a concrete cost cap or accepts the stated bounded resource ceiling. Do not label the new multi-call path price-neutral.

### C6 — Commit/compatibility

Snapshot current leaf and check it still matches immediately before commit, along with signal and model/settings identity. If ordinary/extension activity changed the history being compacted, reject stale plan rather than append against an unrelated leaf. Do not lock out queue delivery by inventing a new run model.

Run all validations, then **one** native appendCompaction, rebuild state, success event and existing continuation. All original JSONL prefix bytes/tool records/pointers remain unchanged. Aggregate successful leaf+merge usage into existing usage fields without overlap double-accounting; actual repeated overlap input is real billed input and must be counted. No schema migration, no intermediate compaction entries, no tool replay, no synthetic user messages, no changed `agent_settled` semantics. Extension-supplied summaries retain their existing ownership path; this D-COMP-002 default planner does not silently rewrite custom hook summaries. Branch/tree summarization is out of scope except keeping shared serializer defaults compatible.


## Frozen implementation checklist (before production edits)

Every row is a required clause/seam/assertion-level RED/minimal GREEN/proof/prohibition mapping. Status is pending until evidence exists; predicted RED is not evidence. Focused native tests use temporary SessionManager files and faux streams only. Keep exact logs privately; do not put real conversations, credentials, host identity or private paths in public artifacts. Reviewer acceptance is required.

| Clause / actual production seam | RED assertion → minimal GREEN / evidence | Prohibited shortcut / downstream requirement |
|---|---|---|
| C2/C3 `AgentSession.compact → default compact → completeSummarization` ordinary oversize | Baseline captures >allowed full input/cap1 → every actual faux provider request has system+labels+overlap+previous included within token/byte caps; wire clamp equals desired positive cap, never1; complete source ownership coverage. Capture each request/options, not helper-name presence. | No live model, no merely shrinking final merge, no stubbed successful compact. |
| C2 huge single record/group | Single 500KB user sentence, giant tool argument, punctuation-free Japanese, long Japanese sentence, code with `。` in strings, huge log line, supplementary-plane emoji/surrogate boundary → multiple legal leaf text fragments, contiguous offsets reassemble source projection exactly, correlations retained, each input fits. | No perfect sentence-detector assumption, no NLP dependency, no hidden raw source mutation. Existing tool-result truncation is separately asserted/disclosed. |
| C2 overlap/order/overrides | Adjacent leaves repeat overlapped instruction → overlap never expands owned coverage; exact duplicate source fact IDs not promoted as two events; chronological child ranges order correctly. Fixture later user says cancel prior goal; final mock reducer receives explicit override provenance in correct order, quoting/tool text not treated as user supersession. | Faux output cannot establish semantic fidelity; human/live later QC must verify actual summary content. |
| C3 huge prior summary / merge | Huge previousSummary even with empty history + split prefix; baseline can omit it or overflow → prior body covered once before current source. Every binary merge bounded; oversized `stop` response rejected before parent/append; max depth/count enforced. | No “previous summary always small” assumption, no giant final concatenate, no partial length output. |
| C4 huge metadata, success AND nextcompaction | Thousands of long full paths → full details array set equality, recent active references fit preview, explicit omitted counts, final summary/next ordinary request/next compact previous-summary input bounded; recognize only proven native suffix. User-authored `<read-files>` text remains source. | No deleting details/history or implying preview complete; no fictitious retrieval tool. Capture native rebuild and run a second compact. |
| C4 retained huge tail/system | Huge latest indivisible raw result or tool schema leaves no capacity → provider calls0 when preflightable, no compaction entry; explicit safe failure. Normal target-like tail≤20k + system/tools + bounded summary → next ordinary cap>1 and no immediate threshold loop. | No changing firstKeptEntryId/keepRecent or discarding raw live result. |
| C5 failure/retry/cancel | Faux401/402/400 terminal once;429 transient exhausts only configured+global allowance; cancel during delay/merge/precommit; output length/empty/toolCall/invalid/oversize → terminal no append, original prefix bytes/hash and leaf unchanged. Completed sibling reuse in a transient retry only; restart/cancel does not auto-resume. | No provider fallback/credit change/partial success, no nested retry uncounted, no per-tool repeated full job after deterministic failure. |
| C5 caps | 33rd leaf, depth6,65th physical attempt, token/cost-resource cap boundary, deadline+1ms → no further request, no commit, reason visible through compaction_end. | No call budget reset at each hierarchy level; fake timers for offline deadline assertions. |
| C6 success native pointer lifecycle | Real temp SessionManager + faux stream, one successful append only; firstKeptEntryId exact, tokensBefore preserved, stored usage aggregate, old JSONL byte prefix unchanged; next assistant once/tools once/settled once; subsequent compaction starts at earlier kept boundary and remains bounded. Manual, threshold, overflow paths use same default core. | Do not stub append/continue or treat internal helper success as production evidence. Retain queue/terminating-tool/low-level abort and extension-hook compatibility tests. |
| C1 visible result | Existing monitor formatter/event test receives complete success or single clear failure/cancel state; no leaf labelled complete compaction. | Paid live Discord user-experience QC later only; internal harness not user completion. |


C4 clarification approved before implementation: no cross-Agent/SDK request-preview API or new state authority. Budget native rebuild, available system/tools and known fixed work-control strings. Add 4096 estimated input-token reserve for unobserved dynamic injections, in addition to ordinary output reservation and safety S. Assert native next-request cap remains positive and below threshold. Arbitrarily large dynamic extensions or new user input remain outside that claim. `prepareNextTurnWithContext`, `transformContext`, and `before_agent_start` are not invoked speculatively.

## Intended edits and gates

- `src/core/compaction/compaction.ts`: default orchestration, prior-summary provenance and bounded file preview.
- `src/core/compaction/bounded-compaction.ts`: internal structural planner, binary reducer, resource accounting; not a generic scheduler.
- `src/core/compaction/utils.ts`: opt-in labelled serialization; existing external/branch defaults unchanged.
- `src/core/agent-session.ts`: native hypothetical rebuild/preflight, stale snapshot and preappend checks; hook-owned summaries unchanged.
- Existing compaction tests and source-named native suite tests; `docs/compaction.md` for bounds/failure constraints.
- Keep provider cache/auth/reasoning defaults. Account for known adapter reasoning expansion; reject unsupported unknown expansion rather than assert a false bound.
- `mise exec -- pnpm install --frozen-lockfile --ignore-scripts`, targeted offline tests, `mise exec -- pnpm run check`, `mise exec -- ./test.sh`, then exact-head CI. Committed catalog snapshot only; no hydration. Record baseline failures, do not repair unrelated code.
- No staged files at handoff. No merge/deploy/live QC. Public PR links this document and states estimator, retained-tail, dynamic-injection, cost and fidelity boundaries.

## Evidence ledger

The design/checklist-only commit preceded production edits. Initial native RED before implementation: **11 assertion failures / 3 passes**. Expanded comparison on the untouched base with only the persistent harness and new tests: **39 failures / 11 passes** across 50 tests. A further targeted base RED reproduces the estimator clamp as **actual 1 vs expected 8192**. The expanded RED includes missing source-ledger contract assertions and the old uncooperative-provider timeout, not only numeric assertions; those are not misrepresented as provider-semantic evidence.

Current native GREEN: **51/51**. Repository `pnpm run check` passes. Isolated-home `./test.sh` passes (coding-agent **2333 passed, 2 expected fail, 50 skipped** at the 50-test-suite run; the additional one-token regression also passes independently). Offline build passes using the committed catalog snapshot. The new documentation inventory initially failed and was corrected by registering this required design in both indexes; it was introduced wiring, not a baseline defect. Existing Vitest/config resolution warnings are also present on the clean-base run and do not fail tests. No dependencies, provider catalog, runtime or workflow files changed.

The default generation seam is now `AgentSession.compact/_runAutoCompaction -> compact -> generateBoundedSummary`; standalone/branch `completeSummarization` behavior remains separately compatible. Evidence is the source-named native suite `test/suite/agent-session-bounded-compaction.test.ts` (real temporary JSONL, faux streams), with these frozen-row mappings:

| Frozen row | Retained offline proof / minimal implementation |
|---|---|
| C2/C3 actual request seam | Giant-record cases capture every provider-bound context/options, enforce both input ceilings and positive unchanged installed-estimator cap; dedicated base regression observes clamp=1. The new bounded request builder replaces only native generation. |
| C2 huge record/group | Four Japanese/ASCII/astral/code cases reassemble contiguous UTF-16 offsets; multi-tool case preserves call/result IDs and explicit legacy truncation disclosure. Structural grouping and safe measured splits provide the minimal path. |
| C2 overlap/order/overrides | Every overlap fits both ceilings and is labelled context-only; adjacent merge children carry chronological ranges, depths and the later real-user source distinct from quotes/tool data. This proves supplied provenance, not model interpretation. |
| C3 prior summary/merge | Huge oldest prior summary with empty history, two-child chronological merge fan-in, rejection of invalid/overbudget leaf or merge, maximum 32-leaf/31-merge/depth-5 success and 33-leaf preflight failure. |
| C4 metadata/next compact | Full details set equality, recent bounded preview and omission counts, exact-native suffix recognition, extension/user lookalikes preserved, two native compactions and separate next-ordinary-request headroom assertions. |
| C4 retained tail/system | Oversized retained tail, system prompt and tool schema fail with zero calls and unchanged prefix/leaf. Native hypothetical rebuild enforces separate ordinary output, safety, threshold and 4096 injection reserve. |
| C5 failure/retry/cancel | Terminal auth/billing/invalid/quota errors do not retry; Retry-After cancellation, request/deadline/merge/precommit cancellation, bad output classes, sibling reuse only within transient retry, explicit restart recomputation and deterministic automatic suppression. |
| C5 ceilings | Global 64-attempt, cumulative estimated input and reserved reasoning-output caps, fixed-instruction/model/output preflight, 480-second uncooperative-stream deadline, 32-leaf/depth boundaries; no native append on any failure. Nested provider retries and server-model fallbacks are disabled only for scoped summary requests. |
| C6 native lifecycle | Persistent JSONL byte prefix/pointer/tokensBefore preserved; one native append, aggregate actual node/retry usage including repeated overlap, stale model/settings/history/system rejection, manual/threshold/overflow success, real tool-boundary continuation/tools/settled once. Existing queue/retry/baseURL/extension-owned suites remain passing with complete output fixtures. |
| C1 visible result | One compaction start/terminal event per job, explicit history-preserved incomplete failure, existing monitor/queue/settled tests. No new leaf-level fake success or UI control. Live human UX/semantic acceptance is not claimed. |

Independent review of the initial implementation blocked source acceptance on a C2 provenance defect: converting the whole native span before building its ledger promoted bash/custom/branch sources to user roles and shifted entry IDs/history-prefix phases after excluded bash. The correction projects each native source individually, retains its original role/custom type and native index, and applies existing exclusions without shifting identity. Shared ordinary/branch conversion and persisted schemas remain unchanged. Two real native request-capture regressions first failed at the payload assertions, then passed; the focused native/standalone summary suites pass 68 tests (53 native), and the root check passes. Fresh exact-head CI and independent rechallenge are required for the corrected commit.

Independent review and exact-head CI are required before source acceptance; the original block is not treated as reviewer acceptance. Separately authorized live semantic/human QC, provider-exact tokenization, arbitrary future dynamic injection, opaque upstream tariffs and retained-tail-impossible recovery remain outside offline proof. Exact private logs are retained outside the repository; no raw private evidence is published.

## Model-aware corrective amendment (source/PR/offline only)

This amendment supersedes C2's mandatory output ledger and C3's fixed input/output
ceilings and binary-only reduction, not source identity or history preservation.
The observed generation-length stop does not establish which node failed or its
actual token usage. A reconstructed 41-call plan is not a measured sent-call count.

- Derive answer allowance from the existing native summary reserve policy:
  `O=min(floor(0.8*reserveTokens), model.maxTokens)`; preserve reasoning expansion.
  Input envelope is `C-wireOutput-max(4096,ceil(0.05*C))`. Measure the constructed
  system/prompt/JSON, with ASCII/3 and non-ASCII UTF-8/2 uncertainty estimate,
  never bytes/4 as proof of Japanese accuracy. This is conservative planning,
  not provider-exact tokenization. No arbitrary small input byte/token ceiling.
- Prefer one whole request. Otherwise retain structural units, Unicode-safe
  fragments and bounded preceding overlap. Reduce the largest fitting adjacent
  group, including all children when legal; never merge an already single root.
  Preflight worst-case merge envelopes and planned calls against the eight-minute
  deadline using a 15-second minimum planning allowance per serial request.
  Keep existing attempt, cumulative input/output, leaf/depth and deadline ceilings.
- Request six concise sections, target half O, retain only actionable references
  and meaningful supersessions, not exhaustive per-source updates/inventories.
  Input provenance remains unchanged. Reject length/partial/malformed outputs.
  Body allowance derives from O; bounded file preview remains separate. Native
  hypothetical rebuild, not a fixed 4096-token/16KB final cap, decides next-turn fit.
- Required automatic compaction failure/suppression must stop unsafe initial
  `session.prompt` and assistant continuation. Throw a native caller error before
  ordinary submission when unsafe remains; preserve stored history and caller's
  unsubmitted intent, no synthetic replay/queue mutation or second overflow job.
  A prior failure alone must not block currently safe small context.

| Seam | Assertion RED -> minimal GREEN | Retained evidence / prohibited shortcut |
| --- | --- | --- |
| Native default generation | 1.4MB generic history, C=1M: exactly one summary call; smaller C: largest legal leaves and one all-child merge when it fits | Capture actual contexts/options and total estimated input/reserved output; no live calls or provider switch |
| Native final checkpoint/rebuild | Complete moderately long six-section output accepted when rebuild fits; next ordinary output positive and next compact legal | No truncation, pointer change or partial adoption; retain provenance regressions |
| Real session.prompt | Required summary length-stop: zero ordinary calls, no append, identical history prefix, rejected caller intent; suppressed retry also zero calls | No threshold->ordinary400->second paid job, no queue deletion/replay |
| Actual tool continuation | Required summary failure stops the next assistant request; safe smaller context with historical failure still works | Native lifecycle assertions, no preview API or arbitrary future extension guarantees |

Independent reviewer acceptance and exact-head CI remain required. No merge,
deployment, runtime writes, paid probes, dependency or catalog updates authorized.


Corrective implementation evidence: the frozen amendment preceded code. Five
focused assertion-level RED failures covered 25 actual faux requests versus one
for the generic 1.4MB/1M-window fixture, 13 leaves versus at most five for its
200k-window counterpart, the obsolete final output cap, initial prompt fail-open,
and continuation fail-open. Subsequent native bounded/compatibility suites pass
89 tests, including preserved source-role/entry-ID regressions. Obsolete fixed
cap and mandatory binary-fan-in assertions now check model-derived envelopes,
concise six-section output and largest-fitting chronological reduction instead.
The unchanged 64-attempt ceiling is isolated with a smaller configured reserve;
the input/reasoning-output ceilings retain dedicated exhaustion assertions.
The former mandatory 32-leaf/31-merge success fixture is replaced with deadline
preflight rejection: legal per-request sizes alone do not justify a serial plan
that cannot fit its planning allowance. No live fidelity or latency is claimed.

Resource witness (generic 1,400,010-byte Japanese/ASCII fixture, native temporary
session, no provider network): C=1M uses one leaf, zero merges, 669,793 cumulative
estimated input tokens and 13,107 reserved output tokens. C=200k uses four leaves
and one all-child merge, 676,651 cumulative estimated input and 65,535 reserved
output tokens. Every constructed request fits its model-derived envelope.
These are offline planned resources, not measured historical sent counts/costs.
Final local check and isolated full suite pass (coding-agent: 2341 passed,
2 expected failures, 50 skipped); exact-head CI and independent review are
separate required gates. The first full run exposed only an obsolete fixed8192
assertion, updated to the approved reserve/model-derived allowance and rechecked.

## Content-aware estimate and fill-target amendment (source/PR/offline only)

Supersedes the model-aware amendment's "ASCII/3 and non-ASCII UTF-8/2" planning
estimate and its per-request input allowance. Source identity, history
preservation, one-shot preference, largest-fitting reduction, output allowance,
defaults suppression and the fail-closed pre-prompt gate are unchanged.

Measured cause on the deployed PR39 build, channel `dc:1510466645770895370`:
the planner sized one summary request at 916,626 estimated tokens against a
936,893 allowance and the provider rejected that same request at 1,064,377
tokens > 1,000,000 (offline capture of the preserved session aborted before
dispatch; zero provider calls). The serialized envelope was 2,235,626
characters: 2,088,589 ASCII (JSON keys, UUIDs, decimal ids, paths, punctuation),
135,132 kana/han/fullwidth and 11,889 other non-ASCII. Pricing ASCII at three
characters per token was therefore 16% too optimistic; the kana factor was not
the primary error.

- Planning estimate (`estimateSummaryTextTokens`, still a local pure function):
  ASCII at 2.5 characters per token, kana/han/Hangul/fullwidth at 1.5 tokens per
  code point, other non-ASCII at 1, astral code points (emoji) at 2. It counts
  code points, never UTF-8 bytes, so Japanese is not priced like English. No
  tokenizer dependency, no remote count call, no model/provider/catalog change.
  On the rejected envelope it returns 1,050,023, 1.3% below the measured
  provider count and above the model limit, so that request cannot be planned.
- Fill target: every constructed leaf or merge request - previous summary,
  instructions, custom focus, labels, overlap and wrappers included - must fit
  `min(C-wireOutput-S, floor(0.8*C))`. The unused fifth of the window is the
  reserve for estimate error, system/tool overhead, wrapper/injection variance
  and tokenizer drift. It is a bound on planned size, not a substitute for the
  content-aware estimate: 80% of C with a chars/4 underestimate is still unsafe.
  One summary request remains the plan when the whole content fits that target.
- Still fail-closed: if required compaction fails, the ordinary prompt and the
  next assistant continuation are refused; no partial checkpoint is installed.

| Seam | Assertion RED -> minimal GREEN | Retained evidence / prohibited shortcut |
| --- | --- | --- |
| Planner estimate | Production envelope composition (2,088,589 ASCII, 135,132 kana/han/fullwidth, 11,889 other non-ASCII, 8 astral) -> estimate above the 1,000,000 limit and within 2% of the measured 1,064,377 tokens, while the previous ASCII/3 formula stays under the 936,893 allowance | Local pure estimate; no provider call, no tokenizer dependency, no arbitrary global multiplier as the only change |
| Native plan, dense Japanese/JSON | 12,000 fixture records, 1,440,890 characters, C=1M: previous estimate accepted one request -> two leaves plus one merge, every constructed request inside 0.8*C, all records summarized once | No over-splitting back to fixed small caps; no source loss or duplication; plan stays at three calls |
| Native plan, large ASCII | 1,800,000 ASCII characters, C=1M -> exactly one summary call at 721,080 planned input, inside 0.8*C | One-shot preference preserved for content that fits the target; no brim-packing |

Resource witness (offline, faux streams, zero provider calls, unchanged session
bytes): the two-call/one-merge dense plan above is 3 calls, 790,063 + 200,096 +
1,360 planned input tokens and 13,107 reserved output; the large-ASCII fixture is
1 call, 721,080 planned input. The generic Japanese/ASCII fixture of the prior
amendment now uses one leaf at C=1M (719,751 planned input) and five leaves plus
one merge at C=200k (786,642 reserved output), superseding its four-leaf witness.
These remain planned resources, not measured provider counts or charges; probe
of real semantic fidelity, latency and provider-exact tokenization remains out
of scope. Exact-head CI and independent review are separate required gates.

## Bounded parallel leaf amendment (approved v3; source/offline only)

Serial leaves can consume the entire eight-minute budget before reduction. A
four-leaf latency trace of 124145/126159/126933/77404ms leaves only about 25s for
the merge. Increasing the deadline is not the correction: summarize independent
leaves with concurrency **2**, then merge validated children in chronological
order. Adjacent merge grouping and serial merge execution stay unchanged.

- Two workers take chronological leaf indices. Each result is installed only in
  its indexed in-memory slot after validation. Reduction starts only after the
  whole leaf barrier succeeds, regardless of completion order.
- Keep 32 leaves, 31 merges, depth 5, 64 physical attempts, 2,000,000 estimated
  input tokens, 524,288 reserved wire-output tokens and the **480000ms absolute
  deadline**, including planning, retries and backoff. The conservative serial
  15s-per-planned-call admission heuristic is unchanged. Reserve shared budgets
  synchronously before every dispatch, including retries; no refunds on failure.
  A retry occupies its worker slot, so throttling cannot create extra fanout.
- On first terminal failure or external abort, stop admission and cancel all
  sibling requests/backoffs. Observe and settle every worker before returning;
  retain the first causal error rather than a later sibling cancellation. Race
  opaque provider and retry-callback promises against cancellation so they cannot
  extend the job indefinitely. Such external code may ignore cancellation, but
  its promises remain observed and late results cannot merge or append. No new
  persisted job state, resume mechanism or public progress event is introduced.
- Preserve the original automatic compaction failure at the unsafe prompt gate
  in both the message and `Error.cause`, including same-preparation suppression.
  Associate diagnostics with the existing preparation key, not a new latch;
  retain the existing policy allowing safe small context and changed conditions.
  No failure authorizes an ordinary request on unsafe context or a partial native
  checkpoint. Native preappend signal/identity checks remain authoritative.

Offline regression evidence is in
`test/suite/agent-session-parallel-compaction.test.ts`, using the existing harness,
synthetic source and faux provider only. Controlled promises prove two-leaf
admission, out-of-order completion, chronological merge and a complete barrier.
Fake timers reproduce the slow trace with a synthetic 40s merge: serial needs
494641ms, while parallel leaf starts are 0/0/124145/126159ms, merge starts at
251078ms, and one native checkpoint finishes at **291078ms**. The next ordinary
request succeeds. Separate tests cover the unchanged absolute deadline, terminal
failure, external cancellation, late sibling rejection, synchronous abort during
dispatch, Retry-After cancellation and shared attempt/input/output exhaustion.
The existing continuation regression now permits the already-dispatched sibling
but still forbids any ordinary request after failure. Prompt tests require the
original deadline diagnosis on both initial failure and suppressed retry.

Initial source-baseline checks observed one outstanding leaf instead of two and
the generic unsafe-context error instead of the deadline cause. A serial-worker
mutation also fails the slow regression specifically with the eight-minute
deadline error; restoring two workers passes. The 14 new regressions and focused
compatibility set pass (158 tests, 15 skipped). Root `pnpm run check`, the offline
build and isolated `./test.sh` pass (coding-agent: 2359 passed, 2 expected failures,
50 skipped). Offline tests prove scheduling and native failure atomicity, not live
provider fidelity, subscription cost, production recovery or deployment.
Exact-head independent review and CI remain required; no private source history
is included.
