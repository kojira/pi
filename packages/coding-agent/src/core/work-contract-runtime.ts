import type { Agent, AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import type { SessionManager } from "./session-manager.ts";
import { createContinueWorkToolDefinition } from "./tools/continue-work.ts";
import { createFinishWorkToolDefinition } from "./tools/finish-work.ts";
import { createWaitForUserToolDefinition } from "./tools/wait-for-user.ts";
import { finishWorkDecisionSchema, WorkContract, type WorkContractRecord } from "./work-contract.ts";
import { normalizeWorkResponse, WORK_CONTROL_PROMPT } from "./work-control-response.ts";

// v3 removes checkpoint identity entirely. Older records remain readable, while
// older binaries ignore v3 instead of rejecting its intentionally smaller shape.
const CUSTOM_TYPE = "pi.work-contract.v3";
const LEGACY_CUSTOM_TYPES = new Set(["pi.work-contract.v2", "pi.work-contract.v1"]);
const isWorkContractEntry = (customType: string): boolean =>
	customType === CUSTOM_TYPE || LEGACY_CUSTOM_TYPES.has(customType);

function restoreRecord(data: unknown): WorkContractRecord {
	if (
		!data ||
		typeof data !== "object" ||
		!("nextAction" in data) ||
		typeof data.nextAction !== "string" ||
		!("status" in data)
	) {
		throw new Error("Invalid persisted work contract");
	}
	const base = { nextAction: data.nextAction };
	if (data.status === "active") return { ...base, status: "active" };
	if (data.status === "awaiting_input" && "question" in data && typeof data.question === "string") {
		return { ...base, status: "awaiting_input", question: data.question };
	}
	if (data.status === "suspended" && "reason" in data && typeof data.reason === "string") {
		return { ...base, status: "suspended", reason: data.reason };
	}
	if (data.status === "resolved" && "decision" in data && Check(finishWorkDecisionSchema, data.decision)) {
		return {
			...base,
			status: "resolved",
			decision: {
				outcome: data.decision.outcome,
				reason: data.decision.reason,
				summary: data.decision.summary,
			},
		};
	}
	throw new Error("Invalid persisted work contract state");
}

/** Work-control runtime binding. No prose classification and no synthetic user-message replay. */
export class WorkContractRuntime {
	readonly contract: WorkContract;
	readonly tools: ToolDefinition[];
	readonly originalStreamFunction: Agent["streamFunction"];
	readonly wrappedStreamFunction: Agent["streamFunction"];
	private readonly manager: SessionManager;
	private parkRequested = false;

	constructor(agent: Agent, manager: SessionManager, publish: (record: WorkContractRecord) => void) {
		this.manager = manager;
		const entry = manager
			.getBranch()
			.reverse()
			.find((entry) => entry.type === "custom" && isWorkContractEntry(entry.customType));
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
				execute: async (_id, { nextAction }, signal) => {
					if (signal?.aborted) throw new Error("Work was interrupted");
					this.contract.begin(nextAction);
					return {
						content: [{ type: "text", text: "Work remains active. Continue the recorded next action." }],
						details: { nextAction },
					};
				},
			}),
			defineTool(createWaitForUserToolDefinition((input) => this.contract.waitForUser(input))),
			defineTool(createFinishWorkToolDefinition((decision) => this.contract.finish(decision))),
		];
		agent.shouldContinueAfterTurn = ({ message }, signal) =>
			!signal?.aborted && this.contract.active && message.stopReason === "stop";
		const streamFunction = agent.streamFunction;
		this.originalStreamFunction = streamFunction;
		agent.streamFunction = async (model, context, options) => {
			// Compaction and branch summaries share this stream function, but have
			// their own abort signal and must not receive work-loop instructions.
			if (!agent.signal || options?.signal !== agent.signal) {
				return streamFunction(model, context, options);
			}
			if (this.contract.awaitingInput) this.contract.resumeAwaitingInput();
			if (!this.contract.active) {
				this.contract.begin("Address the current input within the authorized scope");
			}
			const record = this.contract.state;
			const requestContext =
				record?.status === "active"
					? {
							...context,
							systemPrompt: `${context.systemPrompt}\nWork is active. Continue authorized work or call finish_work. This state grants no new authority.`,
						}
					: context;
			const response = await streamFunction(
				model,
				{
					...requestContext,
					systemPrompt: `${requestContext.systemPrompt}\n${WORK_CONTROL_PROMPT}`,
				},
				options,
			);
			// Buffer the main response so finish_work summaries cannot duplicate already-emitted text.
			const message = normalizeWorkResponse(await response.result());
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
			.find((entry) => entry.type === "custom" && isWorkContractEntry(entry.customType));
		this.contract.restore(entry?.type === "custom" ? restoreRecord(entry.data) : undefined);
	}

	beforeToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		try {
			this.contract.validateBatch(context.assistantMessage);
		} catch (error) {
			return {
				block: true,
				reason: error instanceof Error ? error.message : String(error),
				terminate: true,
				park: true,
			};
		}
		return undefined;
	}

	onEvent(event: AgentEvent): void {
		if (event.type === "message_start" && event.message.role === "assistant") {
			// A new provider turn supersedes a park requested by an earlier tool batch,
			// for example when queued user input arrived while that batch was running.
			this.parkRequested = false;
			return;
		}
		if (event.type === "tool_execution_end") {
			// A work-decision attempt is a physical run boundary even when validation
			// or execution fails. Keep the logical checkpoint active and wait for real
			// user/native input instead of asking the model to repair or retry it.
			if (event.result?.terminate === true && event.result?.park === true) {
				this.parkRequested = true;
			}
			return;
		}
		if (event.type !== "message_end" || event.message.role !== "assistant" || !this.contract.active) return;
		if (event.message.stopReason === "aborted") {
			this.contract.suspend("Agent aborted");
		}
	}

	onSettled(): void {
		try {
			if (this.contract.active && !this.parkRequested) {
				this.contract.suspend("Agent settled without an explicit finish decision");
			}
		} finally {
			this.parkRequested = false;
		}
	}
}
