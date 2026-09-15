import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";
import { workResponse } from "../work-response.ts";

describe("regression #7290: JSON event streams stay linear", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function measureUpdateBytes(text: string): Promise<number> {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([workResponse(text)]);

		await harness.session.prompt("respond");

		expect(harness.eventsOfType("message_update")).toEqual([]);
		expect(harness.session.getLastAssistantText()).toBe(text);
		const events = harness.events.map((event) => toJsonEvent(event));
		expect(JSON.stringify(events)).not.toContain("<work-control>");
		return events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
	}

	it("emits buffered normalized responses whose total wire size scales linearly", async () => {
		const smallBytes = await measureUpdateBytes("x".repeat(2_000));
		const largeBytes = await measureUpdateBytes("x".repeat(4_000));

		expect(largeBytes).toBeGreaterThan(smallBytes);
		expect(largeBytes / smallBytes).toBeLessThan(2.2);
	});
});
