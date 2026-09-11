import type { ToolDefinition } from "../extensions/types.ts";
import { type FinishWorkInput, finishWorkSchema } from "../work-contract.ts";

/** The session must validate and durably commit the decision before returning success. */
export function createFinishWorkToolDefinition(
	finish: (decision: FinishWorkInput, signal?: AbortSignal) => void,
): ToolDefinition<typeof finishWorkSchema, FinishWorkInput> {
	return {
		name: "finish_work",
		label: "Finish Work",
		description:
			"Explicitly finish the active work checkpoint as completed, cancelled, waiting, or blocked. Supply the current checkpoint ID, the reason, and the final summary for the user. Call this alone, without other tools in the same response.",
		promptSnippet: "Resolve an active work checkpoint with an explicit decision and final summary",
		promptGuidelines: [
			"While a work checkpoint is active, keep executing authorized work until you call finish_work.",
			"A text-only reply does not finish an active checkpoint. Incorporate new user instructions before deciding.",
		],
		parameters: finishWorkSchema,
		async execute(_toolCallId, decision, signal) {
			if (signal?.aborted) throw new Error("Work was interrupted");
			finish(decision, signal);
			return {
				content: [{ type: "text", text: decision.summary }],
				details: decision,
				terminate: true,
			};
		},
	};
}
