import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
const checkpoint = () =>
	fauxAssistantMessage(
		fauxToolCall("continue_work", { nextAction: "Perform the approved verification" }, { id: "checkpoint-1" }),
		{ stopReason: "toolUse" },
	);
const finish = () =>
	fauxAssistantMessage(
		fauxToolCall("finish_work", {
			checkpointId: "checkpoint-1",
			outcome: "completed",
			reason: "Verification is complete",
			summary: "Verified; not deployed",
		}),
		{ stopReason: "toolUse" },
	);

function assistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) =>
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		);
}

function sessionAssistantTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
		.map((message) =>
			message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		);
}

describe("explicit work completion", () => {
	it("keeps work instructions out of auxiliary summary requests during active work", async () => {
		let harness: Harness;
		let summaryPrompt: string | undefined;
		harness = await createHarness({
			explicitWorkCompletion: true,
			tools: [
				{
					name: "summarize",
					label: "Summarize",
					description: "Run an auxiliary summary",
					parameters: Type.Object({}),
					execute: async () => {
						const stream = await harness.session.agent.streamFunction(
							harness.session.agent.state.model,
							{
								systemPrompt: "Summarize only",
								messages: [{ role: "user", content: "test data", timestamp: Date.now() }],
							},
							{ signal: new AbortController().signal },
						);
						await stream.result();
						return { content: [{ type: "text", text: "summary complete" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage(fauxToolCall("summarize", {}), { stopReason: "toolUse" }),
			(context) => {
				summaryPrompt = context.systemPrompt;
				return fauxAssistantMessage("summary");
			},
			finish(),
		]);
		await harness.session.prompt("Verify summary isolation");
		expect(summaryPrompt).toBe("Summarize only");
		expect(harness.session.workContract?.status).toBe("resolved");
	});

	it("resolves only through finish_work without an extra assistant request or synthetic user", async () => {
		let executions = 0;
		const harness = await createHarness({
			explicitWorkCompletion: true,
			tools: [
				{
					name: "verify",
					label: "Verify",
					description: "Run verification",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "verified" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		const payloads: unknown[] = [];
		const onPayload = harness.session.agent.onPayload!;
		harness.session.agent.onPayload = async (payload, model) => {
			const result = await onPayload(payload, model);
			payloads.push(result);
			return result;
		};
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage(fauxToolCall("verify", {}), { stopReason: "toolUse" }),
			finish(),
		]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
		expect(harness.faux.state.callCount).toBe(3);
		expect(executions).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("Verified; not deployed");
		expect(payloads).toEqual([{ tool_choice: "auto" }, { tool_choice: "required" }, { tool_choice: "required" }]);
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("preserves a finish summary across context-only messages, but not a later assistant response", async () => {
		const harness = await createHarness({ explicitWorkCompletion: true });
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolName === "finish_work"
			) {
				void harness.session.sendCustomMessage(
					{ customType: "test-context", content: "Auxiliary context", display: false },
					{ triggerTurn: false },
				);
			}
		});
		harness.setResponses([checkpoint(), finish()]);
		await harness.session.prompt("Verify");
		expect(harness.session.messages.at(-1)?.role).toBe("custom");
		expect(harness.session.getLastAssistantText()).toBe("Verified; not deployed");
		harness.setResponses([fauxAssistantMessage("Answer to new input")]);
		await harness.session.prompt("A new question");
		expect(harness.session.getLastAssistantText()).toBe("Answer to new input");
	});

	it("processes follow-up input queued after a successful finish", async () => {
		const harness = await createHarness({ explicitWorkCompletion: true });
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolName === "finish_work"
			) {
				void harness.session.followUp("A new question");
			}
		});
		harness.setResponses([checkpoint(), finish(), fauxAssistantMessage("Answer to new input")]);
		await harness.session.prompt("Verify");
		expect(getUserTexts(harness)).toEqual(["Verify", "A new question"]);
		expect(harness.session.getLastAssistantText()).toBe("Answer to new input");
	});

	it("suspends an aborted checkpoint without replaying it", async () => {
		const harness = await createHarness({ explicitWorkCompletion: true });
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolName === "continue_work"
			) {
				void harness.session.abort();
			}
		});
		harness.setResponses([checkpoint()]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract?.status).toBe("suspended");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "toolResult" && message.toolName === "continue_work",
			),
		).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("suspends instead of treating an ordinary text response as completion", async () => {
		const harness = await createHarness({ explicitWorkCompletion: true });
		harnesses.push(harness);
		harness.setResponses([checkpoint(), fauxAssistantMessage("I will continue later.")]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract).toMatchObject({
			status: "suspended",
			reason: expect.stringContaining("text-only"),
		});
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
	});

	it("uses the configured continuation review model to continue after a declaration-only response", async () => {
		const harness = await createHarness({
			explicitWorkCompletion: true,
			settings: { workContinuationReview: { enabled: true, model: "faux/faux-1" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage("I will now run the approved verification."),
			fauxAssistantMessage('{"continue":true}'),
			finish(),
		]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
		expect(harness.faux.state.callCount).toBe(4);
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
		expect(sessionAssistantTexts(harness)).not.toContain("I will now run the approved verification.");
	});

	it("omits a continued declaration-only response even when context-only messages are queued", async () => {
		const harness = await createHarness({
			explicitWorkCompletion: true,
			settings: { workContinuationReview: { enabled: true, model: "faux/faux-1" } },
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some(
					(part) => part.type === "text" && part.text === "I will now run the approved verification.",
				)
			) {
				void harness.session.sendCustomMessage(
					{ customType: "test-context", content: "Auxiliary context", display: false },
					{ triggerTurn: false },
				);
			}
		});
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage("I will now run the approved verification."),
			fauxAssistantMessage('{"continue":true}'),
			finish(),
		]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
		expect(assistantTexts(harness)).not.toContain("I will now run the approved verification.");
		expect(sessionAssistantTexts(harness)).not.toContain("I will now run the approved verification.");
	});

	it("keeps the continuation review model configurable", async () => {
		const harness = await createHarness({
			explicitWorkCompletion: true,
			settings: { workContinuationReview: { enabled: true, model: "faux-1" } },
		});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage("I will continue later."),
			fauxAssistantMessage('{"continue":false}'),
		]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract).toMatchObject({ status: "suspended" });
		expect(harness.faux.state.callCount).toBe(3);
		expect(sessionAssistantTexts(harness)).toContain("I will continue later.");
	});

	it("rejects a finish raced by follow-up input and processes that input before resolving", async () => {
		const harness = await createHarness({ explicitWorkCompletion: true });
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (
				!queued &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((part) => part.type === "toolCall" && part.name === "finish_work")
			) {
				queued = true;
				void harness.session.followUp("Do not deploy");
			}
		});
		harness.setResponses([checkpoint(), finish(), finish()]);
		await harness.session.prompt("Implement and verify");
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["Implement and verify", "Do not deploy"]);
		expect(harness.session.workContract?.status).toBe("resolved");
	});
});
