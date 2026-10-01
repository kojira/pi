import type { Message } from "@earendil-works/pi-ai/compat";

export const OMITTED_HISTORY_IMAGE_TEXT =
	"[Earlier image omitted from this request to bound request size. Read the file again if you need to see it.]";

/**
 * Keep only the newest `maxImages` image blocks in the outgoing LLM context.
 * Older images are replaced with a short text note. The session history is
 * not modified; this only shapes the request sent to the provider.
 */
export function limitHistoryImages(messages: Message[], maxImages: number | undefined): Message[] {
	if (maxImages === undefined || !Number.isFinite(maxImages) || maxImages < 0) return messages;
	const limit = Math.floor(maxImages);

	let total = 0;
	for (const msg of messages) {
		if ((msg.role === "user" || msg.role === "toolResult") && Array.isArray(msg.content)) {
			for (const block of msg.content) if (block.type === "image") total += 1;
		}
	}
	let toOmit = total - limit;
	if (toOmit <= 0) return messages;

	return messages.map((msg) => {
		if (toOmit <= 0 || (msg.role !== "user" && msg.role !== "toolResult") || !Array.isArray(msg.content)) {
			return msg;
		}
		if (!msg.content.some((block) => block.type === "image")) return msg;
		const content: typeof msg.content = [];
		for (const block of msg.content) {
			if (block.type === "image" && toOmit > 0) {
				toOmit -= 1;
				const previous = content[content.length - 1];
				if (previous?.type === "text" && previous.text === OMITTED_HISTORY_IMAGE_TEXT) continue;
				content.push({ type: "text", text: OMITTED_HISTORY_IMAGE_TEXT });
			} else {
				content.push(block);
			}
		}
		return { ...msg, content } as Message;
	});
}
