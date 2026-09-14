/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { ExtensionContext, RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const ctx = runner.createContext();
			const disposeRecipient = createActiveSteeringRecipient(registeredTool, toolCallId, params, signal, ctx);
			const activeBefore = runner.getActiveTools();
			let result: Awaited<ReturnType<typeof registeredTool.definition.execute>>;
			try {
				result = await registeredTool.definition.execute(toolCallId, params, signal, onUpdate, ctx);
			} finally {
				disposeRecipient?.();
			}
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

function createActiveSteeringRecipient(
	registeredTool: RegisteredTool,
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): (() => void) | undefined {
	if (registeredTool.definition.name !== "subagent") return undefined;
	if (typeof params !== "object" || params === null) return undefined;
	const paramsRecord = params as Record<string, unknown>;
	if (paramsRecord.action !== undefined) return undefined;

	return ctx.pushSteeringRecipient({
		id: toolCallId,
		label: "subagent",
		steer: async ({ text }) => {
			const result = await registeredTool.definition.execute(
				`${toolCallId}:steer`,
				{ action: "steer", id: toolCallId, message: text, mode: "auto", steeringRecovery: false },
				signal,
				undefined,
				ctx,
			);
			return (result as { isError?: boolean }).isError === true ? false : undefined;
		},
	});
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
