import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { finishWorkSchema, type WorkContractRecord } from "./work-contract.ts";

export const TEXT_WORK_CONTROL_PROMPT = `A text-only work response must end with a standalone JSON control line outside code fences:
<work-control>{"action":"continue","nextAction":"Concrete next action"}</work-control>
or <work-control>{"action":"finish","outcome":"completed","reason":"Reason for stopping"}</work-control>.
Finish outcomes are completed, cancelled, waiting, or blocked. The text before the control is the user-facing summary.
Choose continue while authorized work remains. The runtime hides the control and performs the corresponding work operation.
You may still call ordinary tools or explicit work tools instead; never mix a footer with tool calls.`;

/** Converts model-selected text controls to existing, auditable tool-result boundaries. */
export class TextWorkControl {
	private repairs = 0;

	normalize(message: AssistantMessage, record: WorkContractRecord | undefined): AssistantMessage {
		const content = structuredClone(message.content);
		const lastText = [...content].reverse().find((block) => block.type === "text");
		const text = lastText?.text ?? "";
		const suffix = /(?:^|\n)(<work-control[^\n]*)\s*$/.exec(text);
		const marker = suffix ? /^<work-control>(.*)<\/work-control>\s*$/.exec(suffix[1]) : null;
		// A fence left open before the candidate makes it literal example text, not control.
		let fence: string | undefined;
		const earlierText = content
			.filter((block) => block.type === "text")
			.filter((block) => block !== lastText)
			.map((block) => block.text)
			.join("\n");
		for (const line of `${earlierText}\n${text.slice(0, suffix?.index ?? text.length)}`.split("\n")) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (!match) continue;
			if (!fence) fence = match[1];
			else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
		}
		const hasSuffix = suffix !== null && !fence;
		const hasMarker = hasSuffix && marker !== null;
		if (hasSuffix && lastText) {
			lastText.text = text.slice(0, suffix.index).trimEnd();
			delete lastText.textSignature;
		}
		const result = { ...message, content };
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
			return hasSuffix ? result : message;
		if (!hasSuffix && content.some((block) => block.type === "toolCall")) {
			this.repairs = 0;
			return message;
		}
		if (hasSuffix && content.some((block) => block.type === "toolCall")) {
			return { ...result, stopReason: "error", errorMessage: "Work control cannot be mixed with tool calls" };
		}
		let decision: unknown;
		if (hasMarker) {
			try {
				decision = JSON.parse(marker[1]);
			} catch {
				// Invalid decisions request correction below, never successful completion.
			}
		}
		if (decision && typeof decision === "object" && "action" in decision) {
			if (
				decision.action === "continue" &&
				"nextAction" in decision &&
				typeof decision.nextAction === "string" &&
				decision.nextAction.trim()
			) {
				this.repairs = 0;
				result.content.push({
					type: "toolCall",
					id: `call_${randomUUID()}`,
					name: "continue_work",
					arguments: { nextAction: decision.nextAction },
				});
				return { ...result, stopReason: "toolUse" };
			}
			if (decision.action === "finish" && record?.status === "active") {
				const summary = content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const args = { ...decision, checkpointId: record.checkpointId, summary };
				if (Check(finishWorkSchema, args) && args.reason.trim() && summary.trim()) {
					this.repairs = 0;
					result.content.push({
						type: "toolCall",
						id: `call_${randomUUID()}`,
						name: "finish_work",
						arguments: {
							checkpointId: args.checkpointId,
							outcome: args.outcome,
							reason: args.reason,
							summary: args.summary,
						},
					});
					return { ...result, stopReason: "toolUse" };
				}
			}
		}
		if (++this.repairs > 2) {
			return {
				...result,
				stopReason: "error",
				errorMessage: "Text work-control repair limit exceeded; no valid decision received",
			};
		}
		result.content.push({
			type: "toolCall",
			id: `call_${randomUUID()}`,
			name: "continue_work",
			arguments: {
				nextAction:
					"Correct the missing or invalid work-control footer. Return a valid decision for the current work state; do not replay completed operations.",
			},
		});
		return { ...result, stopReason: "toolUse" };
	}
}
