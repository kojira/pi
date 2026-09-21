import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type FinishWorkInput, WorkContract, type WorkContractRecord } from "../src/core/work-contract.ts";

const decision: FinishWorkInput = {
	outcome: "completed",
	reason: "Approved changes are verified",
	summary: "Changes implemented; not deployed",
};

describe("explicit work contract", () => {
	it("finishes current work before starting newly queued work", () => {
		const records: WorkContractRecord[] = [];
		const contract = new WorkContract((record) => records.push(record));
		contract.begin("Implement the approved change");
		const committed = contract.finish(decision);
		expect(committed).toEqual(decision);
		expect(contract.state).toMatchObject({ status: "resolved", decision: { outcome: "completed" } });
		contract.begin("Address newly queued input");
		expect(contract.state).toEqual({ status: "active", nextAction: "Address newly queued input" });
		expect(contract.state).not.toHaveProperty("checkpointId");
		expect(records).toHaveLength(3);
	});

	it("waits without creating or returning a work identifier", () => {
		const contract = new WorkContract(() => {});
		contract.begin("Confirm the test account");
		const committed = contract.waitForUser({ question: "Which account should I use?" });
		expect(committed).toEqual({ question: "Which account should I use?" });
		expect(contract.state).toMatchObject({ status: "awaiting_input" });
		expect(contract.state).not.toHaveProperty("checkpointId");
	});

	it("pauses for user input and resumes the same work only after input", () => {
		const records: WorkContractRecord[] = [];
		const contract = new WorkContract((record) => records.push(record));
		contract.begin("Confirm the test account");
		contract.waitForUser({ question: "Which account should I use?" });
		expect(contract.state).toEqual({
			status: "awaiting_input",
			nextAction: "Confirm the test account",
			question: "Which account should I use?",
		});
		expect(contract.active).toBe(false);
		expect(contract.awaitingInput).toBe(true);
		contract.resumeAwaitingInput();
		expect(contract.state).toEqual({ status: "active", nextAction: "Confirm the test account" });
		expect(records).toHaveLength(3);
	});

	it("restores an awaiting-input work state without suspending it", () => {
		const records: WorkContractRecord[] = [];
		const restored = new WorkContract((record) => records.push(record), {
			status: "awaiting_input",
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
			nextAction: "Run verification",
		});
		expect(restored.state?.status).toBe("suspended");
		expect(records).toHaveLength(1);
		expect(() => restored.finish(decision)).toThrow("No active work contract");
	});

	it.each(["finish_work", "wait_for_user"])("rejects a mixed %s batch before any tool executes", (name) => {
		const contract = new WorkContract(() => {});
		const args = name === "finish_work" ? decision : { question: "Which account should I use?" };
		const message = fauxAssistantMessage([
			fauxToolCall("write", { path: "file", content: "change" }),
			fauxToolCall(name, args),
		]) as AssistantMessage;
		expect(() => contract.validateBatch(message)).toThrow("only tool call");
	});

	it("records waiting before later input resumes the same work", () => {
		const contract = new WorkContract(() => {});
		contract.begin("Confirm the test account");
		contract.waitForUser({ question: "Which account?" });
		expect(contract.awaitingInput).toBe(true);
		contract.resumeAwaitingInput();
		expect(contract.active).toBe(true);
	});

	it("does not publish a successful transition when persistence fails", () => {
		const contract = new WorkContract(() => {
			throw new Error("disk failure");
		});
		expect(() => contract.begin("Run verification")).toThrow("disk failure");
		expect(contract.state).toBeUndefined();
	});
});
