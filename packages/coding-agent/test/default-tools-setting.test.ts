import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession, type InlineExtension } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type ToolOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools" | "noTools" | "customTools">;

describe("defaultTools setting", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(
		defaultTools: string[],
		options: ToolOptions = {},
		extensionFactories: InlineExtension[] = [],
	) {
		const settingsManager = SettingsManager.inMemory({ defaultTools });
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		return (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
				...options,
			})
		).session;
	}

	it("uses the configured list as the initial built-in selection", async () => {
		const session = await createSession(["grep", "find"]);

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"bash",
			"continue_work",
			"edit",
			"find",
			"finish_work",
			"grep",
			"ls",
			"powershell",
			"read",
			"wait_for_user",
			"write",
		]);
		expect(session.getActiveToolNames()).toEqual(["grep", "find", "continue_work", "wait_for_user", "finish_work"]);
		expect(session.systemPrompt).toContain("- grep:");
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("can select powershell instead of bash", async () => {
		const session = await createSession(["read", "powershell", "edit", "write"]);

		expect(session.getActiveToolNames()).toEqual([
			"read",
			"powershell",
			"edit",
			"write",
			"continue_work",
			"wait_for_user",
			"finish_work",
		]);
		expect(session.systemPrompt).toContain("- powershell: Execute PowerShell commands");
		expect(session.systemPrompt).not.toContain("- bash:");
		session.dispose();
	});

	it("keeps all lifecycle controls available without work tools", async () => {
		const session = await createSession(["continue_work"]);

		expect(session.getActiveToolNames()).toEqual(["continue_work", "wait_for_user", "finish_work"]);
		expect(session.systemPrompt).toContain("- continue_work:");
		expect(session.systemPrompt).toContain("Ordinary progress replies continue automatically");
		expect(session.systemPrompt).toContain("Put the final answer only in finish_work.summary");
		expect(session.systemPrompt).not.toContain("Use continue_work in the same response");
		expect(session.systemPrompt).toContain("waiting for user input");
		session.dispose();
	});

	it("keeps extension and SDK custom tools enabled", async () => {
		const session = await createSession(
			["grep"],
			{
				customTools: [
					{
						name: "sdk_tool",
						label: "SDK Tool",
						description: "SDK custom tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					},
				],
			},
			[
				(pi) => {
					pi.registerTool({
						name: "static_tool",
						label: "Static Tool",
						description: "Statically registered extension tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Dynamically registered extension tool",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					});
				},
			],
		);
		await session.bindExtensions({});

		expect(session.getActiveToolNames().sort()).toEqual([
			"continue_work",
			"dynamic_tool",
			"finish_work",
			"grep",
			"sdk_tool",
			"static_tool",
			"wait_for_user",
		]);
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "dynamic_tool", "sdk_tool", "static_tool"]),
		);
		session.dispose();
	});

	it("preserves explicit tool option precedence", async () => {
		const allowlistedSession = await createSession(["grep"], { tools: ["read"] });
		expect(allowlistedSession.getActiveToolNames()).toEqual([
			"read",
			"continue_work",
			"wait_for_user",
			"finish_work",
		]);
		allowlistedSession.dispose();

		const excludedSession = await createSession(["read", "grep"], { excludeTools: ["read"] });
		expect(excludedSession.getActiveToolNames()).toEqual(["grep", "continue_work", "wait_for_user", "finish_work"]);
		excludedSession.dispose();

		const toolLessSession = await createSession(["read"], { noTools: "all" });
		expect(toolLessSession.getAllTools().map((tool) => tool.name)).toEqual([
			"continue_work",
			"wait_for_user",
			"finish_work",
		]);
		expect(toolLessSession.getActiveToolNames()).toEqual(["continue_work", "wait_for_user", "finish_work"]);
		toolLessSession.dispose();
	});

	it("applies through service-based session creation", async () => {
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["ls"] });
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(
			session
				.getAllTools()
				.map((tool) => tool.name)
				.sort(),
		).toEqual([
			"bash",
			"continue_work",
			"edit",
			"find",
			"finish_work",
			"grep",
			"ls",
			"powershell",
			"read",
			"wait_for_user",
			"write",
		]);
		expect(session.getActiveToolNames()).toEqual(["ls", "continue_work", "wait_for_user", "finish_work"]);
		session.dispose();
	});
});
