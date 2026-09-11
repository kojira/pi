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
