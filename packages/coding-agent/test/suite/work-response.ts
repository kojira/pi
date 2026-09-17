import { type AssistantMessage, type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Harness } from "./harness.ts";

/** Explicitly compliant final response fixture; do not use for summaries or protocol-error tests. */
export function workResponse(text: string): (context: Context) => AssistantMessage;
export function workResponse(text: string, context: Context): AssistantMessage;
export function workResponse(
	text: string,
	context?: Context,
): AssistantMessage | ((context: Context) => AssistantMessage) {
	const respond = (request: Context): AssistantMessage => {
		const match = /Active work checkpoint ID: ("(?:[^"\\]|\\.)*")/.exec(request.systemPrompt ?? "");
		if (!match) throw new Error("Final response fixture requires an active checkpoint");
		return fauxAssistantMessage(
			fauxToolCall("finish_work", {
				checkpointId: JSON.parse(match[1]),
				outcome: "completed",
				reason: "Fixture work complete",
				summary: text || "Fixture work complete",
			}),
			{ stopReason: "toolUse" },
		);
	};
	return context ? respond(context) : respond;
}

/** Abort while the provider is active, independently of public output buffering. */
export async function abortBufferedResponse(harness: Harness): Promise<void> {
	let started = () => {};
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	harness.setResponses([
		async (_context, options) => {
			if (!options?.signal) throw new Error("Missing request abort signal");
			await new Promise<void>((resolve) => {
				options.signal!.addEventListener("abort", () => resolve(), { once: true });
				started();
			});
			return workResponse("Response interrupted before completion", _context);
		},
	]);
	const prompt = harness.session.prompt("hi");
	await requestStarted;
	await harness.session.abort();
	await prompt;
}
