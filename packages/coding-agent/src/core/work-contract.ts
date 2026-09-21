import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const workOutcomeSchema = Type.Union([
	Type.Literal("completed"),
	Type.Literal("cancelled"),
	Type.Literal("waiting"),
	Type.Literal("blocked"),
]);

/** Model-facing finish arguments. Work identity is implicit because only one contract can be active. */
export const finishWorkSchema = Type.Object({
	outcome: workOutcomeSchema,
	reason: Type.String({ minLength: 1 }),
	summary: Type.String({ minLength: 1 }),
});

export type FinishWorkInput = Static<typeof finishWorkSchema>;
export type FinishWorkDecision = FinishWorkInput;
export const finishWorkDecisionSchema = finishWorkSchema;

export const waitForUserSchema = Type.Object({
	question: Type.String({ minLength: 1 }),
});

export type WaitForUserInput = Static<typeof waitForUserSchema>;
export type WaitForUserDecision = WaitForUserInput;

export type WorkContractRecord = {
	nextAction: string;
} & (
	| { status: "active" }
	| { status: "awaiting_input"; question: string }
	| { status: "resolved"; decision: FinishWorkDecision }
	| { status: "suspended"; reason: string }
);

/** Logical work state, independent of physical agent idle and transcript compaction. */
export class WorkContract {
	private record: WorkContractRecord | undefined;
	private readonly persist: (record: WorkContractRecord) => void;
	private readonly publish?: (record: WorkContractRecord) => void;

	constructor(
		persist: (record: WorkContractRecord) => void,
		restored?: WorkContractRecord,
		publish?: (record: WorkContractRecord) => void,
	) {
		this.persist = persist;
		this.publish = publish;
		this.restore(restored);
	}

	restore(restored?: WorkContractRecord): void {
		this.record = restored ? structuredClone(restored) : undefined;
		if (restored?.status === "active") this.suspend("Session restored; explicit resumption is required");
	}

	get state(): WorkContractRecord | undefined {
		return this.record ? structuredClone(this.record) : undefined;
	}

	get active(): boolean {
		return this.record?.status === "active";
	}

	get awaitingInput(): boolean {
		return this.record?.status === "awaiting_input";
	}

	begin(nextAction: string): void {
		if (!nextAction.trim()) throw new Error("A next action is required");
		this.transition({ status: "active", nextAction });
	}

	/** Check the entire batch before a terminal or waiting decision can run alongside another tool. */
	validateBatch(message: AssistantMessage): void {
		const calls = message.content.filter((block) => block.type === "toolCall");
		const workDecision = calls.find((call) => call.name === "finish_work" || call.name === "wait_for_user");
		if (workDecision && calls.length !== 1) {
			throw new Error(`${workDecision.name} must be the only tool call in its batch`);
		}
	}

	waitForUser(input: WaitForUserInput): WaitForUserDecision {
		const current = this.record;
		if (current?.status !== "active") throw new Error("No active work contract");
		if (!input.question.trim()) throw new Error("A question is required");
		const decision: WaitForUserDecision = { question: input.question };
		this.transition({
			status: "awaiting_input",
			nextAction: current.nextAction,
			question: decision.question,
		});
		return decision;
	}

	resumeAwaitingInput(): void {
		const current = this.record;
		if (current?.status !== "awaiting_input") return;
		this.transition({
			status: "active",
			nextAction: current.nextAction,
		});
	}

	finish(decision: FinishWorkInput): FinishWorkDecision {
		const current = this.record;
		if (current?.status !== "active") throw new Error("No active work contract");
		if (!decision.reason.trim() || !decision.summary.trim()) throw new Error("A reason and summary are required");
		const committed: FinishWorkDecision = {
			outcome: decision.outcome,
			reason: decision.reason,
			summary: decision.summary,
		};
		this.transition({
			status: "resolved",
			nextAction: current.nextAction,
			decision: structuredClone(committed),
		});
		return committed;
	}

	suspend(reason: string): void {
		if (this.record?.status !== "active") return;
		this.transition({
			status: "suspended",
			nextAction: this.record.nextAction,
			reason,
		});
	}

	private transition(record: WorkContractRecord): void {
		// Commit before publishing. A failed durable append must not report success.
		this.persist(structuredClone(record));
		this.record = record;
		this.publish?.(structuredClone(record));
	}
}
