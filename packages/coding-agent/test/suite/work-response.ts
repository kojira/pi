import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Harness } from "./harness.ts";

/** Explicitly compliant final response fixture; do not use for summaries or protocol-error tests. */
export function workResponse(text: string) {
	return fauxAssistantMessage(
		`${text}\n<work-control>{"action":"finish","outcome":"completed","reason":"Fixture work complete"}</work-control>`,
	);
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
			return workResponse("Response interrupted before completion");
		},
	]);
	const prompt = harness.session.prompt("hi");
	await requestStarted;
	await harness.session.abort();
	await prompt;
}
