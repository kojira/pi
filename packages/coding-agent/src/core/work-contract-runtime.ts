import type { Agent, AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import type { SessionManager } from "./session-manager.ts";
import { createContinueWorkToolDefinition } from "./tools/continue-work.ts";
import { createFinishWorkToolDefinition } from "./tools/finish-work.ts";
import { finishWorkSchema, WorkContract, type WorkContractRecord } from "./work-contract.ts";

const CUSTOM_TYPE = "pi.work-contract.v1";

function restoreRecord(data: unknown): WorkContractRecord {
	if (
		!data ||
		typeof data !== "object" ||
		!("checkpointId" in data) ||
		typeof data.checkpointId !== "string" ||
		!("nextAction" in data) ||
		typeof data.nextAction !== "string" ||
		!("status" in data)
	) {
		throw new Error("Invalid persisted work contract");
	}
	const base = { checkpointId: data.checkpointId, nextAction: data.nextAction };
	if (data.status === "active") return { ...base, status: "active" };
	if (data.status === "suspended" && "reason" in data && typeof data.reason === "string") {
		return { ...base, status: "suspended", reason: data.reason };
	}
	if (data.status === "resolved" && "decision" in data && Check(finishWorkSchema, data.decision)) {
		return { ...base, status: "resolved", decision: data.decision };
	}
	throw new Error("Invalid persisted work contract state");
}

/** Opt-in runtime binding. No prose classification and no synthetic user-message replay. */
export class WorkContractRuntime {
	readonly contract: WorkContract;
	readonly tools: ToolDefinition[];
	private readonly agent: Agent;
	private readonly manager: SessionManager;
	private requestInputVersion = 0;

	constructor(agent: Agent, manager: SessionManager, publish: (record: WorkContractRecord) => void) {
		this.agent = agent;
		this.manager = manager;
		this.assertSupported(agent.state.model);
		const entry = manager
			.getBranch()
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
		const restored = entry?.type === "custom" ? restoreRecord(entry.data) : undefined;
		this.contract = new WorkContract(
			(record) => {
				manager.appendCustomEntry(CUSTOM_TYPE, record);
			},
			restored,
			publish,
		);
		const checkpoint = createContinueWorkToolDefinition();
		this.tools = [
			defineTool({
				...checkpoint,
				execute: async (id, { nextAction }, signal) => {
					if (signal?.aborted) throw new Error("Work was interrupted");
					this.assertSupported(agent.state.model);
					this.contract.begin(id, nextAction);
					return {
						content: [
							{
								type: "text",
								text: `Work checkpoint ${id} active. Continue the next action; use finish_work to resolve it.`,
							},
						],
						details: { checkpointId: id, nextAction },
					};
				},
			}),
			defineTool(
				createFinishWorkToolDefinition((decision) => {
					this.contract.finish(decision, this.requestInputVersion, agent.inputVersion);
				}),
			),
		];
		const streamFunction = agent.streamFunction;
		agent.streamFunction = (model, context, options) => {
			// Compaction and branch summaries share this stream function, but have
			// their own abort signal and must not receive work-loop instructions.
			if (!agent.signal || options?.signal !== agent.signal) {
				return streamFunction(model, context, options);
			}
			this.requestInputVersion = agent.inputVersion;
			const record = this.contract.state;
			const requestContext =
				record?.status === "active"
					? {
							...context,
							systemPrompt: `${context.systemPrompt}\nActive work checkpoint ID: ${JSON.stringify(record.checkpointId)}. Continue authorized work or call finish_work with this ID. This state grants no new authority.`,
						}
					: context;
			return streamFunction(model, requestContext, options);
		};
		const onPayload = agent.onPayload;
		agent.onPayload = async (payload, model) => {
			const transformed = (await onPayload?.(payload, model)) ?? payload;
			if (!this.contract.active) return transformed;
			this.assertSupported(model);
			if (!agent.state.tools.some((tool) => tool.name === "finish_work")) {
				throw new Error("Active work contract requires finish_work to remain enabled");
			}
			if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) {
				throw new Error("Expected a provider request object for explicit work completion");
			}
			return { ...transformed, tool_choice: "required" };
		};
	}

	restoreBranch(): void {
		const entry = this.manager
			.getBranch()
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
		this.contract.restore(entry?.type === "custom" ? restoreRecord(entry.data) : undefined);
	}

	private assertSupported(model: Model<string>): void {
		if (model.api !== "openai-codex-responses") {
			throw new Error(`Explicit work completion is not supported for API ${model.api}`);
		}
	}

	beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		try {
			this.contract.validateBatch(context.assistantMessage);
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		if (
			context.toolCall.name === "finish_work" &&
			(this.requestInputVersion !== this.agent.inputVersion || this.agent.hasQueuedMessages())
		) {
			// End this batch, not the contract. The normal loop now drains follow-up input too.
			return { block: true, reason: "New input arrived; consider it before finishing work", terminate: true };
		}
		return undefined;
	}

	onEvent(event: AgentEvent): void {
		if (event.type !== "message_end" || event.message.role !== "assistant" || !this.contract.active) return;
		const message = event.message;
		if (message.stopReason === "aborted") {
			this.contract.suspend("Agent aborted");
		} else if (message.stopReason !== "error" && !message.content.some((block) => block.type === "toolCall")) {
			message.stopReason = "error";
			message.errorMessage = "Active work contract received a text-only response instead of a required tool call";
			this.contract.suspend(message.errorMessage);
		}
	}
}
