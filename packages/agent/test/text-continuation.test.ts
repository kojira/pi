import { createAssistantMessageEventStream, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoopContinue, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const response: StreamFn = () => {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Done") }));
	return stream;
};

describe("owner-managed text continuation", () => {
	it.each(["stream", "sink"])("accepts an assistant tail through the %s entry point", async (entry) => {
		const progress = fauxAssistantMessage("Progress");
		const context = { messages: [progress], systemPrompt: "", tools: [] };
		const config: AgentLoopConfig = {
			model,
			convertToLlm: (messages) =>
				messages.filter(
					(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				),
			shouldContinueAfterTurn: () => false,
		};
		let messages: AgentMessage[];
		if (entry === "stream") messages = await agentLoopContinue(context, config, undefined, response).result();
		else messages = await runAgentLoopContinue(context, config, () => {}, undefined, response);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		expect(context.messages[0]).toBe(progress);
	});

	it("honors abort while awaiting the continuation callback without another inference", async () => {
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: (value: boolean) => void;
		const decision = new Promise<boolean>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: (...args) => {
				calls++;
				return response(...args);
			},
			shouldContinueAfterTurn: () => {
				entered();
				return decision;
			},
		});
		const prompt = agent.prompt("Work");
		await waiting;
		agent.followUp({ role: "user", content: "Later", timestamp: Date.now() });
		agent.abort();
		release(true);
		await prompt;
		expect(calls).toBe(1);
		expect(agent.lastRunAborted).toBe(true);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});
});
