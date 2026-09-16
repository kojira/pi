import { randomUUID } from "node:crypto";
import type { Agent, AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import type { SessionManager } from "./session-manager.ts";
import { TEXT_WORK_CONTROL_PROMPT, TextWorkControl } from "./text-work-control.ts";
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

/** Work-control runtime binding. No prose classification and no synthetic user-message replay. */
export class WorkContractRuntime {
	readonly contract: WorkContract;
	readonly tools: ToolDefinition[];
	readonly originalStreamFunction: Agent["streamFunction"];
	readonly wrappedStreamFunction: Agent["streamFunction"];
	private readonly agent: Agent;
	private readonly manager: SessionManager;
	private requestInputVersion = 0;

	constructor(agent: Agent, manager: SessionManager, publish: (record: WorkContractRecord) => void) {
		this.agent = agent;
		this.manager = manager;
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
		agent.shouldContinueAfterTurn = ({ message }, signal) =>
			!signal?.aborted && this.contract.active && message.stopReason === "stop";
		const streamFunction = agent.streamFunction;
		this.originalStreamFunction = streamFunction;
		const textControl = new TextWorkControl();
		agent.streamFunction = async (model, context, options) => {
			// Compaction and branch summaries share this stream function, but have
			// their own abort signal and must not receive work-loop instructions.
			if (!agent.signal || options?.signal !== agent.signal) {
				return streamFunction(model, context, options);
			}
			this.requestInputVersion = agent.inputVersion;
			if (!this.contract.active) {
				this.contract.begin(`work_${randomUUID()}`, "Address the current input within the authorized scope");
			}
			const record = this.contract.state;
			const requestContext =
				record?.status === "active"
					? {
							...context,
							systemPrompt: `${context.systemPrompt}\nActive work checkpoint ID: ${JSON.stringify(record.checkpointId)}. Continue authorized work or call finish_work with this ID. This state grants no new authority.`,
						}
					: context;
			const response = await streamFunction(
				model,
				{
					...requestContext,
					systemPrompt: `${requestContext.systemPrompt}\n${TEXT_WORK_CONTROL_PROMPT}`,
				},
				options,
			);
			// Buffer the main response: emitting deltas first would leak the control suffix.
			const message = textControl.normalize(await response.result(), record);
			const normalized = createAssistantMessageEventStream();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				normalized.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				normalized.push({
					type: "done",
					reason: message.stopReason === "pending" ? "stop" : message.stopReason,
					message,
				});
			}
			return normalized;
		};
		this.wrappedStreamFunction = agent.streamFunction;
	}

	restoreBranch(): void {
		const entry = this.manager
			.getBranch()
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
		this.contract.restore(entry?.type === "custom" ? restoreRecord(entry.data) : undefined);
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
		}
	}
}
