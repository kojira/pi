import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../src/core/compaction/compaction.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("compaction at a completed tool boundary", () => {
	it.each(["finish_work", "read"])("keeps the trailing %s call/result pair instead of all history", (toolName) => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "old input", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("old response"));
		manager.appendMessage({ role: "user", content: "current input", timestamp: 2 });
		const call = fauxToolCall(toolName, {}, { id: "boundary-call" });
		const callEntryId = manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendCustomEntry("boundary-metadata", { state: "resolved" });
		manager.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName,
			content: [{ type: "text", text: "completed result" }],
			isError: false,
			timestamp: 3,
		});
		const preparation = prepareCompaction(manager.getBranch(), {
			enabled: true,
			reserveTokens: 0,
			keepRecentTokens: 1,
		});
		expect(preparation?.firstKeptEntryId).toBe(callEntryId);
		expect(preparation?.messagesToSummarize.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(preparation?.turnPrefixMessages.map((message) => message.role)).toEqual(["user"]);
	});
});
