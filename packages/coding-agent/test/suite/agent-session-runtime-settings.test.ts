import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardedPromptRefusal } from "../../src/core/agent-session.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { workResponse } from "./work-response.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("AgentSession guarded runtime settings", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const h of harnesses.splice(0)) h.cleanup();
	});
	async function setup(options: HarnessOptions = {}) {
		const h = await createHarness({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			...options,
		});
		harnesses.push(h);
		return h;
	}
	function update(h: Harness) {
		return {
			provider: h.getModel().provider,
			modelId: "second",
			thinkingLevel: "high" as const,
			expectedRevision: h.session.settingsRevision,
		};
	}

	it("commits model/thinking/revision together before notifying observers and retains omitted fields", async () => {
		const h = await setup();
		const request = update(h);
		let observed = false;
		h.session.subscribe((event) => {
			if (event.type !== "thinking_level_changed") return;
			observed = true;
			expect(h.session.model?.id).toBe("second");
			expect(h.session.thinkingLevel).toBe("high");
			expect(h.session.settingsRevision).toBeGreaterThan(request.expectedRevision);
		});
		const result = await h.session.setRuntimeSettings(request);
		expect(result).toEqual({
			applied: true,
			settingsRevision: h.session.settingsRevision,
			model: { provider: h.getModel().provider, id: "second" },
			thinkingLevel: "high",
		});
		expect(observed).toBe(true);
		const revision = h.session.settingsRevision;
		expect(await h.session.setRuntimeSettings({ expectedRevision: revision })).toEqual(result);
		expect(h.session.settingsRevision).toBe(revision);
		expect(await h.session.setRuntimeSettings(request)).toEqual({ applied: false, reason: "revision_changed" });
	});

	it("advances revision for ordinary model/thinking/cycle changes, including ABA changes", async () => {
		const h = await setup();
		let revision = h.session.settingsRevision;
		for (const level of ["high", "off"] as const) {
			h.session.setThinkingLevel(level);
			expect(h.session.settingsRevision).toBeGreaterThan(revision);
			revision = h.session.settingsRevision;
		}
		await h.session.setModel(h.getModel("second")!);
		expect(h.session.settingsRevision).toBeGreaterThan(revision);
		revision = h.session.settingsRevision;
		await h.session.cycleModel();
		expect(h.session.settingsRevision).toBeGreaterThan(revision);
	});

	it.each(["abort", "dispose", "revision", "activity"] as const)(
		"rejects %s during pending auth without mutating the pair",
		async (mutation) => {
			const h = await setup();
			const gate = deferred();
			const auth = await h.session.modelRuntime.checkAuth(h.getModel().provider);
			vi.spyOn(h.session.modelRuntime, "checkAuth").mockImplementation(async () => {
				await gate.promise;
				return auth;
			});
			const request = update(h);
			const pending = h.session.setRuntimeSettings(request);
			if (mutation === "abort") await h.session.abort();
			if (mutation === "dispose") h.session.dispose();
			if (mutation === "revision") h.session.setThinkingLevel("low");
			if (mutation === "activity") {
				h.setResponses([(context) => workResponse("ordinary work continues", context)]);
				await h.session.prompt("while auth waits");
			}
			gate.resolve();
			expect(await pending).toEqual({
				applied: false,
				reason: mutation === "revision" ? "revision_changed" : "busy",
			});
			expect(h.session.model?.id).toBe("first");
			expect(h.session.thinkingLevel).not.toBe("high");
		},
	);

	it("does not hold a settings lock through model-select hooks", async () => {
		const gate = deferred();
		const began = deferred();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async () => {
						began.resolve();
						await gate.promise;
					});
				},
			],
		});
		const pending = h.session.setRuntimeSettings(update(h));
		await began.promise;
		h.setResponses([(context) => workResponse("hook can run parent work", context)]);
		await h.session.prompt("continue", { expectedSettingsRevision: h.session.settingsRevision });
		gate.resolve();
		expect(await pending).toMatchObject({ applied: true });
	});

	it("marks prompt preflight busy before the first hook await without changing isIdle", async () => {
		const gate = deferred();
		const began = deferred();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						began.resolve();
						await gate.promise;
						return { action: "continue" };
					});
				},
			],
		});
		h.setResponses([(context) => workResponse("done", context)]);
		const pending = h.session.prompt("held preflight");
		await began.promise;
		expect(h.session.isIdle).toBe(true);
		expect(await h.session.setRuntimeSettings(update(h))).toEqual({ applied: false, reason: "busy" });
		await expect(
			h.session.prompt("not admitted", { expectedSettingsRevision: h.session.settingsRevision }),
		).rejects.toMatchObject({ reason: "busy" });
		gate.resolve();
		await pending;
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
	});

	it("marks manual compact admission busy before its abort await", async () => {
		const h = await setup();
		const gate = deferred();
		vi.spyOn(h.session, "abort").mockImplementation(() => gate.promise);
		const compact = h.session.compact().catch((error: unknown) => error);
		expect(h.session.isCompacting).toBe(false);
		expect(await h.session.setRuntimeSettings(update(h))).toEqual({ applied: false, reason: "busy" });
		gate.resolve();
		expect(await compact).toBeInstanceOf(Error);
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
	});

	it("marks automatic compaction busy while auth is still awaiting", async () => {
		const h = await setup();
		const gate = deferred();
		const began = deferred();
		const auth = await h.session.modelRuntime.getAuth(h.getModel());
		vi.spyOn(h.session.modelRuntime, "getAuth").mockImplementation(async () => {
			began.resolve();
			await gate.promise;
			return auth;
		});
		const internals = h.session as unknown as {
			_runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
		};
		const compaction = internals._runAutoCompaction("threshold", false);
		await began.promise;
		expect(h.session.isCompacting).toBe(false);
		expect(await h.session.setRuntimeSettings(update(h))).toEqual({ applied: false, reason: "busy" });
		gate.resolve();
		await compaction;
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
	});

	it("keeps guarded settings busy through automatic retry backoff", async () => {
		const h = await setup({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 60000 } },
		});
		vi.useFakeTimers();
		h.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" })]);
		const prompt = h.session.prompt("retry");
		await vi.advanceTimersByTimeAsync(0);
		expect(h.session.isRetrying).toBe(true);
		expect(await h.session.setRuntimeSettings(update(h))).toEqual({ applied: false, reason: "busy" });
		await h.session.abort();
		await prompt;
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
	});

	it("refuses pending parent queues without consuming them or touching independent children", async () => {
		const h = await setup();
		const child = await setup();
		const childRevision = child.session.settingsRevision;
		const gate = deferred();
		const began = deferred();
		child.setResponses([
			async (context) => {
				began.resolve();
				await gate.promise;
				return workResponse("child complete", context);
			},
		]);
		const childRun = child.session.prompt("independent child work");
		await began.promise;
		const pop = h.session.pushSteeringRecipient({ steer: async () => true });
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
		expect(child.session.settingsRevision).toBe(childRevision);
		expect(child.session.model?.id).toBe("first");
		expect(child.session.isStreaming).toBe(true);
		gate.resolve();
		await childRun;
		await h.session.followUp("pending input");
		expect(
			await h.session.setRuntimeSettings({ expectedRevision: h.session.settingsRevision, thinkingLevel: "low" }),
		).toEqual({ applied: false, reason: "busy" });
		await expect(
			h.session.prompt("not queued", { expectedSettingsRevision: h.session.settingsRevision }),
		).rejects.toBeInstanceOf(GuardedPromptRefusal);
		expect(h.session.getFollowUpMessages()).toEqual(["pending input"]);
		pop();
	});

	it.each(["input", "before_agent_start"] as const)(
		"does not claim nonacceptance after effectful %s changes settings",
		async (event) => {
			let calls = 0;
			const h = await setup({
				extensionFactories: [
					(pi) => {
						const changeSettings = () => {
							calls++;
							pi.setThinkingLevel("high");
						};
						if (event === "input") pi.on("input", changeSettings);
						else pi.on("before_agent_start", changeSettings);
					},
				],
			});
			const before = h.sessionManager.getEntries();
			const revision = h.session.settingsRevision;
			await expect(h.session.prompt("effectful", { expectedSettingsRevision: revision })).rejects.toThrow(
				/after guarded prompt admission/,
			);
			expect(calls).toBe(1);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.sessionManager.getEntries().filter((e) => e.type === "message")).toEqual(
				before.filter((e) => e.type === "message"),
			);
			await expect(h.session.prompt("stale", { expectedSettingsRevision: revision })).rejects.toMatchObject({
				reason: "settings_changed",
			});
			expect(calls).toBe(1);
		},
	);

	it("rejects stale revisions across session replacement and before any input hook", async () => {
		const original = await setup();
		const revision = original.session.settingsRevision;
		original.session.dispose();
		const replacement = await setup();
		expect(replacement.session.settingsRevision).toBeGreaterThan(revision);
		await expect(replacement.session.prompt("stale", { expectedSettingsRevision: revision })).rejects.toMatchObject({
			reason: "settings_changed",
		});
		expect(replacement.faux.state.callCount).toBe(0);
	});

	it("rejects settings changes throughout branch navigation", async () => {
		const gate = deferred();
		const began = deferred();
		const h = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						began.resolve();
						await gate.promise;
					});
				},
			],
		});
		const target = h.sessionManager.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		h.sessionManager.appendMessage(fauxAssistantMessage("current"));
		const navigation = h.session.navigateTree(target);
		await began.promise;
		expect(await h.session.setRuntimeSettings(update(h))).toEqual({ applied: false, reason: "busy" });
		gate.resolve();
		await navigation;
		expect(await h.session.setRuntimeSettings(update(h))).toMatchObject({ applied: true });
	});
});
