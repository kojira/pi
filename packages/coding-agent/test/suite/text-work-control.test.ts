import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
const next = () => fauxAssistantMessage("Progress report.");
const done = () => workResponse("Verified.");

describe("explicit work control", () => {
	it("continues from text, executes work once, then finishes without another user message", async () => {
		let executions = 0;
		const harness = await createHarness({
			tools: [
				{
					name: "verify",
					label: "Verify",
					description: "Verify",
					parameters: Type.Object({}),
					execute: async () => {
						executions++;
						return { content: [{ type: "text", text: "passed" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			next(),
			fauxAssistantMessage(fauxToolCall("verify", {}), { stopReason: "toolUse" }),
			done(),
		]);
		await harness.session.prompt("Implement and verify");
		expect(executions).toBe(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["Implement and verify"]);
		expect(harness.session.workContract).toMatchObject({
			status: "resolved",
			decision: { outcome: "completed", summary: "Verified." },
		});
		expect(harness.session.getLastAssistantText()).toBe("Verified.");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		for (const event of harness.eventsOfType("message_end")) {
			expect(JSON.stringify(event)).not.toContain("<done");
		}
	});

	it("continues without a marker or synthetic repair calls, even beyond the former repair limit", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([next(), next(), next(), next(), done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(5);
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(getUserTexts(harness)).toEqual(["Verify"]);
		const calls = harness.eventsOfType("tool_execution_start");
		expect(calls.map((event) => event.toolName)).toEqual(["finish_work"]);
		expect(JSON.stringify(harness.session.messages)).not.toContain("Correct the missing");
	});

	it("reconsiders finish when new input arrives before executing its explicit operation", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (
				!queued &&
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.content.some((p) => p.type === "toolCall" && p.name === "finish_work")
			) {
				queued = true;
				void harness.session.followUp("Also check the new requirement");
			}
		});
		harness.setResponses([next(), done(), done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["Verify", "Also check the new requirement"]);
		expect(harness.session.workContract?.status).toBe("resolved");
	});

	it("stops on cancellation at a text-only boundary without consuming queued input", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				harness.session.agent.followUp({ role: "user", content: "Later", timestamp: Date.now() });
				harness.session.agent.abort();
			}
		});
		harness.setResponses([next(), done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["Verify"]);
		expect(harness.session.workContract?.status).not.toBe("resolved");
	});

	it("drains follow-up input between ordinary text inferences", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (!queued && event.type === "message_end" && event.message.role === "assistant") {
				queued = true;
				void harness.session.followUp("Check this too");
			}
		});
		harness.setResponses([next(), done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Verify", "Check this too"]);
		expect(harness.session.workContract?.status).toBe("resolved");
	});

	it("retries a transient provider error after ordinary progress without synthetic input", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			next(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			done(),
		]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(3);
		expect(getUserTexts(harness)).toEqual(["Verify"]);
		expect(harness.session.workContract?.status).toBe("resolved");
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["finish_work"]);
	});

	it("does not continue a provider error as ordinary text", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Failure", { stopReason: "error", errorMessage: "Invalid request" }),
			done(),
		]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.workContract?.status).not.toBe("resolved");
	});

	it.each(['<done reason="Finished"/>', "done:Finished"])(
		"treats former markers as ordinary continued text: %s",
		async (text) => {
			const harness = await createHarness({});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage(text), done()]);
			await harness.session.prompt("Verify");
			expect(harness.faux.state.callCount).toBe(2);
			expect(getUserTexts(harness)).toEqual(["Verify"]);
			expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual(["finish_work"]);
			expect(harness.session.workContract?.status).toBe("resolved");
		},
	);

	it("publishes the summary once when a provider also emits final answer text", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				const response = workResponse("Verified.", context);
				response.content.unshift({ type: "text", text: "Verified." });
				return response;
			},
		]);
		await harness.session.prompt("Verify");
		const assistantEnds = harness.eventsOfType("message_end").filter((event) => event.message.role === "assistant");
		expect(assistantEnds).toHaveLength(1);
		const message = assistantEnds[0].message;
		if (message.role !== "assistant") throw new Error("Expected an assistant response");
		expect(message.content).not.toContainEqual({ type: "text", text: "Verified." });
		expect(harness.eventsOfType("work_contract").filter((event) => event.record.status === "resolved")).toHaveLength(
			1,
		);
		expect(harness.session.getLastAssistantText()).toBe("Verified.");
	});

	it("requires no mode or initial checkpoint to finish a simple response", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("Verified.");
		expect(harness.session.workContract?.status).toBe("resolved");
	});
});
