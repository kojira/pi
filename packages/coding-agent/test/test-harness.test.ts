/**
 * Tests for the test harness itself.
 * Validates that the faux provider and session factory work correctly.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { workResponse } from "./suite/work-response.ts";
import { createHarness, createHarnessWithExtensions, type FauxResponse, type Harness } from "./test-harness.ts";

function final(text: string, overrides: Partial<FauxResponse> = {}): (context: Context) => FauxResponse {
	return (context) => ({
		...overrides,
		toolCalls: workResponse(text, context)
			.content.filter((block) => block.type === "toolCall")
			.map((call) => ({ id: call.id, name: call.name, args: call.arguments })),
	});
}

describe("test harness", () => {
	let harness: Harness;

	afterEach(() => {
		harness?.cleanup();
	});

	it("simple text response", async () => {
		harness = await createHarness({ responses: [final("hello world")] });

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(1);

		const assistantMessages = harness.session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);

		const msg = assistantMessages[0] as AssistantMessage;
		expect(msg.content).toHaveLength(1);
		expect(msg.content[0]).toMatchObject({
			type: "toolCall",
			name: "finish_work",
			arguments: { summary: "hello world" },
		});
		expect(harness.session.workContract?.status).toBe("resolved");
	});

	it("response sequence", async () => {
		harness = await createHarness({ responses: [final("first"), final("second"), final("third")] });

		await harness.session.prompt("a");
		await harness.session.prompt("b");
		await harness.session.prompt("c");

		expect(harness.faux.callCount).toBe(3);

		const assistantTexts = harness.session.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map((m) => m.content.find((c) => c.type === "toolCall")?.arguments.summary);

		expect(assistantTexts).toEqual(["first", "second", "third"]);
	});

	it("tool call response triggers tool execution", async () => {
		let toolExecuted = false;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecuted = true;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};

		harness = await createHarness({
			responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, final("done after tool")],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("use the tool");

		expect(toolExecuted).toBe(true);
		expect(harness.faux.callCount).toBe(2);

		const toolResults = harness.session.messages.filter((m) => m.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		expect(toolResults.map((result) => result.toolName)).toEqual(["echo", "finish_work"]);
	});

	it("error response", async () => {
		harness = await createHarness({
			responses: [{ error: "something broke" }],
		});

		await harness.session.prompt("hi");

		const assistantMessages = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].stopReason).toBe("error");
		expect(assistantMessages[0].errorMessage).toBe("something broke");
	});

	it("turns a pending terminal response into an error", async () => {
		harness = await createHarness({
			responses: [{ text: "partial", stopReason: "pending" }],
			settings: { retry: { enabled: false } },
		});

		await harness.session.prompt("hi");

		const assistantMessages = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].stopReason).toBe("error");
		expect(assistantMessages[0].errorMessage).toBe("Faux response ended without a stop reason");
	});

	it("retry on transient error", async () => {
		harness = await createHarness({
			responses: [{ error: "overloaded_error" }, final("recovered")],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});

		await harness.session.prompt("hi");

		expect(harness.faux.callCount).toBe(2);

		const retryStarts = harness.eventsOfType("auto_retry_start");
		expect(retryStarts).toHaveLength(1);

		const retryEnds = harness.eventsOfType("auto_retry_end");
		expect(retryEnds).toHaveLength(1);
		expect(retryEnds[0].success).toBe(true);
	});

	it("custom usage numbers", async () => {
		harness = await createHarness({
			responses: [final("big response", { usage: { input: 100000, output: 5000 } })],
		});

		await harness.session.prompt("hi");

		const msg = harness.session.messages.find((m): m is AssistantMessage => m.role === "assistant")!;
		expect(msg.usage.input).toBe(100000);
		expect(msg.usage.output).toBe(5000);
	});

	it("event capture", async () => {
		harness = await createHarness({ responses: [final("hello")] });

		await harness.session.prompt("hi");

		const agentStarts = harness.eventsOfType("agent_start");
		expect(agentStarts).toHaveLength(1);

		const agentEnds = harness.eventsOfType("agent_end");
		expect(agentEnds).toHaveLength(1);

		const messageEnds = harness.eventsOfType("message_end");
		expect(messageEnds.length).toBeGreaterThanOrEqual(2); // user + assistant
	});

	it("context capture", async () => {
		harness = await createHarness({ responses: [final("reply")] });

		await harness.session.prompt("my question");

		expect(harness.faux.contexts).toHaveLength(1);
		const ctx = harness.faux.contexts[0];
		const userMsg = ctx.messages.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
	});

	it("wraps around when more calls than responses", async () => {
		harness = await createHarness({ responses: [final("a"), final("b")] });

		await harness.session.prompt("1");
		await harness.session.prompt("2");
		await harness.session.prompt("3");

		expect(harness.faux.callCount).toBe(3);

		const texts = harness.session.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map((m) => m.content.find((c) => c.type === "toolCall")?.arguments.summary);

		expect(texts).toEqual(["a", "b", "a"]);
	});

	it("buffers text until the work decision is normalized", async () => {
		harness = await createHarness({ responses: [final("hello world")] });

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("message_update")).toEqual([]);
		expect(harness.session.getLastAssistantText()).toBe("hello world");
		expect(JSON.stringify(harness.events)).not.toContain("<done");
	});

	it("preserves thinking in buffered responses", async () => {
		harness = await createHarness({
			responses: [final("answer", { thinking: "let me think about this" })],
		});

		await harness.session.prompt("hi");

		expect(harness.eventsOfType("message_update")).toEqual([]);
		const response = harness.session.messages.find((message) => message.role === "assistant");
		expect(response).toMatchObject({
			content: expect.arrayContaining([{ type: "thinking", thinking: "let me think about this" }]),
		});
	});

	it("preserves tool calls in buffered responses", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};

		harness = await createHarness({
			responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, final("done")],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("use tool");

		expect(harness.eventsOfType("message_update")).toEqual([]);
		const response = harness.session.messages.find((message) => message.role === "assistant");
		expect(response).toMatchObject({
			content: [expect.objectContaining({ type: "toolCall", name: "echo", arguments: { text: "hi" } })],
		});
	});

	it("preserves thinking, text, and tool call ordering after buffering", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};

		harness = await createHarness({
			responses: [
				{
					thinking: "hmm",
					text: "I will call a tool",
					toolCalls: [{ name: "echo", args: { text: "x" } }],
				},
				final("final"),
			],
			tools: [echoTool],
			baseToolsOverride: { echo: echoTool },
		});

		await harness.session.prompt("do it");

		expect(harness.eventsOfType("message_update")).toEqual([]);
		const response = harness.session.messages.find(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(response?.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
	});

	it("loads inline extension factories and disambiguates duplicate commands", async () => {
		const calls: string[] = [];

		harness = await createHarnessWithExtensions({
			extensionFactories: [
				{
					path: "<alpha>",
					factory: (pi) => {
						pi.registerCommand("shared-cmd", {
							description: "Alpha command",
							handler: async (args) => {
								calls.push(`alpha:${args}`);
							},
						});
					},
				},
				{
					path: "<beta>",
					factory: (pi) => {
						pi.registerCommand("shared-cmd", {
							description: "Beta command",
							handler: async (args) => {
								calls.push(`beta:${args}`);
							},
						});
					},
				},
			],
		});

		const runner = harness.session.extensionRunner;
		expect(runner).toBeDefined();

		const commands = runner!.getRegisteredCommands();
		expect(
			commands.map((command) => ({
				name: command.name,
				invocationName: command.invocationName,
				description: command.description,
				path: command.sourceInfo.path,
			})),
		).toEqual([
			{ name: "shared-cmd", invocationName: "shared-cmd:1", description: "Alpha command", path: "<alpha>" },
			{ name: "shared-cmd", invocationName: "shared-cmd:2", description: "Beta command", path: "<beta>" },
		]);

		await runner!.getCommand("shared-cmd:1")?.handler("first", runner!.createCommandContext());
		await runner!.getCommand("shared-cmd:2")?.handler("second", runner!.createCommandContext());

		expect(calls).toEqual(["alpha:first", "beta:second"]);
	});

	it("session persistence works", async () => {
		harness = await createHarness({ responses: [final("persisted")] });

		await harness.session.prompt("hi");

		const entries = harness.sessionManager.getEntries();
		const messageEntries = entries.filter((e) => e.type === "message");
		expect(messageEntries.length).toBeGreaterThanOrEqual(2); // user + assistant
	});
});
