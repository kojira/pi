import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type FinishWorkInput, WorkContract, type WorkContractRecord } from "../src/core/work-contract.ts";

const decision: FinishWorkInput = {
	checkpointId: "checkpoint-1",
	outcome: "completed",
	reason: "Approved changes are verified",
	summary: "Changes implemented; not deployed",
};

describe("explicit work contract", () => {
	it("rejects stale decisions without resolving or overwriting the checkpoint", () => {
		const records: WorkContractRecord[] = [];
		const contract = new WorkContract((record) => records.push(record));
		contract.begin("checkpoint-1", "Implement the approved change");
		expect(() => contract.finish(decision, 1, 2)).toThrow("New input arrived");
		expect(contract.active).toBe(true);
		contract.begin("checkpoint-2", "Verify the revised change");
		expect(() => contract.finish(decision, 2, 2)).toThrow("Stale work checkpoint");
		expect(records).toHaveLength(2);
		contract.finish({ ...decision, checkpointId: "checkpoint-2" }, 2, 2);
		expect(contract.state).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
	});

	it("pauses for user input and resumes the same checkpoint only after input", () => {
		const records: WorkContractRecord[] = [];
		const contract = new WorkContract((record) => records.push(record));
		contract.begin("checkpoint-1", "Confirm the test account");
		contract.waitForUser({ checkpointId: "checkpoint-1", question: "Which account should I use?" }, 1, 1);
		expect(contract.state).toEqual({
			status: "awaiting_input",
			checkpointId: "checkpoint-1",
			nextAction: "Confirm the test account",
			question: "Which account should I use?",
		});
		expect(contract.active).toBe(false);
		expect(contract.awaitingInput).toBe(true);
		contract.resumeAwaitingInput();
		expect(contract.state).toEqual({
			status: "active",
			checkpointId: "checkpoint-1",
			nextAction: "Confirm the test account",
		});
		expect(records).toHaveLength(3);
	});

	it("restores an awaiting-input checkpoint without suspending it", () => {
		const records: WorkContractRecord[] = [];
		const restored = new WorkContract((record) => records.push(record), {
			status: "awaiting_input",
			checkpointId: "checkpoint-1",
			nextAction: "Confirm the test account",
			question: "Which account should I use?",
		});
		expect(restored.state?.status).toBe("awaiting_input");
		expect(records).toHaveLength(0);
	});

	it("restores active work as suspended without executing it", () => {
		const records: WorkContractRecord[] = [];
		const restored = new WorkContract((record) => records.push(record), {
			status: "active",
			checkpointId: "checkpoint-1",
			nextAction: "Run verification",
		});
		expect(restored.state?.status).toBe("suspended");
		expect(records).toHaveLength(1);
		expect(() => restored.finish(decision, 1, 1)).toThrow("No active work contract");
	});

	it.each(["finish_work", "wait_for_user"])("rejects a mixed %s batch before any tool executes", (name) => {
		const contract = new WorkContract(() => {});
		const args =
			name === "finish_work" ? decision : { checkpointId: "checkpoint-1", question: "Which account should I use?" };
		const message = fauxAssistantMessage([
			fauxToolCall("write", { path: "file", content: "change" }),
			fauxToolCall(name, args),
		]) as AssistantMessage;
		expect(() => contract.validateBatch(message)).toThrow("only tool call");
	});

	it("rejects a stale wait decision without pausing", () => {
		const contract = new WorkContract(() => {});
		contract.begin("checkpoint-1", "Confirm the test account");
		expect(() => contract.waitForUser({ checkpointId: "checkpoint-1", question: "Which account?" }, 1, 2)).toThrow(
			"New input arrived",
		);
		expect(contract.active).toBe(true);
	});

	it("does not publish a successful transition when persistence fails", () => {
		const contract = new WorkContract(() => {
			throw new Error("disk failure");
		});
		expect(() => contract.begin("checkpoint-1", "Run verification")).toThrow("disk failure");
		expect(contract.state).toBeUndefined();
	});
});
