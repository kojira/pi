import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const continueWorkSchema = Type.Object({
	nextAction: Type.String({
		description: "Concrete, already-authorized action to perform immediately after this checkpoint",
		minLength: 1,
	}),
});

export const continueWorkToolSystemPromptContribution = {
	snippet: "Mark an assistant update as intermediate and continue from a tool-result boundary",
	guidelines: [
		"Use continue_work in the same response as an intermediate progress update when more approved work remains and no user decision is needed.",
		"After continue_work returns, perform its nextAction instead of emitting another progress-only update.",
		"Do not use continue_work when work is complete, blocked, cancelled, or waiting for user input.",
	],
} as const;

export type ContinueWorkToolInput = Static<typeof continueWorkSchema>;

export interface ContinueWorkToolDetails {
	nextAction: string;
}

export function createContinueWorkToolDefinition(): ToolDefinition<typeof continueWorkSchema, ContinueWorkToolDetails> {
	return {
		name: "continue_work",
		label: "Continue Work",
		description:
			"Create a continuation checkpoint after an intermediate progress update. The checkpoint keeps the current agent run active without adding a synthetic user message. Use only when the next action is already authorized and can begin immediately.",
		promptSnippet: continueWorkToolSystemPromptContribution.snippet,
		promptGuidelines: [...continueWorkToolSystemPromptContribution.guidelines],
		parameters: continueWorkSchema,
		async execute(_toolCallId, { nextAction }) {
			return {
				content: [{ type: "text", text: "Continuation checkpoint recorded." }],
				details: { nextAction },
			};
		},
	};
}

export function createContinueWorkTool(): AgentTool<typeof continueWorkSchema> {
	return wrapToolDefinition(createContinueWorkToolDefinition());
}
