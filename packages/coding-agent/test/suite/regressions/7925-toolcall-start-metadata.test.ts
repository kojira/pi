import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";
import { workResponse } from "../work-response.ts";

describe("regression #7925: tool-call metadata is available when streaming starts", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("includes the tool call id and name without cumulative snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("write", { path: "output.txt", content: "x".repeat(100) }, { id: "call_7925" }),
				{ stopReason: "toolUse" },
			),
			workResponse("done"),
		]);

		await harness.session.prompt("write a file");

		const start = harness.eventsOfType("message_start").find((event) => event.message.role === "assistant");
		if (!start || start.message.role !== "assistant") throw new Error("Missing assistant start");
		expect(start.message.content[0]).toMatchObject({ type: "toolCall", id: "call_7925", name: "write" });
		// Metadata remains available on the buffered start; projection still supports direct updates.
		expect(
			toJsonEvent({
				type: "message_update",
				message: start.message,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: start.message },
			}),
		).toEqual({
			type: "message_update",
			usage: start.message.usage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				id: "call_7925",
				toolName: "write",
			},
		});
	});
});
