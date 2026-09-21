import type { AssistantMessage } from "@earendil-works/pi-ai";

export const WORK_CONTROL_PROMPT = `Continue working within the authorized scope until you have a reason to stop.
To end work, call finish_work with outcome, nonempty reason and summary.
Put the final answer only in finish_work.summary. Do not also write it as assistant text.
When you need information or a decision from the user, call wait_for_user with the complete question.
Put the question only in wait_for_user.question. Do not also ask it as assistant text. The tool pauses work without starting another inference.
Do not output an ending marker. Do not mix finish_work or wait_for_user with other tool calls.
For an intermediate progress update, reply with ordinary text without calling a work-control tool.
A text-only reply does not finish or pause work: Pi automatically runs the next inference with the existing conversation. No continuation marker or continuation tool is needed.`;

/** Work-control tool results are the sole public text for their response; never synthesize tool calls from prose. */
export function normalizeWorkResponse(message: AssistantMessage): AssistantMessage {
	if (message.stopReason !== "stop" && message.stopReason !== "toolUse") return message;
	if (
		!message.content.some(
			(block) => block.type === "toolCall" && (block.name === "finish_work" || block.name === "wait_for_user"),
		)
	) {
		return message;
	}
	return { ...message, content: structuredClone(message.content.filter((block) => block.type !== "text")) };
}
