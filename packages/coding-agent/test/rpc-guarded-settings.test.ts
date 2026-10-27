import type { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./suite/harness.ts";
import { workResponse } from "./suite/work-response.ts";

const io = vi.hoisted(() => ({
	line: undefined as ((line: string) => void) | undefined,
	ready: undefined as (() => void) | undefined,
	outputs: [] as Array<Record<string, unknown>>,
	replies: new Map<string, (response: Record<string, unknown>) => void>(),
}));
vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: (line: string) => {
		const response = JSON.parse(line);
		io.outputs.push(response);
		io.replies.get(response.id)?.(response);
	},
}));
vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: (_stream: unknown, onLine: (line: string) => void) => {
		io.line = onLine;
		io.ready?.();
		return () => {};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	io.outputs = [];
	io.replies.clear();
});

async function setup(options: HarnessOptions = {}) {
	const h: Harness = await createHarness({
		models: [
			{ id: "first", reasoning: true },
			{ id: "second", reasoning: true },
		],
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		...options,
	});
	const targets: { emitter: EventEmitter; name: string }[] = [
		{ emitter: process, name: "SIGTERM" },
		{ emitter: process, name: "SIGHUP" },
		{ emitter: process.stdin, name: "end" },
	];
	const listeners = targets.map(({ emitter, name }) => ({ emitter, name, before: emitter.listeners(name) }));
	cleanups.push(() => {
		h.cleanup();
		for (const { emitter, name, before } of listeners)
			for (const listener of emitter.listeners(name))
				if (!before.includes(listener)) emitter.removeListener(name, listener as (...args: unknown[]) => void);
	});
	const ready = new Promise<void>((resolve) => {
		io.ready = resolve;
	});
	void runRpcMode({ session: h.session, setRebindSession: () => {} } as unknown as AgentSessionRuntime);
	await ready;
	let sequence = 0;
	const command = (value: object) =>
		new Promise<Record<string, unknown>>((resolve) => {
			const id = String(++sequence);
			io.replies.set(id, resolve);
			io.line!(JSON.stringify({ ...value, id }));
		});
	return { h, command };
}

it("advertises and implements the frozen guarded settings and prompt wire contract", async () => {
	const { h, command } = await setup();
	const revision = h.session.settingsRevision;
	expect(await command({ type: "get_state" })).toMatchObject({
		success: true,
		data: { capabilities: { guardedSettings: 1 }, settingsRevision: revision },
	});
	const applied = await command({
		type: "set_runtime_settings",
		provider: h.getModel().provider,
		modelId: "second",
		thinkingLevel: "high",
		expectedRevision: revision,
	});
	expect(applied).toMatchObject({
		success: true,
		data: {
			applied: true,
			settingsRevision: h.session.settingsRevision,
			model: { provider: h.getModel().provider, id: "second" },
			thinkingLevel: "high",
		},
	});
	expect(await command({ type: "set_runtime_settings", expectedRevision: revision })).toMatchObject({
		success: true,
		data: { applied: false, reason: "revision_changed" },
	});
	expect(await command({ type: "prompt", message: "stale", expectedSettingsRevision: revision })).toMatchObject({
		success: true,
		data: { accepted: false, reason: "settings_changed" },
	});
	expect(h.faux.state.callCount).toBe(0);
	h.setResponses([(context) => workResponse("guarded", context)]);
	expect(
		await command({ type: "prompt", message: "accepted", expectedSettingsRevision: h.session.settingsRevision }),
	).toMatchObject({ success: true, data: { accepted: true } });
	await h.session.waitForIdle();
	h.setResponses([(context) => workResponse("legacy", context)]);
	const legacy = await command({ type: "prompt", message: "legacy" });
	expect(legacy.success).toBe(true);
	expect(legacy).not.toHaveProperty("data");
	await h.session.waitForIdle();
});

it.each([
	{},
	{ provider: "faux" },
	{ modelId: "second" },
	{ expectedRevision: -1 },
	{ expectedRevision: null },
	{ thinkingLevel: "invalid" },
])("rejects malformed settings without mutation (%j)", async (invalid) => {
	const { h, command } = await setup();
	const before = h.session.settingsRevision;
	const response = await command({
		type: "set_runtime_settings",
		...(Object.keys(invalid).length ? { expectedRevision: before } : {}),
		...invalid,
	});
	expect(response.success).toBe(false);
	expect(h.session.settingsRevision).toBe(before);
	expect(h.session.model?.id).toBe("first");
});

it.each(["setter", "abort"] as const)(
	"reports post-hook %s conflict once as uncertain error, never retryable nonacceptance",
	async (mutation) => {
		let effects = 0;
		let effect: () => void | Promise<void> = () => {};
		const { h, command } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						effects++;
						await effect();
						return { action: "continue" };
					});
				},
			],
		});
		effect = () => {
			if (mutation === "setter") h.session.setThinkingLevel("high");
			else return h.session.abort();
		};
		const before = h.sessionManager.getEntries().length;
		const response = await command({
			type: "prompt",
			message: "effectful",
			expectedSettingsRevision: h.session.settingsRevision,
		});
		expect(response).toMatchObject({
			success: false,
			error: expect.stringMatching(/after guarded (?:prompt )?admission/),
		});
		expect(response).not.toHaveProperty("data");
		expect(effects).toBe(1);
		expect(h.faux.state.callCount).toBe(0);
		expect(
			h.sessionManager
				.getEntries()
				.slice(before)
				.filter((e) => e.type === "message"),
		).toHaveLength(0);
		expect(io.outputs.filter((record) => record.type === "response" && record.id === response.id)).toHaveLength(1);
	},
);

it("refuses guarded prompt and settings while running without queue mutation", async () => {
	const { h, command } = await setup();
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.setResponses([
		async (context) => {
			await held;
			return workResponse("done", context);
		},
	]);
	try {
		await command({ type: "prompt", message: "start" });
		expect(
			await command({
				type: "prompt",
				message: "not queued",
				expectedSettingsRevision: h.session.settingsRevision,
				streamingBehavior: "followUp",
			}),
		).toMatchObject({ success: true, data: { accepted: false, reason: "busy" } });
		expect(
			await command({
				type: "set_runtime_settings",
				expectedRevision: h.session.settingsRevision,
				thinkingLevel: "high",
			}),
		).toMatchObject({ success: true, data: { applied: false, reason: "busy" } });
		expect(h.session.pendingMessageCount).toBe(0);
	} finally {
		release();
		await h.session.waitForIdle();
	}
});
