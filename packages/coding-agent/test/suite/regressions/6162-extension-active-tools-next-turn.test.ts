import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";
import { workResponse } from "../work-response.ts";

describe("extension active tools next-turn refresh", () => {
	it("applies pi.setActiveTools before the next provider request in the same run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return workResponse("done", context);
				},
			]);

			expect(harness.session.getActiveToolNames().sort()).toEqual([
				"continue_work",
				"finish_work",
				"switch_tools",
				"wait_for_user",
			]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames().sort()).toEqual([
				"after_switch",
				"continue_work",
				"finish_work",
				"wait_for_user",
			]);
			expect(providerToolNames).toEqual([
				["continue_work", "finish_work", "switch_tools", "wait_for_user"],
				["after_switch", "continue_work", "finish_work", "wait_for_user"],
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("records additive active tool changes on the current tool result", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "load_more_tools",
					label: "Load More Tools",
					description: "Load more tools",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools([...pi.getActiveTools(), "after_load"]);
						return {
							content: [{ type: "text", text: "loaded" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_load",
					label: "After Load",
					description: "Tool available after loading",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.session.setActiveToolsByName(["load_more_tools"]);

			const addedToolNames: string[][] = [];
			harness.setResponses([
				() => fauxAssistantMessage(fauxToolCall("load_more_tools", {}), { stopReason: "toolUse" }),
				(context) => {
					addedToolNames.push(
						context.messages
							.filter((message) => message.role === "toolResult")
							.flatMap((message) => message.addedToolNames ?? []),
					);
					return workResponse("done", context);
				},
			]);

			await harness.session.prompt("start");

			expect(harness.session.getActiveToolNames().sort()).toEqual([
				"after_load",
				"continue_work",
				"finish_work",
				"load_more_tools",
				"wait_for_user",
			]);
			expect(addedToolNames).toEqual([["after_load"]]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves before_agent_start system prompt overrides when tools change mid-run", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("before_agent_start", async (event) => ({
					systemPrompt: `${event.systemPrompt}\n\nkeep this run override`,
				}));

				pi.registerTool({
					name: "switch_tools",
					label: "Switch Tools",
					description: "Switch the active extension tool set",
					promptSnippet: "Switch to the next extension tool",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setActiveTools(["after_switch"]);
						return {
							content: [{ type: "text", text: "switched" }],
							details: {},
						};
					},
				});

				pi.registerTool({
					name: "after_switch",
					label: "After Switch",
					description: "Tool that should be available after switching",
					promptSnippet: "Run after the active tool set changes",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "after" }],
						details: {},
					}),
				});
			},
		];
		const harness = await createHarness({
			extensionFactories,
		});

		try {
			harness.session.setActiveToolsByName(["switch_tools"]);

			const providerSystemPrompts: string[] = [];
			const providerToolNames: string[][] = [];
			harness.setResponses([
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return fauxAssistantMessage(fauxToolCall("switch_tools", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerSystemPrompts.push(context.systemPrompt ?? "");
					providerToolNames.push((context.tools ?? []).map((tool) => tool.name).sort());
					return workResponse("done", context);
				},
			]);

			await harness.session.prompt("start");

			expect(providerToolNames).toEqual([
				["continue_work", "finish_work", "switch_tools", "wait_for_user"],
				["after_switch", "continue_work", "finish_work", "wait_for_user"],
			]);
			expect(providerSystemPrompts).toHaveLength(2);
			expect(providerSystemPrompts[0]).toContain("keep this run override");
			expect(providerSystemPrompts[1]).toContain("keep this run override");
		} finally {
			harness.cleanup();
		}
	});
});
