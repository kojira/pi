import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	discordAttachmentHint,
	parseSdkProposal,
	registerStructuredSdk,
	SdkCarrier,
	sdkFirstPartyEnv,
} from "../examples/extensions/claude-sdk-structured/index.ts";
import { generateSummaryWithUsage } from "../src/core/compaction/compaction.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createHarness } from "./suite/harness.ts";

const prompt = [
	"You are a Pi coding assistant. Use the existing Pi tool dispatcher.",
	"- When asked about: custom providers (docs/custom-provider.md), app packages (docs/packages.md)",
	"- For Pi-related work, consult applicable documentation and examples and follow their linked Markdown pages before implementing.",
	"- Always read pi .md files completely and follow links to related docs",
].join("\n");
const context: Context = {
	messages: [],
	tools: [
		{ name: "side_effect", description: "Record a safe value", parameters: Type.Object({ value: Type.String() }) },
		{ name: "finish_work", description: "Finish work", parameters: Type.Object({ reason: Type.String() }) },
	],
};

describe("Claude SDK structured Pi boundary", () => {
	it("registers an opt-in Opus model without altering the current Pi model", async () => {
		let close: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					close = registerStructuredSdk(pi);
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			const model = harness.session.modelRuntime.getModel("claude-sdk-structured", "claude-opus-5-5");
			expect(model).toMatchObject({ api: "claude-sdk-structured", input: ["text", "image"], reasoning: true });
			expect(harness.session.model?.provider).toBe(harness.getModel().provider);
		} finally {
			close?.();
			harness.cleanup();
		}
	});
	it("exposes the existing Gateway attachment CLI only for a verified Discord channel session", async () => {
		const hint = discordAttachmentHint("/tmp/sessions/ch_1553040001598750731/2026-09-25.jsonl");
		expect(hint).toContain("piscord send --channel dc:1553040001598750731 --file");
		expect(hint).not.toContain("TOKEN");
		expect(discordAttachmentHint("/tmp/sessions/local/2026-09-25.jsonl")).toBeUndefined();
		expect(discordAttachmentHint("/tmp/sessions/ch_1553040001598750731/child/session.jsonl")).toBeUndefined();
		const inputs: unknown[] = [];
		const fakeQuery = ((request: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
			const iterator = (async function* () {
				for await (const input of request.prompt) {
					inputs.push(input.message.content);
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						session_id: "11111111-1111-4111-8111-111111111111",
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "OK" },
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		carrier.setDeliveryHint(hint);
		try {
			const result = await carrier
				.stream(
					{
						api: "claude-sdk-structured",
						provider: "claude-sdk-structured",
						id: "claude-opus-5-5",
					} as Model<string>,
					{
						systemPrompt: prompt,
						messages: [{ role: "user", content: "この動画を貼って" } as Context["messages"][number]],
					},
				)
				.result();
			expect(result.stopReason).toBe("stop");
			expect(inputs[0]).toContain("piscord send --channel dc:1553040001598750731 --file");
		} finally {
			carrier.close();
		}
	});

	it("passes Pi history and image tool results to independent SDK requests", async () => {
		const inputs: unknown[] = [];
		const starts: Array<{ resume?: string; thinking?: unknown; persistSession?: boolean }> = [];
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const fakeQuery = ((request: {
			prompt: AsyncIterable<{ message: { content: unknown } }>;
			options: { resume?: string; thinking?: unknown; persistSession?: boolean };
		}) => {
			starts.push(request.options);
			const iterator = (async function* () {
				for await (const input of request.prompt) {
					inputs.push(input.message.content);
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						session_id: sessionId,
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "OK" },
					};
				}
			})();
			return Object.assign(iterator, {
				close: () => undefined,
				setMaxThinkingTokens: async () => {},
				applyFlagSettings: async () => {},
			});
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const model = {
			api: "claude-sdk-structured",
			provider: "claude-sdk-structured",
			id: "claude-opus-5-5",
		} as Model<string>;
		const user = { role: "user", content: "Describe the work" } as Context["messages"][number];
		const image = {
			role: "toolResult",
			toolName: "read",
			toolCallId: "read-1",
			isError: false,
			content: [
				{ type: "text", text: "frame" },
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			],
		} as Context["messages"][number];
		const firstCarrier = new SdkCarrier(undefined, fakeQuery);
		try {
			const first = await firstCarrier.stream(model, { systemPrompt: prompt, messages: [user] }).result();
			expect(first.responseId).toBeUndefined();
			const second = await firstCarrier
				.stream(model, { systemPrompt: prompt, messages: [user, first, image] }, { reasoning: "high" })
				.result();
			expect(second.stopReason).toBe("stop");
			expect(JSON.stringify(inputs[1])).toContain("Assistant:");
			expect(JSON.stringify(inputs[1])).toContain("Pi tool result for read");
			expect(JSON.stringify(inputs[1])).toContain('"type":"image"');
			firstCarrier.close();
			const resumed = new SdkCarrier(undefined, fakeQuery);
			try {
				const third = await resumed
					.stream(
						model,
						{
							systemPrompt: prompt,
							messages: [
								user,
								first,
								image,
								second,
								{ role: "user", content: "Continue" } as Context["messages"][number],
							],
						},
						{ reasoning: "high" },
					)
					.result();
				expect(third.stopReason).toBe("stop");
				expect(starts).toHaveLength(3);
				expect(starts.every((start) => start.resume === undefined && start.persistSession === false)).toBe(true);
				expect(starts[2]?.thinking).toEqual({ type: "adaptive" });
				resumed.close();
				const recovered = new SdkCarrier(undefined, fakeQuery);
				try {
					const failed = {
						...third,
						responseId: undefined,
						content: [],
						stopReason: "error" as const,
						errorMessage: "SDK turn failed: error_max_turns",
					};
					const closed = { ...failed, errorMessage: "SDK session unavailable or safety turn limit reached" };
					const next = await recovered
						.stream(
							model,
							{
								systemPrompt: prompt,
								messages: [
									user,
									first,
									image,
									second,
									{ role: "user", content: "Continue" } as Context["messages"][number],
									third,
									image,
									failed,
									closed,
									{ role: "user", content: "Still working?" } as Context["messages"][number],
								],
							},
							{ reasoning: "high" },
						)
						.result();
					expect(next.stopReason).toBe("stop");
					expect(starts[3]?.resume).toBeUndefined();
					expect(JSON.stringify(inputs[3])).toContain('"type":"image"');
					expect(JSON.stringify(inputs[3])).toContain("Still working?");
				} finally {
					recovered.close();
				}
			} finally {
				resumed.close();
			}
		} finally {
			firstCarrier.close();
		}
	});

	it("uses Pi context after an initial SDK failure or a foreign assistant", async () => {
		const inputs: unknown[] = [];
		const fakeQuery = ((request: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
			const iterator = (async function* () {
				for await (const input of request.prompt) {
					inputs.push(input.message.content);
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						session_id: "11111111-1111-4111-8111-111111111111",
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "OK" },
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		const model = {
			api: "claude-sdk-structured",
			provider: "claude-sdk-structured",
			id: "claude-opus-5-5",
		} as Model<string>;
		const user = { role: "user", content: "First request" } as Context["messages"][number];
		const failed = {
			role: "assistant",
			provider: model.provider,
			model: model.id,
			stopReason: "error",
			errorMessage: "SDK transport failed",
			content: [],
		} as unknown as Context["messages"][number];
		try {
			const result = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [user, failed, { role: "user", content: "Try again" } as Context["messages"][number]],
				})
				.result();
			expect(result.stopReason).toBe("stop");
			expect(JSON.stringify(inputs[0])).toContain("Try again");
			const unknown = { ...failed, provider: "another-provider" };
			const rejected = new SdkCarrier(undefined, fakeQuery);
			try {
				const next = await rejected.stream(model, { systemPrompt: prompt, messages: [user, unknown] }).result();
				expect(next.stopReason).toBe("stop");
				expect(inputs).toHaveLength(2);
			} finally {
				rejected.close();
			}
		} finally {
			carrier.close();
		}
	});

	it("uses Pi's compaction summary path without interrupting normal turns", async () => {
		let starts = 0;
		const systems: string[] = [];
		const fakeQuery = ((request: { prompt: AsyncIterable<unknown>; options: { systemPrompt: string } }) => {
			starts++;
			systems.push(request.options.systemPrompt);
			const iterator = (async function* () {
				for await (const _input of request.prompt) {
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: {
							name: "",
							args_json: "",
							final: request.options.systemPrompt.startsWith("You are a context summarization assistant.")
								? "## Goal\n- Continue the task"
								: "OK",
						},
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		const model = {
			api: "claude-sdk-structured",
			provider: "claude-sdk-structured",
			id: "claude-opus-5-5",
		} as Model<string>;
		const user = { role: "user", content: "First task" } as Context["messages"][number];
		const summary: Context = {
			systemPrompt: "You are a context summarization assistant. Summarize history.",
			messages: [user],
		};
		try {
			const before = await generateSummaryWithUsage(
				[{ role: "user", content: "First task", timestamp: Date.now() }],
				model,
				16384,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				(m, c, o) => carrier.stream(m, c, o),
			);
			expect(before.text).toBe("## Goal\n- Continue the task");
			const first = await carrier.stream(model, { systemPrompt: prompt, messages: [user] }).result();
			expect(first.content).toEqual([{ type: "text", text: "OK" }]);
			const during = await carrier.stream(model, summary).result();
			expect(during.content).toEqual([{ type: "text", text: "## Goal\n- Continue the task" }]);
			const second = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [user, first, { role: "user", content: "Next task" } as Context["messages"][number]],
				})
				.result();
			expect(second.content).toEqual([{ type: "text", text: "OK" }]);
			expect(starts).toBe(4);
			expect(systems[0]).toContain("final field");
			expect(systems[2]).toContain("final field");
		} finally {
			carrier.close();
		}
	});

	it("does not start an SDK request if Pi aborts during the async payload hook", async () => {
		let starts = 0;
		const fakeQuery = (() => {
			starts++;
			throw new Error("SDK query must not start after cancellation");
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		const controller = new AbortController();
		let entered!: () => void;
		let release!: () => void;
		const payloadEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const payloadHeld = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const model = {
				api: "claude-sdk-structured",
				provider: "claude-sdk-structured",
				id: "claude-opus-5-5",
			} as Model<string>;
			const response = carrier
				.stream(
					model,
					{
						systemPrompt: prompt,
						messages: [{ role: "user", content: "Cancel this request" }] as Context["messages"],
					},
					{
						signal: controller.signal,
						onPayload: async () => {
							entered();
							await payloadHeld;
						},
					},
				)
				.result();
			await payloadEntered;
			controller.abort();
			release();
			const result = await response;
			expect(result.stopReason).toBe("aborted");
			expect(starts).toBe(0);
		} finally {
			release();
			carrier.close();
		}
	});

	it("uses an existing Pi transcript without an SDK resume ID", async () => {
		let input: unknown;
		const fakeQuery = ((request: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
			const iterator = (async function* () {
				for await (const message of request.prompt) {
					input = message.message.content;
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "OK" },
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		try {
			const model = {
				api: "claude-sdk-structured",
				provider: "claude-sdk-structured",
				id: "claude-opus-5-5",
			} as Model<string>;
			const result = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [
						{ role: "user", content: "Old task" },
						{ role: "user", content: "New task" },
					] as Context["messages"],
				})
				.result();
			expect(result.stopReason).toBe("stop");
			expect(input).toContain("Old task");
			expect(input).toContain("New task");
		} finally {
			carrier.close();
		}
	});

	it("uses a foreign assistant reply from Pi context after model selection", async () => {
		let starts = 0;
		const inputs: unknown[] = [];
		const fakeQuery = ((request: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
			starts++;
			const iterator = (async function* () {
				for await (const input of request.prompt) {
					inputs.push(input.message.content);
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						num_turns: 1,
						total_cost_usd: 0,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "OK" },
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		const model = {
			api: "claude-sdk-structured",
			provider: "claude-sdk-structured",
			id: "claude-opus-5-5",
		} as Model<string>;
		const user = { role: "user", content: "First task" } as Context["messages"][number];
		try {
			const first = await carrier.stream(model, { systemPrompt: prompt, messages: [user] }).result();
			expect(first.stopReason).toBe("stop");
			const foreign = {
				...first,
				provider: "openai-codex",
				model: "gpt-5.5",
				content: [{ type: "text", text: "Earlier model reply" }],
			};
			const second = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [user, first, foreign, { role: "user", content: "Next" }] as Context["messages"],
				})
				.result();
			expect(second.stopReason).toBe("stop");
			expect(starts).toBe(2);
			expect(JSON.stringify(inputs[1])).toContain("Earlier model reply");
		} finally {
			carrier.close();
		}
	});

	it("uses the same first-party environment for login inspection and SDK requests", () => {
		const env = sdkFirstPartyEnv({ HOME: "/home/user", PATH: "/usr/bin", LANG: "en_US.UTF-8", RANDOM_FLAG: "x" });
		expect(env).toEqual({ HOME: "/home/user", PATH: "/usr/bin", LANG: "en_US.UTF-8" });
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"CLAUDE_CODE_PROXY_URL",
		]) {
			expect(() => sdkFirstPartyEnv({ HOME: "/home/user", PATH: "/usr/bin", [key]: "override" })).toThrow(
				"refuses credential/provider overrides",
			);
		}
	});

	it("defines the documentation wording once in Pi's default system prompt", () => {
		const system = buildSystemPrompt({ cwd: "/tmp" });
		expect(system).toContain("app packages (docs/packages.md)");
		expect(system).toContain("For Pi-related work, consult applicable documentation and examples");
		expect(system).not.toContain("When working on pi topics");
		expect(system).not.toContain("pi packages (docs/packages.md)");
	});

	it("sends a child reviewer's custom Pi prompt to the SDK without rewriting it", async () => {
		const customPrompt = "You are a read-only reviewer. Review the assigned PRs.";
		let sdkSystem: string | undefined;
		const fakeQuery = ((request: { prompt: AsyncIterable<unknown>; options: { systemPrompt: string } }) => {
			sdkSystem = request.options.systemPrompt;
			const iterator = (async function* () {
				for await (const _input of request.prompt) {
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 1, output_tokens: 1 },
						modelUsage: {},
						structured_output: { name: "", args_json: "", final: "Review complete" },
					};
				}
			})();
			return Object.assign(iterator, { close: () => undefined });
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		try {
			const model = {
				api: "claude-sdk-structured",
				provider: "claude-sdk-structured",
				id: "claude-opus-5-5",
			} as Model<string>;
			const response = await carrier
				.stream(model, {
					systemPrompt: customPrompt,
					messages: [{ role: "user", content: "Review PR #557" } as Context["messages"][number]],
				})
				.result();
			expect(response.stopReason).toBe("stop");
			expect(response.content).toEqual([{ type: "text", text: "Review complete" }]);
			expect(sdkSystem?.endsWith(`\n${customPrompt}`)).toBe(true);
			expect(sdkSystem).toContain(customPrompt);
			expect(sdkSystem).not.toContain("app packages (docs/packages.md)");
		} finally {
			carrier.close();
		}
	});

	it("accepts one tool proposal, returning data to Pi rather than executing it", () => {
		expect(parseSdkProposal({ name: "side_effect", args_json: '{"value":"OK"}', final: "" }, context)).toEqual({
			name: "side_effect",
			args: { value: "OK" },
		});
		expect(parseSdkProposal({ name: "", args_json: "", final: "Progress update" }, context)).toEqual({
			text: "Progress update",
		});
	});

	it.each([
		{ name: "finish_work", args_json: "{}", final: "Also finish in prose" },
		{ name: "unknown", args_json: "{}", final: "" },
		{ name: "", args_json: "{}", final: "" },
		{ name: "", args_json: "", final: "" },
		{ name: "side_effect", args_json: "[]", final: "" },
		{ name: "side_effect", args_json: "not JSON", final: "" },
	])("rejects invalid or contradictory proposal before Pi dispatch: $name/$final", (proposal) => {
		expect(() => parseSdkProposal(proposal, context)).toThrow();
	});

	it.each([
		{
			responses: [
				{ name: "side_effect", args_json: '{"value":"x"}', final: "Premature completion" },
				{ name: "side_effect", args_json: '{"value":"x"}', final: "" },
			],
			reason: "toolUse",
		},
		{
			responses: [
				{ name: "side_effect", args_json: '{"value":"x"}', final: "Premature completion" },
				{ name: "", args_json: "", final: "Only text" },
			],
			reason: "stop",
		},
		{
			responses: [
				{ name: "side_effect", args_json: '{"value":"x"}', final: "Premature completion" },
				{ name: "side_effect", args_json: '{"value":"x"}', final: "Still premature" },
			],
			reason: "error",
		},
		{
			responses: [{ name: "unknown", args_json: "{}", final: "" }],
			reason: "error",
		},
	])("recovers only a mixed proposal before Pi dispatch: $reason/$responses", async ({ responses, reason }) => {
		const requests: Array<{ input: unknown; resume?: string; persistSession?: boolean; abortedAtStart: boolean }> =
			[];
		let closed = 0;
		const fakeQuery = ((request: {
			prompt: AsyncIterable<{ message: { content: unknown } }>;
			options: { resume?: string; persistSession?: boolean; abortController: AbortController };
		}) => {
			const reply = responses[requests.length];
			const iterator = (async function* () {
				for await (const message of request.prompt) {
					requests.push({
						input: message.message.content,
						...request.options,
						abortedAtStart: request.options.abortController.signal.aborted,
					});
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						num_turns: 1,
						total_cost_usd: 0,
						usage: { input_tokens: 3, output_tokens: 2 },
						modelUsage: {},
						structured_output: reply,
					};
				}
			})();
			return Object.assign(iterator, {
				close: () => {
					closed++;
					request.options.abortController.abort();
				},
			});
		}) as unknown as NonNullable<ConstructorParameters<typeof SdkCarrier>[1]>;
		const carrier = new SdkCarrier(undefined, fakeQuery);
		try {
			const model = {
				api: "claude-sdk-structured",
				provider: "claude-sdk-structured",
				id: "claude-opus-5-5",
			} as Model<string>;
			const reply = await carrier
				.stream(model, {
					systemPrompt: "You are a read-only child reviewer.",
					messages: [{ role: "user", content: "Review safely" } as Context["messages"][number]],
					tools: context.tools,
				})
				.result();
			expect(reply.stopReason).toBe(reason);
			expect(requests).toHaveLength(responses.length);
			expect(
				requests.every(
					(request) => request.resume === undefined && request.persistSession === false && !request.abortedAtStart,
				),
			).toBe(true);
			expect(reply.content.filter((block) => block.type === "toolCall")).toHaveLength(reason === "toolUse" ? 1 : 0);
			expect(reply.usage.input).toBe(3 * responses.length);
			if (responses.length === 2) expect(JSON.stringify(requests[1]?.input)).toContain("no Pi tool ran");
			if (reason === "error") expect(reply.errorMessage).toMatch(/Tool and final text|Unknown proposed Pi tool/);
		} finally {
			carrier.close();
		}
		expect(closed).toBe(responses.length);
	});
});
