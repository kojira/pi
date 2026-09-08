import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createContinueWorkTool, createContinueWorkToolDefinition } from "../src/core/tools/continue-work.ts";
import { createAllToolDefinitions, createAllTools } from "../src/core/tools/index.ts";

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

	it("is available through the built-in definition and executable tool catalogs", () => {
		expect(createAllToolDefinitions("/workspace").continue_work.name).toBe("continue_work");
		expect(createAllTools("/workspace").continue_work.name).toBe("continue_work");
		expect(createContinueWorkTool().name).toBe("continue_work");
	});

	it("defines explicit continuation and stop conditions for the model", () => {
		const definition = createContinueWorkToolDefinition();
		const guidelines = definition.promptGuidelines?.join("\n") ?? "";

		expect(guidelines).toContain("intermediate progress update");
		expect(guidelines).toContain("perform its nextAction");
		expect(guidelines).toContain("waiting for user input");
	});
});
