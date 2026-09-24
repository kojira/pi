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
const finishCall = (legacyCheckpointId?: string) =>
	fauxToolCall("finish_work", {
		...(legacyCheckpointId ? { checkpointId: legacyCheckpointId } : {}),
		outcome: "completed",
		reason: "Verification is complete",
		summary: "Verified; not deployed",
	});
const finish = (legacyCheckpointId?: string) =>
	fauxAssistantMessage(finishCall(legacyCheckpointId), { stopReason: "toolUse" });
const waitForUser = (question: string) => (_context: Context) =>
	fauxAssistantMessage([{ type: "text", text: question }, fauxToolCall("wait_for_user", { question })], {
		stopReason: "toolUse",
	});

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

	it("ignores a legacy model-supplied checkpoint ID without persisting any identifier", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([checkpoint(), finish("checkpoint-from-old-history")]);
		await harness.session.prompt("Verify");
		expect(harness.session.workContract).toMatchObject({
			status: "resolved",
			decision: { outcome: "completed" },
		});
		expect(harness.session.workContract).not.toHaveProperty("checkpointId");
		expect(
			harness.session.workContract?.status === "resolved" ? harness.session.workContract.decision : {},
		).not.toHaveProperty("checkpointId");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "finish_work",
		);
		expect(result?.role === "toolResult" ? result.details : undefined).not.toHaveProperty("checkpointId");
	});

	it("parks without another model call when finish_work validation fails", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let unexpectedCall = false;
		expect(harness.session.agent.state.tools.find((tool) => tool.name === "finish_work")).toMatchObject({
			errorBehavior: "park",
		});
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage(fauxToolCall("finish_work", { outcome: "completed", reason: "Done" }), {
				stopReason: "toolUse",
			}),
			() => {
				unexpectedCall = true;
				return fauxAssistantMessage("must not run");
			},
		]);
		await harness.session.prompt("Verify");
		expect(unexpectedCall).toBe(false);
		expect(harness.session.workContract?.status).toBe("active");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "finish_work",
		);
		expect(result?.role === "toolResult" ? result.isError : false).toBe(true);
	});

	it.each([
		["unknown", fauxToolCall("missing_tool", {})],
		["schema-invalid", fauxToolCall("verify", {})],
	])("parks a mixed finish batch without repair when its other tool is %s", async (_kind, otherCall) => {
		const harness = await createHarness({
			tools: [
				{
					name: "verify",
					label: "Verify",
					description: "Verify a target",
					parameters: Type.Object({ target: Type.String() }),
					execute: async () => ({
						content: [{ type: "text" as const, text: "verified" }],
						details: {},
					}),
				},
			],
		});
		harnesses.push(harness);
		let unexpectedCall = false;
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage([otherCall, finishCall()], { stopReason: "toolUse" }),
			() => {
				unexpectedCall = true;
				return fauxAssistantMessage("must not run");
			},
		]);
		await harness.session.prompt("Verify");
		expect(unexpectedCall).toBe(false);
		expect(harness.session.workContract?.status).toBe("active");
		const finishEnd = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "finish_work");
		expect(finishEnd).toMatchObject({ isError: true, result: { terminate: true, park: true } });
	});

	it("rejects a structured-provider mixed work decision before any valid side effect", async () => {
		let effects = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "side_effect",
					label: "Side effect",
					description: "Record a side effect",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => {
						effects++;
						return { content: [{ type: "text" as const, text: "done" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		// The structured-output carrier returns the entire proposed batch before Pi dispatches any tool.
		harness.setResponses([
			fauxAssistantMessage([finishCall(), fauxToolCall("side_effect", { value: "must-not-run" })], {
				stopReason: "toolUse",
			}),
		]);
		await harness.session.prompt("Finish and modify state");
		expect(effects).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.workContract?.status).toBe("active");
		expect(
			harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "side_effect"),
		).toMatchObject({
			isError: true,
		});
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

	it("parks active work at a terminating async tool boundary and resumes on native input", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "launch_async",
					label: "Launch async",
					description: "Launch work that reports completion through a native message",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text" as const, text: "Async run started" }],
						details: { asyncId: "run-1" },
						terminate: true,
						park: true,
					}),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage(fauxToolCall("launch_async", {}), { stopReason: "toolUse" }),
		]);
		await harness.session.prompt("Delegate the verification");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.workContract).toMatchObject({ status: "active" });
		expect(harness.session.workContract).not.toHaveProperty("checkpointId");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);

		harness.setResponses([finish()]);
		await harness.session.sendCustomMessage(
			{ customType: "async-completion", content: "run-1 completed", display: false },
			{ triggerTurn: true },
		);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.workContract).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
		expect(harness.session.getLastAssistantText()).toBe("Verified; not deployed");
	});

	it("does not treat an ordinary terminating tool as an external-input park", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "terminate_only",
					label: "Terminate only",
					description: "End the current tool batch without arranging a resume",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text" as const, text: "Stopped" }],
						details: {},
						terminate: true,
					}),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage(fauxToolCall("terminate_only", {}), { stopReason: "toolUse" }),
		]);
		await harness.session.prompt("Stop at a regular tool boundary");
		expect(harness.session.workContract).toMatchObject({ status: "suspended" });
		expect(harness.session.workContract).not.toHaveProperty("checkpointId");
	});

	it("asks once, settles without another inference, and resumes the same work on user input", async () => {
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

	it("commits waiting output, then processes user input queued during the call", async () => {
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
		expect(harness.eventsOfType("work_contract").map((event) => event.record.status)).toEqual([
			"active",
			"awaiting_input",
			"active",
			"resolved",
		]);
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(harness.session.getLastAssistantText()).toBe("Using staging-user-2");
	});

	it("includes the immediately preceding assistant text in every automatic continuation request", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let observed = false;
		harness.setResponses([
			checkpoint(),
			fauxAssistantMessage("DIAGNOSTIC_PROGRESS"),
			(context) => {
				const previous = context.messages.at(-1);
				observed =
					previous?.role === "assistant" &&
					previous.content.some((part) => part.type === "text" && part.text === "DIAGNOSTIC_PROGRESS");
				return finish();
			},
		]);
		await harness.session.prompt("Implement and verify");
		expect(observed).toBe(true);
		expect(harness.session.workContract?.status).toBe("resolved");
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
