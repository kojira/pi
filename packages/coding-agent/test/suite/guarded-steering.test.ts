import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

function barrier<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
async function create() {
	const h = await createHarness({ settings: { compaction: { enabled: false }, retry: { enabled: false } } });
	harnesses.push(h);
	return h;
}
function runId(h: Harness): string {
	const event = h.eventsOfType("agent_start").at(-1);
	expect(event).toHaveProperty("runId", expect.any(String));
	return event!.runId!;
}

describe("guarded steering admission", () => {
	it("closes admission in the same synchronous boundary as the final empty-queue check", async () => {
		const h = await create();
		h.setResponses([workResponse("complete")]);
		const checked = barrier();
		let late: Promise<unknown> | undefined;
		const original = h.session.agent.hasQueuedMessages.bind(h.session.agent);
		h.session.agent.hasQueuedMessages = () => {
			const queued = original();
			if (!queued)
				queueMicrotask(() => {
					late = h.session.steerIfActive("after final check", runId(h));
					checked.resolve();
				});
			return queued;
		};
		await h.session.prompt("initial");
		await checked.promise;
		expect(await late).toEqual({ accepted: false, reason: "run_not_accepting" });
		expect(h.session.pendingMessageCount).toBe(0);
	});

	it("binds starts and delayed settlements to distinct session runs without changing legacy idle queues", async () => {
		const idle = barrier();
		const release = barrier();
		let first = true;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (first) {
							first = false;
							idle.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([workResponse("first"), workResponse("second")]);
		const firstRun = h.session.prompt("initial");
		await idle.promise;
		const id = runId(h);
		try {
			expect(await h.session.steerIfActive("late", id)).toEqual({ accepted: false, reason: "run_not_accepting" });
			expect(h.session.pendingMessageCount).toBe(0);
			await h.session.prompt("next");
			expect(runId(h)).not.toBe(id);
		} finally {
			release.resolve();
			await firstRun;
		}
		expect(h.eventsOfType("agent_settled").map((e) => e.runId)).toEqual([runId(h), id]);
		expect(getUserTexts(h)).toEqual(["initial", "next"]);
		await h.session.steer("legacy idle");
		expect(h.session.pendingMessageCount).toBe(1);
	});

	it("accepts during inference and immediately after finish, preserves tool results and consumes each input once", async () => {
		let executions = 0;
		const h = await createHarness({
			tools: [
				{
					name: "effect",
					label: "Effect",
					description: "Effect",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "stored" }], details: {} };
					},
				},
			],
		});
		harnesses.push(h);
		const started = barrier();
		const release = barrier();
		h.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage(fauxToolCall("effect", {}), { stopReason: "toolUse" });
			},
			workResponse("same"),
			workResponse("same"),
			workResponse("next"),
		]);
		let afterFinish: Promise<unknown> | undefined;
		h.session.subscribe((e) => {
			if (!afterFinish && e.type === "work_contract" && e.record.status === "resolved") {
				afterFinish = h.session.steerIfActive("after finish", runId(h));
			}
		});
		const prompt = h.session.prompt("initial");
		await started.promise;
		const id = runId(h);
		expect(await h.session.steerIfActive("during inference", id)).toEqual({ accepted: true });
		release.resolve();
		await prompt;
		expect(await afterFinish).toEqual({ accepted: true });
		expect(getUserTexts(h)).toEqual(["initial", "during inference", "after finish"]);
		expect(h.session.pendingMessageCount).toBe(0);
		expect(executions).toBe(1);
		expect(h.eventsOfType("work_contract").filter((e) => e.record.status === "resolved")).toHaveLength(2);
		const prefix = JSON.stringify(h.sessionManager.getEntries());
		const length = h.sessionManager.getEntries().length;
		await h.session.prompt("next");
		expect(JSON.stringify(h.sessionManager.getEntries().slice(0, length))).toBe(prefix);
		expect(executions).toBe(1);
		expect(h.eventsOfType("agent_settled")[0].runId).toBe(id);
	});

	it.each(["accept", "decline", "throw"] as const)(
		"does not duplicate recipient %s across a run change",
		async (outcome) => {
			const h = await create();
			const started = barrier();
			const finish = barrier();
			const routed = barrier();
			const route = barrier();
			h.setResponses([
				async (ctx) => {
					started.resolve();
					await finish.promise;
					return workResponse("first", ctx);
				},
				workResponse("second"),
			]);
			const prompt = h.session.prompt("initial");
			await started.promise;
			const pop = h.session.pushSteeringRecipient({
				steer: async () => {
					routed.resolve();
					await route.promise;
					if (outcome === "throw") throw new Error("uncertain");
					return outcome === "accept";
				},
			});
			const steering = h.session.steerIfActive("recipient input", runId(h));
			const result = steering.then(
				(value) => value,
				(error: Error & { errorCode: string }) => error.errorCode,
			);
			await routed.promise;
			finish.resolve();
			await prompt;
			pop();
			await h.session.prompt("next");
			route.resolve();
			expect(await result).toEqual(
				outcome === "accept"
					? { accepted: true }
					: outcome === "decline"
						? { accepted: false, reason: "run_not_accepting" }
						: "STEER_DELIVERY_UNCERTAIN",
			);
			expect(h.eventsOfType("steering_consumed")).toHaveLength(outcome === "accept" ? 1 : 0);
			expect(getUserTexts(h)).toEqual(["initial", "next"]);
			expect(h.session.pendingMessageCount).toBe(0);
		},
	);

	it("rechecks abort after recipient decline and rejects new guarded input without clearing existing input", async () => {
		const h = await create();
		const started = barrier();
		const release = barrier();
		const routed = barrier();
		const decline = barrier();
		h.setResponses([
			async (ctx) => {
				started.resolve();
				await release.promise;
				return workResponse("interrupted", ctx);
			},
		]);
		const prompt = h.session.prompt("initial");
		await started.promise;
		const id = runId(h);
		expect(await h.session.steerIfActive("accepted before abort", id)).toEqual({ accepted: true });
		h.session.pushSteeringRecipient({
			steer: async () => {
				routed.resolve();
				await decline.promise;
				return false;
			},
		});
		const steering = h.session.steerIfActive("declined", id);
		await routed.promise;
		const aborted = h.session.abort();
		decline.resolve();
		expect(await steering).toEqual({ accepted: false, reason: "run_not_accepting" });
		expect(await h.session.steerIfActive("after abort", id)).toEqual({
			accepted: false,
			reason: "run_not_accepting",
		});
		release.resolve();
		await Promise.all([prompt, aborted]);
		expect(h.session.getSteeringMessages()).toEqual(["accepted before abort"]);
		expect(getUserTexts(h)).toEqual(["initial"]);
	});

	it("preserves run identity through automatic compaction", async () => {
		const h = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("partial", { stopReason: "length" }), workResponse("complete")]);
		await h.session.prompt("x".repeat(5000));
		expect(h.eventsOfType("compaction_end").at(-1)).toMatchObject({ willRetry: true, aborted: false });
		const ids = h.eventsOfType("agent_start").map((e) => e.runId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(1);
		expect(h.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", runId: ids[0] }]);
	});

	it("falls back exactly once when a recipient explicitly declines during the same active run", async () => {
		const h = await create();
		const started = barrier();
		const release = barrier();
		h.setResponses([
			async (ctx) => {
				started.resolve();
				await release.promise;
				return workResponse("first", ctx);
			},
			workResponse("second"),
		]);
		const prompt = h.session.prompt("initial");
		await started.promise;
		let routed = 0;
		const pop = h.session.pushSteeringRecipient({
			steer: async () => {
				routed++;
				return false;
			},
		});
		expect(await h.session.steerIfActive("declined", runId(h))).toEqual({ accepted: true });
		pop();
		release.resolve();
		await prompt;
		expect(routed).toBe(1);
		expect(getUserTexts(h)).toEqual(["initial", "declined"]);
		expect(h.session.pendingMessageCount).toBe(0);
	});

	it("keeps retry in one run and closes admission on provider failure", async () => {
		const h = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(h);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			workResponse("retried"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid request" }),
		]);
		await h.session.prompt("retry");
		const ids = h.eventsOfType("agent_start").map((e) => e.runId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(1);
		expect(ids[0]).toEqual(expect.any(String));
		await h.session.prompt("failure");
		expect(await h.session.steerIfActive("late", runId(h))).toEqual({ accepted: false, reason: "run_not_accepting" });
		expect(h.session.pendingMessageCount).toBe(0);
	});
});
