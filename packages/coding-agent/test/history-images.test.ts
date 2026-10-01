import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { limitHistoryImages, OMITTED_HISTORY_IMAGE_TEXT } from "../src/core/history-images.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const image = (id: string) => ({ type: "image" as const, mimeType: "image/png", data: id });

function history(): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "look" }, image("u1")], timestamp: 1 },
		{
			role: "toolResult",
			toolCallId: "a",
			toolName: "read",
			content: [{ type: "text", text: "Read image file" }, image("t1")],
			isError: false,
			timestamp: 2,
		},
		{ role: "user", content: "plain text", timestamp: 3 },
		{
			role: "toolResult",
			toolCallId: "b",
			toolName: "read",
			content: [image("t2"), image("t3")],
			isError: false,
			timestamp: 4,
		},
	] as Message[];
}

const imageIds = (messages: Message[]) =>
	messages.flatMap((m) =>
		Array.isArray(m.content)
			? m.content.filter((b) => b.type === "image").map((b) => (b as { data: string }).data)
			: [],
	);

describe("limitHistoryImages", () => {
	it("returns the same array when unlimited or under the limit", () => {
		const messages = history();
		expect(limitHistoryImages(messages, undefined)).toBe(messages);
		expect(limitHistoryImages(messages, 4)).toBe(messages);
		expect(limitHistoryImages(messages, 10)).toBe(messages);
	});

	it("keeps only the newest images and replaces older ones with a note", () => {
		const messages = history();
		const limited = limitHistoryImages(messages, 2);
		expect(imageIds(limited)).toEqual(["t2", "t3"]);
		expect(limited[0].content).toEqual([
			{ type: "text", text: "look" },
			{ type: "text", text: OMITTED_HISTORY_IMAGE_TEXT },
		]);
		expect(limited[1].content).toEqual([
			{ type: "text", text: "Read image file" },
			{ type: "text", text: OMITTED_HISTORY_IMAGE_TEXT },
		]);
		expect(limited[2]).toBe(messages[2]);
		expect(limited[3]).toBe(messages[3]);
		// input is not mutated
		expect(imageIds(messages)).toEqual(["u1", "t1", "t2", "t3"]);
	});

	it("collapses consecutive omitted images into one note", () => {
		const limited = limitHistoryImages(history(), 0);
		expect(imageIds(limited)).toEqual([]);
		expect(limited[3].content).toEqual([{ type: "text", text: OMITTED_HISTORY_IMAGE_TEXT }]);
	});
});

describe("images.maxHistoryImages setting", () => {
	it("defaults to unlimited and ignores invalid values", () => {
		expect(SettingsManager.inMemory({}).getMaxHistoryImages()).toBeUndefined();
		expect(SettingsManager.inMemory({ images: { maxHistoryImages: -1 } }).getMaxHistoryImages()).toBeUndefined();
		expect(SettingsManager.inMemory({ images: { maxHistoryImages: 3.7 } }).getMaxHistoryImages()).toBe(3);
	});

	describe("session wiring", () => {
		let tempDir: string;
		beforeEach(() => {
			tempDir = join(tmpdir(), `pi-history-images-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(tempDir, "agent"), { recursive: true });
		});
		afterEach(() => {
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});

		async function convert(settings: SettingsManager) {
			const agentDir = join(tempDir, "agent");
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
			const modelRuntime = await ModelRuntime.create({
				credentials: authStorage,
				modelsPath: join(agentDir, "models.json"),
			});
			const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager: settings });
			await resourceLoader.reload();
			const { session } = await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager: settings,
				sessionManager: SessionManager.inMemory(),
				modelRuntime,
				resourceLoader,
			});
			try {
				return await session.agent.convertToLlm(history());
			} finally {
				session.dispose();
			}
		}

		it("applies the limit to the request context and sends every image by default", async () => {
			expect(imageIds(await convert(SettingsManager.inMemory({})))).toEqual(["u1", "t1", "t2", "t3"]);
			expect(imageIds(await convert(SettingsManager.inMemory({ images: { maxHistoryImages: 1 } })))).toEqual(["t3"]);
		});

		it("still lets blockImages remove the remaining images", async () => {
			const converted = await convert(
				SettingsManager.inMemory({ images: { maxHistoryImages: 1, blockImages: true } }),
			);
			expect(imageIds(converted)).toEqual([]);
		});
	});
});
