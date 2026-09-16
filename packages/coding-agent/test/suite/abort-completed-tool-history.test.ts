import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { convertResponsesMessages } from "../../../ai/src/api/openai-responses-shared.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";
import { workResponse } from "./work-response.ts";

it("preserves completed tool messages across abort, persistence and the next provider request", async () => {
	const harness = await createHarness({
		tools: [
			{
				name: "verify",
				label: "Verify",
				description: "Verify",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "verified" }], details: {} }),
			},
		],
	});
	try {
		const delivered: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			delivered.push(structuredClone(event.message));
			if (event.message.role === "toolResult" && event.message.toolName === "verify") harness.session.agent.abort();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("verify", {}, { id: "call_verify" }), { stopReason: "toolUse" }),
			workResponse("Later done"),
		]);
		await harness.session.prompt("Verify");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.lastRunAborted).toBe(true);
		expect(harness.session.messages).toEqual(delivered);
		expect(harness.session.messages[1]).toMatchObject({ role: "assistant", stopReason: "toolUse" });
		const file = join(harness.tempDir, "export.jsonl");
		harness.session.exportToJsonl(file);
		const reopened = SessionManager.open(file).buildSessionContext().messages;
		expect(reopened).toEqual(harness.session.messages);
		await harness.session.prompt("Continue now");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.agent.lastRunAborted).toBe(false);
		const items = convertResponsesMessages(
			harness.getModel(),
			{ messages: convertToLlm(harness.session.messages) },
			new Set([harness.getModel().provider]),
		);
		const calls = items.filter((item) => item.type === "function_call").map((item) => item.call_id);
		const results = items.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
		expect(calls).toContain("call_verify");
		expect(results).toEqual(calls);
	} finally {
		harness.cleanup();
	}
});
