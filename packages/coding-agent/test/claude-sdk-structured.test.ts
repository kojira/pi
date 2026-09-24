import type { Context, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	adaptPiPromptForClaudeSdk,
	parseSdkProposal,
	registerStructuredSdk,
	SdkCarrier,
	sdkFirstPartyEnv,
} from "../examples/extensions/claude-sdk-structured/index.ts";
import { createHarness } from "./suite/harness.ts";

const prompt = [
	"You are a Pi coding assistant. Use the existing Pi tool dispatcher.",
	"- When asked about: custom providers (docs/custom-provider.md), pi packages (docs/packages.md)",
	"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
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
			expect(model).toMatchObject({ api: "claude-sdk-structured", input: ["text"] });
			expect(harness.session.model?.provider).toBe(harness.getModel().provider);
		} finally {
			close?.();
			harness.cleanup();
		}
	});
	it("rejects auxiliary Pi summaries without poisoning an active SDK conversation", async () => {
		let starts = 0;
		const fakeQuery = ((request: { prompt: AsyncIterable<unknown> }) => {
			starts++;
			const iterator = (async function* () {
				for await (const _input of request.prompt) {
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
		const summary: Context = {
			systemPrompt: "You are a context summarization assistant. Summarize history.",
			messages: [user],
		};
		try {
			const before = await carrier.stream(model, summary).result();
			expect(before.stopReason).toBe("error");
			expect(starts).toBe(0);
			const first = await carrier.stream(model, { systemPrompt: prompt, messages: [user] }).result();
			expect(first.content).toEqual([{ type: "text", text: "OK" }]);
			const during = await carrier.stream(model, summary).result();
			expect(during.stopReason).toBe("error");
			const second = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [user, first, { role: "user", content: "Next task" } as Context["messages"][number]],
				})
				.result();
			expect(second.content).toEqual([{ type: "text", text: "OK" }]);
			expect(starts).toBe(1);
			carrier.onModelSelect({ provider: "openai-codex", id: "gpt-5.5" });
			carrier.onModelSelect({ provider: "claude-sdk-structured", id: "claude-opus-5-5" });
			const afterSwitch = await carrier.stream(model, { systemPrompt: prompt, messages: [user] }).result();
			expect(afterSwitch.stopReason).toBe("error");
			expect(starts).toBe(1);
		} finally {
			carrier.close();
		}
	});

	it("rejects a resumed Pi transcript before issuing any SDK request", async () => {
		let starts = 0;
		const fakeQuery = (() => {
			starts++;
			throw new Error("No SDK query may run for a resumed Pi transcript");
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
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("starts only in a new Pi session");
			expect(starts).toBe(0);
		} finally {
			carrier.close();
		}
	});

	it("rejects a foreign assistant reply even when the model selection event was missed", async () => {
		let starts = 0;
		const fakeQuery = ((request: { prompt: AsyncIterable<unknown> }) => {
			starts++;
			const iterator = (async function* () {
				for await (const _input of request.prompt) {
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
			const foreign = { ...first, provider: "openai-codex", model: "gpt-5.5" };
			const second = await carrier
				.stream(model, {
					systemPrompt: prompt,
					messages: [user, first, foreign, { role: "user", content: "Next" }] as Context["messages"],
				})
				.result();
			expect(second.stopReason).toBe("error");
			expect(second.errorMessage).toContain("another model's response");
			expect(starts).toBe(1);
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

	it("keeps Pi identity and documentation references while changing only two known phrases", () => {
		const adapted = adaptPiPromptForClaudeSdk(prompt);
		expect(adapted).toContain("You are a Pi coding assistant. Use the existing Pi tool dispatcher.");
		expect(adapted).toContain("app packages (docs/packages.md)");
		expect(adapted).toContain("custom providers (docs/custom-provider.md)");
		expect(adapted).toContain("Always read pi .md files completely");
		expect(adapted).toContain("For Pi-related work, consult applicable documentation and examples");
		expect(adapted).not.toContain("When working on pi topics");
		expect(adapted).not.toContain("pi packages (docs/packages.md)");
	});

	it("fails closed if upstream Pi instructions change", () => {
		expect(() => adaptPiPromptForClaudeSdk(prompt.replace("pi packages", "Pi packages"))).toThrow(
			"Pi documentation instructions changed",
		);
		expect(() => adaptPiPromptForClaudeSdk(`${prompt}\n${prompt}`)).toThrow("Pi documentation instructions changed");
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
});
