import { readFileSync } from "node:fs";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

const checkpoint =
	"## Goal\nContinue approved task.\n## Constraints & Preferences\nKeep history.\n## Progress\n### Done\n- Confirmed fixture.\n### In Progress\n- Continue.\n### Blocked\n- None.\n## Key Decisions\n- Keep source order.\n## Next Steps\n1. Continue.\n## Critical Context\n- Fixture references.\n## Updates & Sources\n- Preserve uncertainty; source 0 before current span.";

type Capture = { context: Context; options: SimpleStreamOptions | undefined };

interface FixtureSpan {
	sourceIndex: number;
	blockIndex: number;
	role: string;
	start: number;
	end: number;
	text: string;
	chronology?: string;
	toolCallId?: string;
	truncated?: boolean;
}
interface FixtureNode {
	first: { sourceIndex: number; offset: number };
	last: { sourceIndex: number; offset: number };
	depth: number;
	text: string;
}
type FixturePayload =
	| { kind: "leaf"; owned: FixtureSpan[]; overlap: FixtureSpan[] }
	| { kind: "merge"; children: FixtureNode[] };
function payload(capture: Capture): FixturePayload {
	const message = capture.context.messages[0];
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("expected text source request");
	return JSON.parse(message.content.split("\n<source-data>\n")[1].split("\n</source-data>")[0]) as FixturePayload;
}

describe("D-COMP-002 AgentSession bounded native compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const h of harnesses.splice(0)) h.cleanup();
	});

	async function setup(text = "old history"): Promise<{ h: Harness; captures: Capture[] }> {
		const h = await createHarness({
			persistent: true,
			models: [{ id: "bounded", contextWindow: 200000, maxTokens: 32000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(h);
		// Use the real temporary JSONL writer, not a mocked append.
		h.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() - 1000 });
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("kept response"),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		const captures: Capture[] = [];
		h.setResponses(
			Array.from({ length: 64 }, () => (context: Context, options: SimpleStreamOptions | undefined) => {
				captures.push({ context: structuredClone(context), options });
				return fauxAssistantMessage(checkpoint);
			}),
		);
		return { h, captures };
	}

	function unchanged(h: Harness, prefix: string, leaf: string | null) {
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(prefix);
		expect(h.sessionManager.getLeafId()).toBe(leaf);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
	}

	it.each([
		"日本語".repeat(170000),
		"a".repeat(500000),
		"😀𠮷".repeat(90000),
		`\`\`\`js\nconst s = '。！？';\n${"x".repeat(500000)}\n\`\`\``,
	])("bounds giant records, owns every Unicode span and appends once (%#)", async (text) => {
		const { h, captures } = await setup(text);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const preparation = prepareCompaction(h.sessionManager.getBranch(), h.settingsManager.getCompactionSettings())!;
		const result = await h.session.compact();
		for (const { context, options } of captures) {
			expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(128000);
			expect(estimateContextTokens(context).tokens).toBeLessThanOrEqual(48000);
			expect(options?.maxTokens).toBe(8192);
			expect(clampMaxTokensToContext(h.getModel(), context, options!.maxTokens!)).toBe(8192);
			expect(options?.maxRetries).toBe(0);
		}
		expect(captures.length).toBeGreaterThan(1);
		const leafPayloads = captures.map(payload).filter((p) => p.kind === "leaf");
		const owned = leafPayloads.flatMap((p) => p.owned).filter((p) => p.sourceIndex === 0);
		expect(owned.map((p) => p.text).join("")).toBe(text);
		for (let i = 0; i < owned.length; i++) {
			expect(owned[i].start).toBe(i ? owned[i - 1].end : 0);
			expect(!/[\uD800-\uDFFF]/u.test(owned[i].text)).toBe(true);
		}
		for (const p of leafPayloads.slice(1)) {
			expect(Buffer.byteLength(JSON.stringify(p.overlap))).toBeLessThanOrEqual(2048);
			expect(JSON.stringify(p.overlap)).toContain("context only");
			expect(Math.ceil(JSON.stringify(p.overlap).length / 4)).toBeLessThanOrEqual(512);
		}
		expect(result.firstKeptEntryId).toBe(preparation.firstKeptEntryId);
		expect(result.tokensBefore).toBe(preparation.tokensBefore);
		expect(result.usage!.input).toBeGreaterThan(0);
		expect(readFileSync(h.session.sessionFile!, "utf8").startsWith(prefix)).toBe(true);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("does not let the installed estimator clamp an oversized native request to one token", async () => {
		const { h, captures } = await setup("z".repeat(1000000));
		await h.session.compact();
		for (const { context, options } of captures) {
			expect(clampMaxTokensToContext(h.getModel(), context, 8192)).toBe(8192);
			expect(options?.maxTokens).toBe(8192);
		}
	});

	it.each([
		"",
		"not structured",
		checkpoint + "x".repeat(17000),
		checkpoint.replace("### Done\n- Confirmed fixture.", "### Done"),
		checkpoint.replace("### Done", "### Outside"),
	])("rejects unusable stop output without mutating the file (%#)", async (bad) => {
		const { h } = await setup();
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		h.setResponses([fauxAssistantMessage(bad)]);
		await expect(h.session.compact()).rejects.toThrow();
		unchanged(h, prefix, leaf);
	});

	it.each(["length", "aborted", "toolUse"] as const)("does not adopt %s output", async (stopReason) => {
		const { h } = await setup();
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		h.setResponses([
			fauxAssistantMessage(stopReason === "toolUse" ? fauxToolCall("read", { path: "not-run" }) : checkpoint, {
				stopReason,
			}),
		]);
		await expect(h.session.compact()).rejects.toThrow();
		unchanged(h, prefix, leaf);
	});

	it("rejects a retained tail that cannot fit before asking the provider", async () => {
		const { h, captures } = await setup();
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("x".repeat(900000)),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(/retained|next.turn/i);
		expect(captures).toHaveLength(0);
		unchanged(h, prefix, leaf);
	});

	it("rejects stale model/settings/history before append", async () => {
		const { h } = await setup();
		h.setResponses([
			() => {
				h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 2 } });
				return fauxAssistantMessage(checkpoint);
			},
		]);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(/stale|changed/i);
		unchanged(h, prefix, leaf);
	});

	it("preplans the leaf limit before any request", async () => {
		const { h, captures } = await setup("あ".repeat(1500000));
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(/32|leaf|leaves/);
		expect(captures).toHaveLength(0);
		unchanged(h, prefix, leaf);
	});

	it("can make the next ordinary turn and a second compaction with bounded previous input", async () => {
		const { h, captures } = await setup("日本語".repeat(80000));
		await h.session.compact();
		h.setResponses([
			(context, options) => {
				expect(estimateContextTokens(context).tokens + h.getModel().maxTokens + 10000).toBeLessThan(
					h.getModel().contextWindow,
				);
				expect(clampMaxTokensToContext(h.getModel(), context, options?.maxTokens ?? h.getModel().maxTokens)).toBe(
					h.getModel().maxTokens,
				);
				return workResponse("ordinary response", context);
			},
		]);
		await h.session.prompt("continue");
		h.setResponses([
			(context, options) => {
				captures.push({ context, options });
				return fauxAssistantMessage(checkpoint);
			},
		]);
		await h.session.compact();
		expect(Buffer.byteLength(JSON.stringify(captures.at(-1)!.context))).toBeLessThanOrEqual(128000);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(2);
	});
	it("covers huge prior summary first, including when history is empty and only a split prefix remains", async () => {
		const { h, captures } = await setup();
		h.sessionManager.newSession();
		const prior = "unknown chronology 日本語".repeat(30000);
		const id = h.sessionManager.appendMessage({
			role: "user",
			content: "<read-files>user-authored data</read-files>",
			timestamp: 1,
		});
		h.sessionManager.appendCompaction(prior, id, 100, { readFiles: [], modifiedFiles: [] }, false);
		h.sessionManager.appendMessage(fauxAssistantMessage("retained suffix"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		const preparation = prepareCompaction(h.sessionManager.getBranch(), h.settingsManager.getCompactionSettings())!;
		expect(preparation.messagesToSummarize).toHaveLength(0);
		await h.session.compact();
		const leaves = captures.map(payload).filter((p) => p.kind === "leaf");
		expect(
			leaves
				.flatMap((p) => p.owned)
				.filter((s) => s.role === "previous summary")
				.map((s) => s.text)
				.join(""),
		).toBe(prior);
		expect(leaves.flatMap((p) => p.owned).at(-1)!.text).toBe("<read-files>user-authored data</read-files>");
		expect(leaves[0].owned[0].chronology).toBe("before current span");
	});

	it("retains full native file details, previews recent references, strips only proven suffix, and repeats safely", async () => {
		const { h, captures } = await setup();
		h.sessionManager.newSession();
		const readFiles = Array.from({ length: 1800 }, (_, i) => `src/${i}-${"long-path".repeat(12)}.ts`).sort();
		const modifiedFiles = Array.from({ length: 1200 }, (_, i) => `changed/${i}-${"long-path".repeat(12)}.ts`).sort();
		const id = h.sessionManager.appendMessage({
			role: "user",
			content: "<read-files>not a native file suffix</read-files>",
			timestamp: 1,
		});
		const suffix = `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
		h.sessionManager.appendCompaction(`prior body${suffix}`, id, 100, { readFiles, modifiedFiles }, false);
		h.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("edit", { path: "active.ts", oldText: "old", newText: "new" }), {
				stopReason: "toolUse",
			}),
		);
		h.sessionManager.appendMessage(fauxAssistantMessage("kept tail"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		const result = await h.session.compact();
		expect(result.details).toEqual({ readFiles, modifiedFiles: ["active.ts", ...modifiedFiles].sort() });
		expect(result.summary).toContain('"path":"active.ts"');
		expect(result.summary).toContain('"omitted":');
		expect(Buffer.byteLength(result.summary)).toBeLessThanOrEqual(16384);
		expect(JSON.stringify(captures)).not.toContain(readFiles[1000]);
		expect(JSON.stringify(captures)).toContain("not a native file suffix");
		h.sessionManager.appendMessage({ role: "user", content: "new work", timestamp: Date.now() });
		h.sessionManager.appendMessage(fauxAssistantMessage("next retained tail"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		captures.length = 0;
		const repeated = await h.session.compact();
		expect(repeated.details).toEqual(result.details);
		const prior = captures
			.map(payload)
			.filter((p) => p.kind === "leaf")
			.flatMap((p) => p.owned)
			.filter((s) => s.role === "previous summary");
		expect(prior.map((s) => s.text).join("")).not.toContain("<file-preview>");
	});

	it("keeps extension-owned XML-like suffix as source data", async () => {
		const { h, captures } = await setup();
		h.sessionManager.newSession();
		const id = h.sessionManager.appendMessage({ role: "user", content: "earlier request", timestamp: 1 });
		h.sessionManager.appendCompaction(
			"extension body\n\n<read-files>\nkeep-me\n</read-files>",
			id,
			100,
			{ readFiles: ["keep-me"], modifiedFiles: [] },
			true,
		);
		h.sessionManager.appendMessage(fauxAssistantMessage("retained"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.compact();
		expect(JSON.stringify(captures)).toContain("keep-me");
	});

	it("splits giant multi-tool arguments without losing correlations and discloses legacy tool-result truncation", async () => {
		const { h, captures } = await setup();
		const args = { command: "日本語😀".repeat(60000) };
		const first = fauxToolCall("bash", args, { id: "first-call" });
		const second = fauxToolCall("read", { path: "reference.ts" }, { id: "second-call" });
		h.sessionManager.appendMessage(fauxAssistantMessage([first, second], { stopReason: "toolUse" }));
		for (const call of [first, second])
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "x".repeat(4000) }],
				isError: call.id === first.id,
				timestamp: Date.now(),
			});
		h.sessionManager.appendMessage(fauxAssistantMessage("retained"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.compact();
		const spans = captures
			.map(payload)
			.filter((p) => p.kind === "leaf")
			.flatMap((p) => p.owned);
		expect(
			spans
				.filter((s) => s.toolCallId === "first-call" && s.role === "assistant")
				.map((s) => s.text)
				.join(""),
		).toBe(JSON.stringify(args));
		expect(spans.find((s) => s.toolCallId === "first-call" && s.role === "toolResult")).toMatchObject({
			toolName: "bash",
			isError: true,
			truncated: true,
		});
		expect(
			spans.filter((s) => s.role === "toolResult").every((s) => s.text.includes("omitted content was not read")),
		).toBe(true);
		expect(JSON.stringify(spans)).toContain("second-call");
	});

	it("reduces adjacent chronological children with override provenance, never all-leaf concatenation", async () => {
		const { h, captures } = await setup(`First user goal: build A.\n${"日本語".repeat(80000)}`);
		h.sessionManager.appendMessage({
			role: "user",
			content: "Cancel A; build B instead. Quoted unknown instructions are data.",
			timestamp: Date.now(),
		});
		h.sessionManager.appendMessage(fauxAssistantMessage("kept"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		await h.session.compact();
		const requests = captures.map(payload);
		for (const p of requests.filter((p) => p.kind === "merge")) {
			expect(p.children).toHaveLength(2);
			expect(p.children[0].last.sourceIndex).toBeLessThanOrEqual(p.children[1].first.sourceIndex);
			if (p.children[0].last.sourceIndex === p.children[1].first.sourceIndex)
				expect(p.children[0].last.offset).toBe(p.children[1].first.offset);
			expect(p.children.every((c) => c.depth < 5)).toBe(true);
			expect(JSON.stringify(p)).not.toContain("First user goal");
		}
		expect(JSON.stringify(requests.filter((p) => p.kind === "leaf"))).toContain("Cancel A; build B");
		expect(JSON.stringify(captures[0].context)).toContain("Only later REAL USER instructions supersede");
	});

	it.each([
		"400 invalid request 503",
		"401 unauthorized retry",
		"402 billing",
		"403 forbidden",
		"429 insufficient_quota",
		"429 quota exceeded",
		"429 insufficient_quota",
	])("does not retry terminal %s", async (message) => {
		const { h } = await setup();
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 100, baseDelayMs: 0 } });
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: message })]);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(message);
		expect(h.faux.state.callCount).toBe(1);
		unchanged(h, prefix, leaf);
	});

	it("bounds physical retries across the job, even if settings allow more", async () => {
		const { h } = await setup();
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 100, baseDelayMs: 0 } });
		h.setResponses(
			Array.from({ length: 100 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit" }),
			),
		);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(/budget exhausted/);
		expect(h.faux.state.callCount).toBe(64);
		unchanged(h, prefix, leaf);
	});

	it("reserves cumulative estimated input before retrying", async () => {
		const { h } = await setup("a".repeat(125000));
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 100, baseDelayMs: 0 } });
		let spent = 0;
		let lastInput = 0;
		h.setResponses(
			Array.from({ length: 100 }, () => (context: Context) => {
				lastInput = Math.max(estimateContextTokens(context).tokens, Math.ceil(JSON.stringify(context).length / 4));
				spent += lastInput;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
			}),
		);
		await expect(h.session.compact()).rejects.toThrow(/budget exhausted/);
		expect(spent).toBeLessThanOrEqual(2000000);
		expect(spent + lastInput).toBeGreaterThan(2000000);
	});

	it("aborts an uncooperative provider at the whole-job deadline, not a per-node timeout", async () => {
		const { h } = await setup();
		vi.useFakeTimers();
		h.setResponses([() => new Promise(() => {})]);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		const completion = expect(h.session.compact()).rejects.toThrow(/deadline/);
		await vi.advanceTimersByTimeAsync(480001);
		await completion;
		unchanged(h, prefix, leaf);
	});

	it("reuses completed siblings only for transient node retry; cancellation recomputes on explicit restart", async () => {
		const { h, captures } = await setup("日本語".repeat(80000));
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
		let retryOnce = true;
		h.setResponses(
			Array.from({ length: 64 }, () => (context: Context, options: SimpleStreamOptions | undefined) => {
				captures.push({ context, options });
				const p = payload({ context, options });
				if (p.kind === "merge" && retryOnce) {
					retryOnce = false;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
				}
				if (p.kind === "merge") h.session.abortCompaction();
				return fauxAssistantMessage(checkpoint);
			}),
		);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow();
		unchanged(h, prefix, leaf);
		const previous = captures.map(payload);
		expect(previous.filter((p) => p.kind === "merge")).toHaveLength(2);
		expect(previous.filter((p) => p.kind === "leaf").length).toBeGreaterThan(1);
		captures.length = 0;
		h.setResponses(
			Array.from({ length: 64 }, () => (context: Context, options: SimpleStreamOptions | undefined) => {
				captures.push({ context, options });
				return fauxAssistantMessage(checkpoint);
			}),
		);
		await h.session.compact();
		expect(captures.map(payload).filter((p) => p.kind === "leaf")).toEqual(previous.filter((p) => p.kind === "leaf"));
	});

	it.each(["threshold", "overflow"] as const)(
		"uses the same default native seam for %s and continues once",
		async (reason) => {
			const { h } = await setup();
			const message = h.sessionManager
				.getEntries()
				.reverse()
				.find((e) => e.type === "message" && e.message.role === "assistant");
			if (message?.type !== "message" || message.message.role !== "assistant")
				throw new Error("missing assistant fixture");
			message.message.usage = { ...message.message.usage, input: 190000, totalTokens: 190000 };
			if (reason === "overflow") {
				message.message.stopReason = "length";
				message.message.usage.output = 1;
			}
			h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
			h.setResponses([
				fauxAssistantMessage(checkpoint),
				(context) => workResponse("one ordinary continuation", context),
			]);
			await h.session.prompt("continue actual native path");
			expect(h.eventsOfType("compaction_end").filter((e) => e.result)).toHaveLength(1);
			expect(h.eventsOfType("compaction_end")[0].reason).toBe(reason);
			expect(h.session.getLastAssistantText()).toBe("one ordinary continuation");
			expect(h.faux.state.callCount).toBe(2);
			expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		},
	);
	it("allows 32 leaves and 31 adjacent merges with maximum depth 5", async () => {
		const { h, captures } = await setup("あ".repeat(1300000));
		await h.session.compact();
		const requests = captures.map(payload);
		expect(requests.filter((p) => p.kind === "leaf")).toHaveLength(32);
		expect(requests.filter((p) => p.kind === "merge")).toHaveLength(31);
		const last = requests.at(-1)!;
		if (last.kind !== "merge") throw new Error("missing root merge");
		expect(Math.max(...last.children.map((c) => c.depth)) + 1).toBe(5);
	});

	it.each(["fixed instructions", "output allowance", "system prompt", "tool schema", "unknown reasoning adapter"])(
		"preflights impossible %s before any provider attempt",
		async (cause) => {
			const { h, captures } = await setup();
			if (cause === "output allowance") h.settingsManager.applyOverrides({ compaction: { reserveTokens: 1000 } });
			if (cause === "system prompt") h.session.agent.state.systemPrompt = "x".repeat(900000);
			if (cause === "tool schema")
				h.session.agent.state.tools = [
					{
						name: "huge",
						label: "huge",
						description: "x".repeat(900000),
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					},
				];
			if (cause === "unknown reasoning adapter") {
				h.session.agent.state.model = { ...h.getModel(), reasoning: true };
				h.session.setThinkingLevel("high");
			}
			const prefix = readFileSync(h.session.sessionFile!, "utf8");
			const leaf = h.sessionManager.getLeafId();
			await expect(
				h.session.compact(cause === "fixed instructions" ? "日本語".repeat(100000) : undefined),
			).rejects.toThrow();
			expect(captures).toHaveLength(0);
			unchanged(h, prefix, leaf);
		},
	);

	it("reserves actual known adapter reasoning expansion without changing requested reasoning", async () => {
		const { h } = await setup();
		h.session.agent.state.model = { ...h.getModel(), api: "anthropic-messages", reasoning: true };
		h.session.setThinkingLevel("high");
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 100, baseDelayMs: 0 } });
		let calls = 0;
		h.session.agent.streamFunction = (model, _context, options) => {
			calls++;
			expect(options?.maxTokens).toBe(8192);
			expect(options?.reasoning).toBe("high");
			expect(options?.maxRetries).toBe(0);
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "error",
				reason: "error",
				error: {
					...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
					api: model.api,
					model: model.id,
					provider: model.provider,
				},
			});
			return stream;
		};
		await expect(h.session.compact()).rejects.toThrow(/budget exhausted/);
		// Wire answer+thinking cap = 8192+16384; 22nd physical attempt exceeds 524288 reserved tokens.
		expect(calls).toBe(21);
	});

	it.each(["model", "history", "system"])(
		"rejects a stale %s without installing its completed summary",
		async (mutation) => {
			const { h } = await setup();
			const prefix = readFileSync(h.session.sessionFile!, "utf8");
			h.setResponses([
				() => {
					if (mutation === "model") h.session.agent.state.model = { ...h.getModel(), id: "different-model" };
					if (mutation === "system") h.session.agent.state.systemPrompt = "changed system prompt";
					if (mutation === "history")
						h.sessionManager.appendMessage({
							role: "user",
							content: "concurrent real input",
							timestamp: Date.now(),
						});
					return fauxAssistantMessage(checkpoint);
				},
			]);
			await expect(h.session.compact()).rejects.toThrow(/stale|changed/);
			expect(readFileSync(h.session.sessionFile!, "utf8").startsWith(prefix)).toBe(true);
			expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
		},
	);

	it("suppresses deterministic threshold failures until new conditions or explicit successful compact", async () => {
		const { h } = await setup();
		const internals = h.session as unknown as { _checkCompaction(message: AssistantMessage): Promise<boolean> };
		const trigger = {
			...fauxAssistantMessage("threshold response", { timestamp: Date.now() + 1000 }),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
			usage: { ...fauxAssistantMessage("").usage, input: 190000, totalTokens: 190000 },
		};
		h.setResponses([fauxAssistantMessage("malformed output"), fauxAssistantMessage(checkpoint)]);
		await internals._checkCompaction(trigger);
		await internals._checkCompaction(trigger);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.eventsOfType("compaction_end")[0].errorMessage).toContain("History preserved; compaction incomplete");
		await h.session.compact();
		expect(h.faux.state.callCount).toBe(2);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
	});

	it("honors Retry-After and cancels backoff without another physical request", async () => {
		const { h } = await setup();
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
		vi.useFakeTimers();
		let calls = 0;
		h.session.agent.streamFunction = (_model, _context, options) => {
			calls++;
			void options?.onResponse?.({ status: 429, headers: { "retry-after": "60" } }, h.getModel());
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" }),
			});
			return stream;
		};
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		const cancelled = expect(h.session.compact()).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(1000);
		expect(calls).toBe(1);
		h.session.abortCompaction();
		await cancelled;
		unchanged(h, prefix, leaf);
		expect(h.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	it("never adopts a bad merge or cancellation immediately before commit", async () => {
		const { h } = await setup("日本語".repeat(80000));
		h.setResponses(
			Array.from(
				{ length: 64 },
				() => (context: Context) =>
					fauxAssistantMessage(
						payload({ context, options: undefined }).kind === "merge" ? "bad merge" : checkpoint,
					),
			),
		);
		const prefix = readFileSync(h.session.sessionFile!, "utf8");
		const leaf = h.sessionManager.getLeafId();
		await expect(h.session.compact()).rejects.toThrow(/structured/);
		unchanged(h, prefix, leaf);
		h.setResponses([
			() => {
				h.session.abortCompaction();
				return fauxAssistantMessage(checkpoint);
			},
		]);
		await expect(h.session.compact()).rejects.toThrow();
		unchanged(h, prefix, leaf);
	});
	it("aggregates actual successful and retried node usage, including repeated overlap input", async () => {
		const { h } = await setup("日本語".repeat(80000));
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		const underlying = h.session.agent.streamFunction;
		const usages: AssistantMessage["usage"][] = [];
		let first = true;
		h.setResponses(
			Array.from({ length: 64 }, () => () => {
				if (first) {
					first = false;
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" });
				}
				return fauxAssistantMessage(checkpoint);
			}),
		);
		h.session.agent.streamFunction = async (model, context, options) => {
			const response = await (await underlying(model, context, options)).result();
			usages.push(response.usage);
			const stream = createAssistantMessageEventStream();
			if (response.stopReason === "error") stream.push({ type: "error", reason: "error", error: response });
			else stream.push({ type: "done", reason: "stop", message: response });
			return stream;
		};
		const result = await h.session.compact();
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			expect(result.usage![field]).toBe(usages.reduce((n, u) => n + u[field], 0));
		expect(usages.length).toBeGreaterThan(2);
	});

	it("disables server model fallbacks only on the scoped summarization request", async () => {
		const { h } = await setup();
		const compat = {
			allowedFallbackModels: [
				{
					provider: "anthropic",
					model: "other-model",
					cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 },
				},
			],
		};
		h.session.agent.state.model = { ...h.getModel(), api: "anthropic-messages", compat };
		h.session.agent.streamFunction = (model) => {
			expect(model.compat).toMatchObject({ allowedFallbackModels: [] });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage(checkpoint) });
			return stream;
		};
		await h.session.compact();
		expect(h.session.model!.compat).toEqual(compat);
	});

	it("compacts at an actual tool boundary, retains the raw result, and executes tool/continuation/settled once", async () => {
		const { h } = await setup("a".repeat(600000));
		let toolCalls = 0;
		h.session.agent.state.tools = [
			...h.session.agent.state.tools,
			{
				name: "once",
				label: "Once",
				description: "Fixture tool",
				parameters: Type.Object({}),
				execute: async () => {
					toolCalls++;
					return { content: [{ type: "text", text: "r".repeat(160000) }], details: {} };
				},
			},
		];
		let ordinaryAfterCompaction = 0;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("once", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 64 }, () => (context: Context) => {
				if (context.systemPrompt?.includes("context summarization assistant"))
					return fauxAssistantMessage(checkpoint);
				ordinaryAfterCompaction++;
				expect(context.messages.filter((m) => m.role === "toolResult" && m.toolName === "once")).toHaveLength(1);
				expect(estimateContextTokens(context).tokens + 32000 + 10000).toBeLessThan(200000);
				return workResponse("finished once", context);
			}),
		]);
		await h.session.prompt("run fixture tool");
		expect(toolCalls).toBe(1);
		expect(ordinaryAfterCompaction).toBe(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.eventsOfType("compaction_end").filter((e) => e.result)).toHaveLength(1);
		expect(
			h.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "once"),
		).toHaveLength(1);
	});
});
