import type { ToolDefinition } from "../extensions/types.ts";
import { type FinishWorkDecision, type FinishWorkInput, finishWorkSchema } from "../work-contract.ts";

/** The session must validate and durably commit the decision before returning success. */
export function createFinishWorkToolDefinition(
	finish: (decision: FinishWorkInput, signal?: AbortSignal) => FinishWorkDecision,
): ToolDefinition<typeof finishWorkSchema, FinishWorkDecision> {
	return {
		name: "finish_work",
		label: "Finish Work",
		description:
			"Explicitly finish the active work checkpoint as completed, cancelled, waiting, or blocked. Supply the reason and final summary for the user. Call this alone, without other tools in the same response.",
		errorBehavior: "park",
		promptSnippet: "Resolve an active work checkpoint with an explicit decision and final summary",
		promptGuidelines: [
			"While a work checkpoint is active, keep executing authorized work until you call finish_work.",
			"A text-only reply does not finish an active checkpoint. Incorporate new user instructions before deciding.",
			"Put the final answer only in finish_work.summary, without accompanying assistant text. Do not use a text ending marker.",
		],
		parameters: finishWorkSchema,
		async execute(_toolCallId, decision, signal) {
			if (signal?.aborted) throw new Error("Work was interrupted");
			const committed = finish(decision, signal);
			return {
				content: [{ type: "text", text: committed.summary }],
				details: committed,
				terminate: true,
			};
		},
	};
}
