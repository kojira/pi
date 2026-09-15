import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
const next = () =>
	fauxAssistantMessage(
		'Progress report.\n<work-control>{"action":"continue","nextAction":"Run verification"}</work-control>',
	);
const done = () =>
	fauxAssistantMessage(
		'Verified.\n<work-control>{"action":"finish","outcome":"completed","reason":"Verification passed"}</work-control>',
	);

describe("text work control", () => {
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
			expect(JSON.stringify(event)).not.toContain("<work-control>");
		}
	});

	it("repairs a missing decision and resolves without silently stopping", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		harness.setResponses([next(), fauxAssistantMessage("Missing control"), done()]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.workContract?.status).toBe("resolved");
	});

	it("reconsiders finish when new input arrives before executing its normalized operation", async () => {
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
