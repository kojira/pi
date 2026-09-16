import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { TextWorkControl } from "../src/core/text-work-control.ts";
import type { WorkContractRecord } from "../src/core/work-contract.ts";

const active: WorkContractRecord = { status: "active", checkpointId: "checkpoint", nextAction: "Verify" };
const footer = '<done reason="Tests passed"/>';

describe("done marker normalization", () => {
	it("ends with a reason and preserves the report without displaying the marker", () => {
		const message = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${footer}`), active);
		expect(message.content[0]).toEqual({ type: "text", text: "Report" });
		expect(message.content.at(-1)).toMatchObject({
			type: "toolCall",
			name: "finish_work",
			arguments: { checkpointId: "checkpoint", outcome: "completed", reason: "Tests passed", summary: "Report" },
		});
	});

	it.each([
		"Progress",
		"",
		'<done reason=""/>',
		'<done reason=" "/>',
		"<done",
		`\`\`\`xml\n${footer}`,
		`~~~xml\n${footer}`,
		`> ${footer}`,
		`\`${footer}\``,
		'<work-control>{"action":"continue","nextAction":"Check"}</work-control>',
		'<work-control>{"action":"finish","outcome":"completed","reason":"Done"}</work-control>',
	])("does not fabricate repair calls or fail continued work: %s", (text) => {
		const control = new TextWorkControl();
		const input = fauxAssistantMessage(text);
		for (let i = 0; i < 5; i++) expect(control.normalize(input, active)).toBe(input);
	});

	it("decodes escaped reason characters once", () => {
		const result = new TextWorkControl().normalize(
			fauxAssistantMessage('<done reason="Checked &quot;x&quot; &amp; y"/>'),
			active,
		);
		expect(result.content.at(-1)).toMatchObject({
			arguments: { reason: 'Checked "x" & y', summary: 'Checked "x" & y' },
		});
	});

	it.each(["length", "error", "aborted"] as const)("never finishes interrupted %s output", (stopReason) => {
		const result = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${footer}`, { stopReason }), active);
		expect(result.stopReason).toBe(stopReason);
		expect(result.content).toEqual([{ type: "text", text: "Report" }]);
	});

	it("rejects markers mixed with side effects before execution", () => {
		const input = fauxAssistantMessage([{ type: "text", text: `Report\n${footer}` }, fauxToolCall("write", {})], {
			stopReason: "toolUse",
		});
		expect(new TextWorkControl().normalize(input, active).stopReason).toBe("error");
	});

	it("does not attach a provider-owned item ID to generated finish calls", () => {
		const result = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${footer}`), active);
		const call = result.content.at(-1);
		if (call?.type !== "toolCall") throw new Error("Missing finish");
		expect(call.id).toMatch(/^call_[a-f0-9-]+$/);
	});
});
