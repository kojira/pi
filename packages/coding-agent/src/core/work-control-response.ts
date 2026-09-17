import type { AssistantMessage } from "@earendil-works/pi-ai";

export const WORK_CONTROL_PROMPT = `Continue working within the authorized scope until you have a reason to stop.
To end work, call finish_work with the current checkpoint ID, outcome, nonempty reason and summary.
Put the final answer only in finish_work.summary. Do not also write it as assistant text.
Do not output an ending marker. Do not mix finish_work with other tool calls.
For an intermediate progress update, reply with ordinary text without calling finish_work.
A text-only reply does not finish work: Pi automatically runs the next inference with the existing conversation. No continuation marker or continuation tool is needed.`;

/** Finish summaries are the sole public answer for their response; never synthesize tool calls from prose. */
export function normalizeWorkResponse(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return message;
	if (!message.content.some((block) => block.type === "toolCall" && block.name === "finish_work")) return message;
	return { ...message, content: structuredClone(message.content.filter((block) => block.type !== "text")) };
}
