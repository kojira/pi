import { describe, expect, expectTypeOf, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";
import {
	type ContinueWorkToolCallEvent,
	type ContinueWorkToolDetails,
	type ContinueWorkToolInput,
	type ContinueWorkToolResultEvent,
	createContinueWorkTool,
	createContinueWorkToolDefinition,
	isContinueWorkToolResult,
	isToolCallEventType,
} from "../src/index.ts";

describe("continue_work tool", () => {
	it("records the model-authored next action without terminating the tool loop", async () => {
		const definition = createContinueWorkToolDefinition();
		const result = await definition.execute(
			"checkpoint-1",
			{ nextAction: "Run the deployment smoke test" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "Continuation checkpoint recorded." }],
			details: { nextAction: "Run the deployment smoke test" },
		});
		expect(result.terminate).toBeUndefined();
	});

	it("is available through the public entry point and built-in catalogs", () => {
		const input: ContinueWorkToolInput = { nextAction: "Run tests" };
		const details: ContinueWorkToolDetails = input;

		expectTypeOf(input.nextAction).toBeString();
		expectTypeOf(details.nextAction).toBeString();
		expect(createAllToolDefinitions("/workspace").continue_work.name).toBe("continue_work");
		expect(createAllTools("/workspace").continue_work.name).toBe("continue_work");
		expect(createContinueWorkTool().name).toBe("continue_work");
	});

	it("provides typed extension event narrowing through the public entry point", () => {
		const call: ContinueWorkToolCallEvent = {
			type: "tool_call",
			toolCallId: "checkpoint-1",
			toolName: "continue_work",
			input: { nextAction: "Run tests" },
		};
		const result: ContinueWorkToolResultEvent = {
			type: "tool_result",
			toolCallId: "checkpoint-1",
			toolName: "continue_work",
			input: call.input,
			content: [{ type: "text", text: "Continuation checkpoint recorded." }],
			isError: false,
			details: { nextAction: "Run tests" },
		};

		expect(isToolCallEventType("continue_work", call)).toBe(true);
		expect(isContinueWorkToolResult(result)).toBe(true);
	});

	it("defines explicit continuation and stop conditions for the model", () => {
		const definition = createContinueWorkToolDefinition();
		const guidelines = definition.promptGuidelines?.join("\n") ?? "";

		expect(guidelines).toContain("intermediate progress update");
		expect(guidelines).toContain("perform its nextAction");
		expect(guidelines).toContain("waiting for user input");
	});
});
