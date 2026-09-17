import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

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
const waitForUser = (question: string) => (context: Context) => {
	const match = /Active work checkpoint ID: ("(?:[^"\\]|\\.)*")/.exec(context.systemPrompt ?? "");
	if (!match) throw new Error("Wait fixture requires an active checkpoint");
	return fauxAssistantMessage(
		[
			{ type: "text", text: question },
			fauxToolCall("wait_for_user", { checkpointId: JSON.parse(match[1]), question }),
		],
		{ stopReason: "toolUse" },
	);
};

describe("explicit work completion", () => {
	it("keeps work instructions out of auxiliary summary requests during active work", async () => {
		let harness: Harness;
		let summaryPrompt: string | undefined;
		harness = await createHarness({
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
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("preserves a finish summary across context-only messages, but not a later assistant response", async () => {
		const harness = await createHarness({});
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
		harness.setResponses([workResponse("Answer to new input")]);
		await harness.session.prompt("A new question");
		expect(harness.session.getLastAssistantText()).toBe("Answer to new input");
	});

	it("processes follow-up input queued after a successful finish", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (
				!queued &&
				event.type === "message_end" &&
				event.message.role === "toolResult" &&
				event.message.toolName === "finish_work"
			) {
				queued = true;
				void harness.session.followUp("A new question");
			}
		});
		harness.setResponses([checkpoint(), finish(), workResponse("Answer to new input")]);
		await harness.session.prompt("Verify");
		expect(getUserTexts(harness)).toEqual(["Verify", "A new question"]);
		expect(harness.session.getLastAssistantText()).toBe("Answer to new input");
	});

	it("suspends an aborted checkpoint without replaying it", async () => {
		const harness = await createHarness({});
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

	it("asks once, settles without another inference, and resumes the same checkpoint on user input", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([waitForUser("Which test account should I use?")]);
		await harness.session.prompt("Prepare a collaborative test");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.workContract).toMatchObject({
			status: "awaiting_input",
			question: "Which test account should I use?",
		});
		expect(harness.session.getLastAssistantText()).toBe("Which test account should I use?");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);

		harness.setResponses([workResponse("I will use the staging account")]);
		await harness.session.prompt("Use staging-user-2");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Prepare a collaborative test", "Use staging-user-2"]);
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(harness.session.getLastAssistantText()).toBe("I will use the staging account");
	});

	it("does not enter waiting state when user input races the wait call", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (
				!queued &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((part) => part.type === "toolCall" && part.name === "wait_for_user")
			) {
				queued = true;
				void harness.session.followUp("Use staging-user-2");
			}
		});
		harness.setResponses([waitForUser("Which test account should I use?"), workResponse("Using staging-user-2")]);
		await harness.session.prompt("Prepare a collaborative test");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Prepare a collaborative test", "Use staging-user-2"]);
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(harness.session.getLastAssistantText()).toBe("Using staging-user-2");
	});

	it("continues ordinary text turns without correction until explicitly finished", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			...Array.from({ length: 3 }, () => fauxAssistantMessage("I will continue later.")),
			finish(),
		]);
		await harness.session.prompt("Implement and verify");
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(harness.faux.state.callCount).toBe(5);
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
	});

	it("rejects a finish raced by follow-up input and processes that input before resolving", async () => {
		const harness = await createHarness({});
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
