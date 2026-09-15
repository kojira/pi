import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../../ai/src/api/openai-responses-shared.ts";
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
		expect(message.stopReason).toBe("length");
		expect(message.content).toEqual([{ type: "text", text: "Report" }]);
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

	it.each(["<work-control", '<work-control>{"action":"finish"', "<work-control>{bad}</work-control>"])(
		"hides malformed terminal control %s",
		(suffix) => {
			const result = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${suffix}`), active);
			expect(result.content[0]).toMatchObject({ text: "Report" });
			expect(result.content.at(-1)).toMatchObject({ name: "continue_work" });
		},
	);

	it("serializes generated call/result pairs without provider-owned item IDs", () => {
		const result = new TextWorkControl().normalize(fauxAssistantMessage(`Report\n${footer}`), active);
		const call = result.content.at(-1);
		if (call?.type !== "toolCall") throw new Error("Missing call");
		const items = convertResponsesMessages(
			{
				id: result.model,
				name: "Serialization fixture",
				api: "openai-codex-responses",
				provider: result.provider,
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
			{
				messages: [
					result,
					{
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [{ type: "text", text: "Report" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			new Set(["openai-codex"]),
		);
		expect(items.find((item) => item.type === "function_call")).toMatchObject({
			call_id: call.id,
			id: undefined,
			name: "finish_work",
		});
		expect(items.find((item) => item.type === "function_call_output")).toMatchObject({ call_id: call.id });
		expect(JSON.stringify(items)).not.toContain("<work-control>");
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
