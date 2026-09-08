import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createContinueWorkTool } from "../../src/core/tools/continue-work.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

describe("continue_work lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("continues from the tool result and settles once after the final response", async () => {
		const harness = await createHarness({
			tools: [createContinueWorkTool()],
			initialActiveToolNames: ["continue_work"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxText("The implementation is complete. Next I will run the smoke test."),
					fauxToolCall("continue_work", { nextAction: "Run the smoke test" }, { id: "checkpoint-1" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Smoke test passed."),
		]);

		await harness.session.prompt("Implement and test the change");

		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["Implement and test the change"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			toolCallId: "checkpoint-1",
			toolName: "continue_work",
			isError: false,
			details: { nextAction: "Run the smoke test" },
		});
		expect(harness.eventsOfType("agent_end")).toHaveLength(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rejects an empty nextAction through normal tool argument validation", async () => {
		const harness = await createHarness({
			tools: [createContinueWorkTool()],
			initialActiveToolNames: ["continue_work"],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("continue_work", { nextAction: "" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("The checkpoint was rejected."),
		]);

		await harness.session.prompt("test invalid checkpoint");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "continue_work", isError: true });
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});
});
