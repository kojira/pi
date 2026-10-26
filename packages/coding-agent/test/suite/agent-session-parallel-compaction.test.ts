import { readFileSync } from "node:fs";
import {
	type AssistantMessage,
	type Context,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateSummaryTextTokens, generateBoundedSummary } from "../../src/core/compaction/bounded-compaction.ts";
import { createHarness, type Harness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

const checkpoint =
	"## Goal\nContinue.\n## Constraints & Preferences\nKeep history.\n## Progress\n### Done\nFixture.\n### In Progress\nTask.\n### Blocked\nNone.\n## Key Decisions\nKeep order.\n## Next Steps\nContinue.\n## Critical Context\nReferences.";

interface Payload {
	kind: "leaf" | "merge";
	owned?: { sourceIndex: number; text: string }[];
	children?: { text: string; first: { sourceIndex: number }; last: { sourceIndex: number } }[];
}
function payload(context: Context): Payload {
	const message = context.messages[0];
	if (message.role !== "user" || typeof message.content !== "string") throw new Error("expected source request");
	return JSON.parse(message.content.split("\n<source-data>\n")[1].split("\n</source-data>")[0]) as Payload;
}

interface Pending {
	payload: Payload;
	signal: AbortSignal;
	options: SimpleStreamOptions;
	resolve: (message: AssistantMessage) => void;
	reject: (error: Error) => void;
}

describe("AgentSession parallel bounded compaction", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		for (const h of harnesses.splice(0)) h.cleanup();
	});

	async function setup(size = 360000, contextWindow = 200000) {
		const h = await createHarness({
			persistent: true,
			models: [{ id: "parallel", contextWindow, maxTokens: 32000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } },
		});
		harnesses.push(h);
		for (let i = 0; i < 4; i++) {
			h.sessionManager.appendMessage({
				role: "user",
				content: `${i}: ${"a".repeat(size)}`,
				timestamp: Date.now() - 1000,
			});
		}
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("retained"),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		return h;
	}

	function controlled(h: Harness): Pending[] {
		const pending: Pending[] = [];
		h.setResponses(
			Array.from(
				{ length: 10 },
				() => (context: Context, options: SimpleStreamOptions | undefined) =>
					new Promise<AssistantMessage>((resolve, reject) => {
						pending.push({
							payload: payload(context),
							signal: options!.signal!,
							options: options!,
							resolve,
							reject,
						});
					}),
			),
		);
		return pending;
	}

	function unchanged(h: Harness, before: string) {
		expect(readFileSync(h.session.sessionFile!, "utf8")).toBe(before);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
	}

	it("overlaps only two leaves, admits on completion, and merges in source order after the barrier", async () => {
		const h = await setup();
		vi.useFakeTimers();
		const pending = controlled(h);
		const before = readFileSync(h.session.sessionFile!, "utf8");
		const completion = h.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(2);
		for (const index of [1, 2, 3]) {
			pending[index].resolve(fauxAssistantMessage(checkpoint.replace("References.", `leaf-${index}`)));
			await vi.advanceTimersByTimeAsync(0);
			expect(pending).toHaveLength(Math.min(index + 2, 4));
			expect(pending.every((p) => p.payload.kind === "leaf")).toBe(true);
		}
		unchanged(h, before);
		pending[0].resolve(fauxAssistantMessage(checkpoint.replace("References.", "leaf-0")));
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(5);
		expect(pending[4].payload.kind).toBe("merge");
		expect(pending[4].payload.children?.map((c) => c.first.sourceIndex)).toEqual([0, 1, 2, 3]);
		expect(pending[4].payload.children?.map((c) => c.text.split("\n").at(-1))).toEqual([
			"leaf-0",
			"leaf-1",
			"leaf-2",
			"leaf-3",
		]);
		pending[4].resolve(fauxAssistantMessage(checkpoint));
		expect(await completion).toMatchObject({ summary: checkpoint });
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
		expect(readFileSync(h.session.sessionFile!, "utf8").startsWith(before)).toBe(true);
	});

	it("finishes slow four leaves and merge inside eight minutes where the serial baseline cannot", async () => {
		const h = await setup();
		vi.useFakeTimers();
		// Latency metadata only; no private source content. Serial needs 494641ms.
		const durations = [124145, 126159, 126933, 77404, 40000];
		expect(durations.reduce((a, b) => a + b, 0)).toBeGreaterThan(480000);
		const starts: number[] = [];
		const completed: number[] = [];
		const requests: Payload[] = [];
		const start = Date.now();
		h.setResponses(
			durations.map((duration, i) => (context: Context) => {
				starts.push(Date.now() - start);
				requests.push(payload(context));
				return new Promise<AssistantMessage>((resolve) =>
					setTimeout(() => {
						completed.push(i);
						resolve(fauxAssistantMessage(checkpoint));
					}, duration),
				);
			}),
		);
		let finishedAt = 0;
		const completion = h.session
			.compact()
			.then((result) => {
				finishedAt = Date.now() - start;
				return result;
			})
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(480000);
		expect(await completion).toMatchObject({ summary: checkpoint });
		expect(finishedAt).toBe(291078);
		expect(starts).toEqual([0, 0, 124145, 126159, 251078]);
		expect(completed).toEqual([0, 1, 3, 2, 4]);
		expect(requests.map((p) => p.kind)).toEqual(["leaf", "leaf", "leaf", "leaf", "merge"]);
		expect(h.eventsOfType("compaction_end")[0].result).toBeDefined();
		h.setResponses([(context) => workResponse("safe next request", context)]);
		const prompt = h.session.prompt("continue");
		await vi.advanceTimersByTimeAsync(0);
		await prompt;
		expect(h.session.getLastAssistantText()).toBe("safe next request");
	});

	it.each(["failure", "abort", "deadline"] as const)(
		"cancels both workers on %s, observes late results, and never appends",
		async (mode) => {
			const h = await setup();
			vi.useFakeTimers();
			const pending = controlled(h);
			const before = readFileSync(h.session.sessionFile!, "utf8");
			const completion = h.session.compact().catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(0);
			expect(pending).toHaveLength(2);
			if (mode === "failure") pending[1].resolve(fauxAssistantMessage("invalid structured checkpoint"));
			else if (mode === "abort") h.session.abortCompaction();
			else await vi.advanceTimersByTimeAsync(480000);
			expect(await completion).toMatchObject({
				message: expect.stringMatching(
					mode === "failure" ? /structured/ : mode === "deadline" ? /8-minute deadline/ : /abort/i,
				),
			});
			expect(pending.every((p) => p.signal.aborted)).toBe(true);
			unchanged(h, before);
			pending[0].reject(new Error("late sibling transport error"));
			pending[1].resolve(fauxAssistantMessage(checkpoint));
			await vi.advanceTimersByTimeAsync(1000000);
			expect(pending).toHaveLength(2);
			unchanged(h, before);
			expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it.each(["attempt", "input", "output"] as const)(
		"reserves the shared %s budget before every concurrent 429 retry",
		async (limit) => {
			const h = await setup(
				limit === "input" ? 360000 : limit === "output" ? 100000 : 70000,
				limit === "attempt" ? 50000 : 200000,
			);
			h.settingsManager.applyOverrides({
				compaction: { reserveTokens: limit === "output" ? 16384 : 2048 },
				retry: { enabled: true, maxRetries: 100, baseDelayMs: 0 },
			});
			vi.useFakeTimers();
			let input = 0;
			let output = 0;
			let lastInput = 0;
			const starts: number[] = [];
			const signals: AbortSignal[] = [];
			h.setResponses(
				Array.from({ length: 100 }, () => (context: Context, options: SimpleStreamOptions | undefined) => {
					starts.push(Date.now());
					signals.push(options!.signal!);
					lastInput = estimateSummaryTextTokens(JSON.stringify(context));
					input += lastInput;
					output += options!.maxTokens!;
					expect(options!.maxRetries).toBe(0);
					// The large first leaf succeeds; the small sibling exhausts output through retries.
					if (limit === "output" && starts.length === 1) return fauxAssistantMessage(checkpoint);
					void options!.onResponse?.({ status: 429, headers: { "retry-after": "1" } }, h.getModel());
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" });
				}),
			);
			const before = readFileSync(h.session.sessionFile!, "utf8");
			const completion = h.session.compact().catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(999);
			if (starts.length === 0) throw await completion;
			expect(starts).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(100000);
			expect(await completion).toMatchObject({ message: expect.stringContaining("budget exhausted") });
			expect(starts.length).toBeLessThanOrEqual(64);
			expect(input).toBeLessThanOrEqual(2000000);
			expect(output).toBeLessThanOrEqual(524288);
			if (limit === "attempt") expect(starts).toHaveLength(64);
			if (limit === "input") expect(input + lastInput).toBeGreaterThan(2000000);
			if (limit === "output") expect(starts).toHaveLength(Math.floor(524288 / 13107));
			expect(signals.every((s) => s.aborted)).toBe(true);
			unchanged(h, before);
		},
	);

	it("cancels parallel Retry-After backoff and an in-flight sibling without admitting retries", async () => {
		const h = await setup();
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });
		vi.useFakeTimers();
		const pending = controlled(h);
		const before = readFileSync(h.session.sessionFile!, "utf8");
		const completion = h.session.compact().catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(0);
		expect(pending).toHaveLength(2);
		void pending[0].options.onResponse?.({ status: 429, headers: { "retry-after": "60" } }, h.getModel());
		pending[0].resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.eventsOfType("summarization_retry_scheduled")[0].delayMs).toBe(60000);
		expect(pending).toHaveLength(2);
		h.session.abortCompaction();
		expect(await completion).toMatchObject({ name: "AbortError" });
		pending[1].resolve(fauxAssistantMessage(checkpoint));
		await vi.advanceTimersByTimeAsync(480000);
		expect(pending).toHaveLength(2);
		expect(pending.every((p) => p.signal.aborted)).toBe(true);
		unchanged(h, before);
	});

	it("observes a provider promise rejected after synchronous cancellation at dispatch", async () => {
		const h = await setup();
		const before = readFileSync(h.session.sessionFile!, "utf8");
		let calls = 0;
		h.session.agent.streamFunction = () => {
			calls++;
			h.session.abortCompaction();
			return Promise.reject(new Error("late dispatch failure"));
		};
		await expect(h.session.compact()).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toBe(1);
		unchanged(h, before);
	});

	it.each(["onRetryScheduled", "onRetryAttemptStart", "onRetryFinished"] as const)(
		"keeps the absolute deadline while a parallel worker waits on %s",
		async (callback) => {
			const h = await setup();
			vi.useFakeTimers();
			h.setResponses(
				Array.from({ length: 8 }, (_, i) =>
					fauxAssistantMessage(
						i < 2 ? "" : checkpoint,
						i < 2 ? { stopReason: "error", errorMessage: "429 rate limited" } : {},
					),
				),
			);
			const completion = generateBoundedSummary(
				Array.from({ length: 4 }, (_, sourceIndex) => ({
					sourceIndex,
					blockIndex: 0,
					role: "user",
					text: "a".repeat(360000),
					format: "prose" as const,
				})),
				{
					model: h.getModel(),
					reserveTokens: 16384,
					streamFn: h.session.agent.streamFunction,
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
					callbacks: { [callback]: () => new Promise<void>(() => {}) },
				},
			).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(480000);
			expect(await completion).toMatchObject({ message: expect.stringContaining("8-minute deadline exceeded") });
			expect(h.faux.state.callCount).toBe(callback === "onRetryFinished" ? 4 : 2);
		},
	);

	it("preserves the first native deadline cause through the unsafe prompt and suppression gates", async () => {
		const h = await setup();
		const last = h.session.agent.state.messages.at(-1)!;
		if (last.role !== "assistant") throw new Error("missing assistant");
		last.usage = { ...last.usage, input: 190000, totalTokens: 190000 };
		vi.useFakeTimers();
		const pending = controlled(h);
		const before = readFileSync(h.session.sessionFile!, "utf8");
		const completion = h.session.prompt("unsubmitted intent").catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(480000);
		expect(await completion).toMatchObject({
			message: expect.stringContaining("8-minute deadline exceeded"),
			cause: expect.objectContaining({ message: expect.stringContaining("8-minute deadline exceeded") }),
		});
		await expect(h.session.prompt("still unsubmitted")).rejects.toThrow(/8-minute deadline exceeded/);
		expect(pending).toHaveLength(2);
		expect(h.eventsOfType("compaction_end")).toHaveLength(1);
		unchanged(h, before);
	});
});
