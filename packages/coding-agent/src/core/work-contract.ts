import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const finishWorkSchema = Type.Object({
	checkpointId: Type.String({ minLength: 1 }),
	outcome: Type.Union([
		Type.Literal("completed"),
		Type.Literal("cancelled"),
		Type.Literal("waiting"),
		Type.Literal("blocked"),
	]),
	reason: Type.String({ minLength: 1 }),
	summary: Type.String({ minLength: 1 }),
});

export type FinishWorkInput = Static<typeof finishWorkSchema>;

export type WorkContractRecord = {
	checkpointId: string;
	nextAction: string;
} & (
	| { status: "active" }
	| { status: "resolved"; decision: FinishWorkInput }
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

	begin(checkpointId: string, nextAction: string): void {
		if (!checkpointId.trim() || !nextAction.trim()) throw new Error("Checkpoint ID and next action are required");
		this.transition({ status: "active", checkpointId, nextAction });
	}

	/** Check the entire batch before any work tool can run alongside a finish decision. */
	validateBatch(message: AssistantMessage): void {
		const calls = message.content.filter((block) => block.type === "toolCall");
		if (calls.some((call) => call.name === "finish_work") && calls.length !== 1) {
			throw new Error("finish_work must be the only tool call in its batch");
		}
	}

	finish(decision: FinishWorkInput, requestInputVersion: number, currentInputVersion: number): void {
		const current = this.record;
		if (current?.status !== "active") throw new Error("No active work contract");
		if (decision.checkpointId !== current.checkpointId) throw new Error("Stale work checkpoint ID");
		if (requestInputVersion !== currentInputVersion) {
			throw new Error("New input arrived after this request started; consider it before finishing work");
		}
		if (!decision.reason.trim() || !decision.summary.trim()) throw new Error("A reason and summary are required");
		this.transition({
			status: "resolved",
			checkpointId: current.checkpointId,
			nextAction: current.nextAction,
			decision: structuredClone(decision),
		});
	}

	suspend(reason: string): void {
		if (this.record?.status !== "active") return;
		this.transition({
			status: "suspended",
			checkpointId: this.record.checkpointId,
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
