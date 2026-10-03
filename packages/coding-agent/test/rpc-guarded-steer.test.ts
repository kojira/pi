import type { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./suite/harness.ts";
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

it("advertises guarded steering and distinguishes rejection, uncertain delivery, queueing and consumption over RPC", async () => {
	const h = await createHarness({});
	const targets: { emitter: EventEmitter; name: string }[] = [
		{ emitter: process, name: "SIGTERM" },
		{ emitter: process, name: "SIGHUP" },
		{ emitter: process.stdin, name: "end" },
	];
	const listeners = targets.map(({ emitter, name }) => ({ emitter, name, before: emitter.listeners(name) }));
	let release!: () => void;
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.setResponses([
		async (ctx) => {
			began();
			await held;
			return workResponse("first", ctx);
		},
		workResponse("second"),
	]);
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
	try {
		expect(await command({ type: "get_state" })).toMatchObject({
			success: true,
			data: { capabilities: { guardedSteer: 1 }, pendingMessageCount: 0 },
		});
		for (const expectedRunId of [null, "", 1]) {
			expect(await command({ type: "steer", message: "invalid", expectedRunId })).toMatchObject({
				success: false,
				errorCode: "INVALID_STEER_REQUEST",
			});
		}
		await command({ type: "prompt", message: "initial" });
		await started;
		const runId = h.eventsOfType("agent_start")[0].runId;
		expect(await command({ type: "steer", message: "wrong", expectedRunId: "other" })).toMatchObject({
			success: true,
			data: { accepted: false, reason: "run_not_accepting" },
		});
		const pop = h.session.pushSteeringRecipient({
			steer: async () => {
				throw new Error("after possible delivery");
			},
		});
		expect(await command({ type: "steer", message: "uncertain", expectedRunId: runId })).toMatchObject({
			success: false,
			errorCode: "STEER_DELIVERY_UNCERTAIN",
		});
		pop();
		expect(await command({ type: "steer", message: "accepted", expectedRunId: runId })).toMatchObject({
			success: true,
			data: { accepted: true },
		});
		expect(h.session.pendingMessageCount).toBe(1);
		const idle = new Promise<void>((resolve) =>
			h.session.subscribe((e) => {
				if (e.type === "agent_settled") resolve();
			}),
		);
		release();
		await idle;
		expect(h.session.pendingMessageCount).toBe(0);
		expect(io.outputs.filter((e) => e.type === "agent_settled")).toEqual([{ type: "agent_settled", runId }]);
		expect(await command({ type: "steer", message: "late", expectedRunId: runId })).toMatchObject({
			success: true,
			data: { accepted: false, reason: "run_not_accepting" },
		});
		expect(await command({ type: "steer", message: "legacy" })).toMatchObject({ success: true });
		expect(h.session.getSteeringMessages()).toEqual(["legacy"]);
	} finally {
		release();
		h.cleanup();
		io.outputs = [];
		io.replies.clear();
		for (const { emitter, name, before } of listeners) {
			for (const listener of emitter.listeners(name))
				if (!before.includes(listener)) emitter.removeListener(name, listener as (...args: unknown[]) => void);
		}
	}
});
