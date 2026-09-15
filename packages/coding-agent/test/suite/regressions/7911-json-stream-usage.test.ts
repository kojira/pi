import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";
import { workResponse } from "../work-response.ts";

describe("regression #7911: JSON message updates retain usage", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("includes cumulative usage without cumulative message snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([workResponse("hello")]);

		await harness.session.prompt("respond");

		const end = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant");
		if (!end || end.message.role !== "assistant") throw new Error("Missing completed response");
		expect(end.message.usage.totalTokens).toBeGreaterThan(0);
		expect(toJsonEvent(end)).toMatchObject({ message: { usage: end.message.usage } });
		// Keep projection coverage for extension-generated updates even though main responses buffer.
		const wireUpdate = toJsonEvent({
			type: "message_update",
			message: end.message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: end.message },
		});
		expect(wireUpdate.usage).toEqual(end.message.usage);
		expect(wireUpdate).not.toHaveProperty("message");
		expect(wireUpdate.assistantMessageEvent).not.toHaveProperty("partial");
	});
});
