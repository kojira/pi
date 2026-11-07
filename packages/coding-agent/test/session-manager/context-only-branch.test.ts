import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomEntry, type SessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const PADDING = "x".repeat(20_000);

function assistantFrom(text: string, provider: string, model: string) {
	return { ...assistantMsg(text), provider, model };
}

function latestCustom(session: SessionManager, customType: string): unknown {
	const entry = session
		.getBranch()
		.reverse()
		.find(
			(candidate): candidate is CustomEntry => candidate.type === "custom" && candidate.customType === customType,
		);
	return entry?.data;
}

function expectSingleChain(entries: SessionEntry[]): void {
	const ids = new Set(entries.map((entry) => entry.id));
	expect(entries.filter((entry) => entry.parentId === null)).toHaveLength(1);
	for (const entry of entries) {
		if (entry.parentId !== null) expect(ids.has(entry.parentId)).toBe(true);
	}
}

/**
 * Builds a parent session with a large summarized prefix, two compactions, and a short tail:
 * header, thinking/model/name/custom state and labels before the cut, a side branch, and a
 * latest compaction whose firstKeptEntryId precedes it.
 */
function buildCompactedParent(dir: string) {
	const session = SessionManager.create(dir, dir);
	session.appendThinkingLevelChange("high");
	session.appendModelChange("anthropic", "first-model");
	session.appendSessionInfo("parent name");
	const cutLabelTarget = session.appendMessage(userMsg(`old question ${PADDING}`));
	session.appendLabelChange(cutLabelTarget, "old-bookmark");
	session.appendCustomEntry("pi.work-contract.v3", { state: "old" });
	session.appendCustomEntry("other-extension", { value: 1 });
	for (let i = 0; i < 10; i++) {
		session.appendMessage(userMsg(`old turn ${i} ${PADDING}`));
		session.appendMessage(assistantFrom(`old answer ${i} ${PADDING}`, "openai", "second-model"));
	}
	const sideBranchFrom = session.getLeafId()!;
	session.appendCustomMessageEntry("notice", `old notice ${PADDING}`, true);
	const firstCompactionKept = session.appendMessage(userMsg("kept by first compaction"));
	session.appendCompaction("first summary", firstCompactionKept, 1000);
	session.appendCustomEntry("pi.work-contract.v3", { state: "latest-before-cut" });
	session.appendMessage(assistantFrom(`middle answer ${PADDING}`, "openai", "second-model"));
	const firstKept = session.appendMessage(userMsg("first kept question"));
	session.appendLabelChange(firstKept, "kept-bookmark");
	session.appendMessage(assistantFrom("first kept answer", "openai", "second-model"));
	session.appendCompaction("latest summary", firstKept, 2000);
	session.appendCustomEntry("pi.work-contract.v3", { state: "after-cut" });
	session.appendMessage(userMsg("tail question"));
	const leafId = session.appendMessage(assistantFrom("tail answer", "openai", "second-model"));

	// A sibling branch that must not appear in the fork.
	session.branch(sideBranchFrom);
	session.appendMessage(userMsg("side branch"));
	session.branch(leafId);

	return { session, leafId, firstKept, cutLabelTarget, parentFile: session.getSessionFile()! };
}

describe("createBranchedSession contextOnly", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-context-only-fork-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes only the compacted context tail and restores the same context and state", () => {
		const { leafId, firstKept, cutLabelTarget, parentFile } = buildCompactedParent(dir);
		const parent = SessionManager.open(parentFile, dir);
		parent.branch(leafId);
		const parentContext = parent.buildSessionContext();
		const fullPathBytes = parent
			.getBranch(leafId)
			.reduce((sum, entry) => sum + Buffer.byteLength(`${JSON.stringify(entry)}\n`), 0);

		const source = SessionManager.open(parentFile, dir);
		const forkFile = source.createBranchedSession(leafId, { contextOnly: true });
		expect(forkFile).toBeDefined();

		const forkBytes = statSync(forkFile!).size;
		expect(fullPathBytes).toBeGreaterThan(400_000);
		expect(forkBytes).toBeLessThan(10_000);

		const fork = SessionManager.open(forkFile!, dir);
		expect(fork.getHeader()?.parentSession).toBe(parentFile);
		expect(fork.buildSessionContext()).toEqual(parentContext);
		expect(fork.buildSessionContext().thinkingLevel).toBe("high");
		expect(fork.buildSessionContext().model).toEqual({ provider: "openai", modelId: "second-model" });
		expect(fork.getSessionName()).toBe("parent name");
		expect(latestCustom(fork, "pi.work-contract.v3")).toEqual({ state: "after-cut" });
		expect(latestCustom(fork, "other-extension")).toEqual({ value: 1 });
		expect(fork.getLabel(firstKept)).toBe("kept-bookmark");
		expect(fork.getEntry(cutLabelTarget)).toBeUndefined();
		expect(fork.getEntries().some((entry) => entry.type === "label" && entry.targetId === cutLabelTarget)).toBe(
			false,
		);
		expect(fork.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
		expectSingleChain(fork.getEntries());

		fork.appendMessage(userMsg("child follow-up"));
		const resumed = SessionManager.open(forkFile!, dir);
		const resumedMessages = resumed.buildSessionContext().messages;
		expect(resumedMessages.slice(0, -1)).toEqual(parentContext.messages);
		expect(resumedMessages.at(-1)).toMatchObject({ role: "user", content: "child follow-up" });
		expectSingleChain(resumed.getEntries());
	});

	it("keeps the model established by a summarized assistant message", () => {
		const session = SessionManager.inMemory(dir);
		session.appendModelChange("anthropic", "first-model");
		session.appendMessage(userMsg("old question"));
		session.appendMessage(assistantFrom("old answer", "openai", "second-model"));
		const firstKept = session.appendMessage(userMsg("kept question"));
		const leafId = session.appendCompaction("summary", firstKept, 1000);
		const parentContext = session.buildSessionContext();

		session.createBranchedSession(leafId, { contextOnly: true });

		expect(session.buildSessionContext()).toEqual(parentContext);
		expect(session.buildSessionContext().model).toEqual({ provider: "openai", modelId: "second-model" });
		expect(session.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(
			false,
		);
	});

	it("copies a branch without compaction in full", () => {
		const session = SessionManager.create(dir, dir);
		session.appendModelChange("anthropic", "first-model");
		session.appendMessage(userMsg("question"));
		const leafId = session.appendMessage(assistantMsg("answer"));
		const parentFile = session.getSessionFile()!;

		const fullFile = SessionManager.open(parentFile, dir).createBranchedSession(leafId)!;
		const contextOnlyFile = SessionManager.open(parentFile, dir).createBranchedSession(leafId, {
			contextOnly: true,
		})!;

		const entriesOf = (file: string) =>
			readFileSync(file, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.type !== "session");
		expect(entriesOf(contextOnlyFile)).toEqual(entriesOf(fullFile));
	});

	it("keeps the full root-to-leaf path without the option", () => {
		const { leafId, parentFile } = buildCompactedParent(dir);
		const source = SessionManager.open(parentFile, dir);
		const fullPathIds = source.getBranch(leafId).filter((entry) => entry.type !== "label");

		const forkFile = source.createBranchedSession(leafId)!;

		const fork = SessionManager.open(forkFile, dir);
		const forkIds = fork
			.getEntries()
			.filter((entry) => entry.type !== "label")
			.map((entry) => entry.id);
		expect(forkIds).toEqual(fullPathIds.map((entry) => entry.id));
	});
});
