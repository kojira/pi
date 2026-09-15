import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { TextWorkControl } from "../src/core/text-work-control.ts";
import type { WorkContractRecord } from "../src/core/work-contract.ts";

const active: WorkContractRecord = { status: "active", checkpointId: "checkpoint", nextAction: "Verify" };
const footer = '<work-control>{"action":"finish","outcome":"completed","reason":"Verified"}</work-control>';

describe("text control normalization", () => {
	it.each(["completed", "cancelled", "waiting", "blocked"])("preserves the model's %s decision", (outcome) => {
		const message = new TextWorkControl().normalize(
			fauxAssistantMessage(
				`Report\n<work-control>{"action":"finish","outcome":"${outcome}","reason":"Model decision"}</work-control>`,
			),
			active,
		);
		expect(message.content.at(-1)).toMatchObject({
			type: "toolCall",
			name: "finish_work",
			arguments: { outcome, checkpointId: "checkpoint", summary: "Report" },
		});
		expect(message.content[0]).toMatchObject({ type: "text", text: "Report" });
	});

	it.each([`\`\`\`xml\n${footer}`, `~~~xml\n${footer}`, `> ${footer}`, `\`${footer}\``])(
		"does not execute quoted controls: %s",
		(text) => {
			const message = new TextWorkControl().normalize(fauxAssistantMessage(text), active);
			expect(message.content.at(-1)).toMatchObject({ type: "toolCall", name: "continue_work" });
			expect(message.content.some((block) => block.type === "toolCall" && block.name === "finish_work")).toBe(false);
		},
	);

	it.each([
		"not-json",
		'{"action":"finish","outcome":"unknown","reason":"x"}',
		'{"action":"continue","nextAction":" "}',
	])("requests correction of invalid control: %s", (json) => {
		const message = new TextWorkControl().normalize(
			fauxAssistantMessage(`Report\n<work-control>${json}</work-control>`),
			active,
		);
		expect(message.content[0]).toMatchObject({ text: "Report" });
		expect(message.content.at(-1)).toMatchObject({ name: "continue_work" });
	});

	it("never executes a finish from a length-truncated response", () => {
		const message = new TextWorkControl().normalize(
			fauxAssistantMessage(`Report\n${footer}`, { stopReason: "length" }),
			active,
		);
		expect(message.content.at(-1)).toMatchObject({ name: "continue_work" });
	});

	it.each(["error", "aborted"] as const)("does not turn %s into continued work", (stopReason) => {
		const original = fauxAssistantMessage("Interrupted", { stopReason });
		expect(new TextWorkControl().normalize(original, active)).toBe(original);
	});

	it("rejects mixed footer and tool calls before either can run", () => {
		const original = fauxAssistantMessage([{ type: "text", text: `Report\n${footer}` }, fauxToolCall("write", {})], {
			stopReason: "toolUse",
		});
		expect(new TextWorkControl().normalize(original, active).stopReason).toBe("error");
	});

	it("uses call IDs without fabricating provider item IDs", () => {
		const result = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${footer}`), active);
		const call = result.content.at(-1);
		expect(call?.type).toBe("toolCall");
		if (call?.type !== "toolCall") throw new Error("Missing call");
		expect(call.id).toMatch(/^call_[a-f0-9-]+$/);
		expect(call.id).not.toContain("|");
	});
});
