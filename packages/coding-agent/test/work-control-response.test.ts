import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeWorkResponse, WORK_CONTROL_PROMPT } from "../src/core/work-control-response.ts";

const finish = () =>
	fauxToolCall("finish_work", {
		checkpointId: "checkpoint",
		outcome: "completed",
		reason: "Tests passed",
		summary: "Report",
	});

describe("explicit work response", () => {
	it("publishes only the explicit finish tool, preserving its identity and arguments", () => {
		const input = fauxAssistantMessage([{ type: "text", text: "Report" }, finish()], { stopReason: "toolUse" });
		const snapshot = structuredClone(input);
		const result = normalizeWorkResponse(input);
		expect(result.content).toEqual([input.content[1]]);
		expect(result.stopReason).toBe("toolUse");
		expect(input).toEqual(snapshot);
	});

	it.each([
		"Progress",
		"",
		'<done reason="Tests passed"/>',
		"done:Tests passed",
		'<work-control>{"action":"finish"}</work-control>',
	])("never interprets prose as a completion: %s", (text) => {
		const input = fauxAssistantMessage(text);
		expect(normalizeWorkResponse(input)).toBe(input);
	});

	it.each(["length", "error", "aborted", "pending"] as const)("preserves %s responses", (stopReason) => {
		const input = fauxAssistantMessage([{ type: "text", text: "Report" }, finish()], { stopReason });
		expect(normalizeWorkResponse(input)).toBe(input);
	});

	it("keeps ordinary tool progress visible", () => {
		const input = fauxAssistantMessage([{ type: "text", text: "Checking" }, fauxToolCall("read", {})], {
			stopReason: "toolUse",
		});
		expect(normalizeWorkResponse(input)).toBe(input);
	});

	it("keeps other calls for batch validation rather than hiding side effects", () => {
		const input = fauxAssistantMessage([finish(), fauxToolCall("write", {})], { stopReason: "toolUse" });
		expect(normalizeWorkResponse(input).content).toEqual(input.content);
	});

	it("requires tool completion without a competing marker protocol", () => {
		expect(WORK_CONTROL_PROMPT).toContain("call finish_work");
		expect(WORK_CONTROL_PROMPT).toContain("only in finish_work.summary");
		expect(WORK_CONTROL_PROMPT).not.toContain("<done");
		expect(WORK_CONTROL_PROMPT).not.toContain("done:");
	});
});
