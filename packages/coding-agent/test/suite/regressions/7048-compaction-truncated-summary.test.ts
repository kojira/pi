import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const model = harness.getModel();
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("#7048 truncated compaction summaries", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Superseded: any substantive summary text is accepted, so a length stop is kept
	// rather than rejected (a rejected summary used to leave the session unusable).
	it("persists the text of a length-limited summary", async () => {
		harness = await createHarness();
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("partial summar", { stopReason: "length" })]);

		expect((await harness.session.compact()).summary).toBe("partial summar");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
