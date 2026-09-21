import type { ToolDefinition } from "../extensions/types.ts";
import { type WaitForUserDecision, type WaitForUserInput, waitForUserSchema } from "../work-contract.ts";

/** Stop the current run after durably recording that the checkpoint awaits user input. */
export function createWaitForUserToolDefinition(
	wait: (input: WaitForUserInput, signal?: AbortSignal) => WaitForUserDecision,
): ToolDefinition<typeof waitForUserSchema, WaitForUserDecision> {
	return {
		name: "wait_for_user",
		label: "Wait for User",
		description:
			"Ask the user one question and pause the active work checkpoint without starting another inference. Supply the complete question. Call this alone, without accompanying assistant text or other tools.",
		errorBehavior: "park",
		promptSnippet: "Ask one question and pause work until the user replies",
		promptGuidelines: [
			"When you need information or a decision from the user, call wait_for_user instead of asking in ordinary assistant text.",
			"Put the complete user-facing question only in wait_for_user.question, without accompanying assistant text.",
			"wait_for_user pauses the checkpoint and ends the current run. Continue only after new user input arrives.",
		],
		parameters: waitForUserSchema,
		async execute(_toolCallId, input, signal) {
			if (signal?.aborted) throw new Error("Work was interrupted");
			const committed = wait(input, signal);
			return {
				content: [{ type: "text", text: committed.question }],
				details: committed,
				terminate: true,
			};
		},
	};
}
