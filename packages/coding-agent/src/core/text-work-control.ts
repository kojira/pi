import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WorkContractRecord } from "./work-contract.ts";

export const TEXT_WORK_CONTROL_PROMPT = `Continue working within the authorized scope until you have a reason to stop.
To end work, put this standalone marker on the final line outside code fences:
<done reason="A concrete reason for stopping"/>
Use a nonempty reason; escape embedded quotes as &quot; and ampersands as &amp;.
Without a valid ending marker, Pi automatically runs the next inference with the existing conversation. No continuation marker is needed.
The marker is hidden from the user. Do not mix it with tool calls. Explicit work-control tools remain available.`;

/** Recognizes a reason-bearing terminal marker. Missing markers are ordinary continued work. */
export class TextWorkControl {
	normalize(message: AssistantMessage, record: WorkContractRecord | undefined): AssistantMessage {
		const content = structuredClone(message.content);
		const lastText = [...content].reverse().find((block) => block.type === "text");
		if (!lastText) return message;
		const marker = /(?:^|\n)<done reason="([^"\r\n]+)"\/>\s*$/.exec(lastText.text);
		if (!marker) return message;
		let fence: string | undefined;
		const earlierText = content
			.filter((block) => block.type === "text")
			.filter((block) => block !== lastText)
			.map((block) => block.text)
			.join("\n");
		for (const line of `${earlierText}\n${lastText.text.slice(0, marker.index)}`.split("\n")) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
			if (!match) continue;
			if (!fence) fence = match[1];
			else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
		}
		if (fence) return message;
		const entities: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
		const reason = marker[1].replace(/&(quot|amp|lt|gt|apos);/g, (_, entity: string) => entities[entity]).trim();
		if (!reason) return message;
		lastText.text = lastText.text.slice(0, marker.index).trimEnd();
		delete lastText.textSignature;
		const result = { ...message, content };
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
			return result;
		if (content.some((block) => block.type === "toolCall")) {
			return { ...result, stopReason: "error", errorMessage: "Work control cannot be mixed with tool calls" };
		}
		if (record?.status !== "active") return result;
		const summary = content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		result.content.push({
			type: "toolCall",
			id: `call_${randomUUID()}`,
			name: "finish_work",
			arguments: {
				checkpointId: record.checkpointId,
				outcome: "completed",
				reason,
				summary: summary.trim() ? summary : reason,
			},
		});
		return { ...result, stopReason: "toolUse" };
	}
}
