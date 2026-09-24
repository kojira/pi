// Opt-in, text-only Claude Agent SDK carrier. Pi alone validates and executes proposed tools.
// Load with `pi -e ./packages/coding-agent/examples/extensions/claude-sdk-structured/index.ts`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Query, query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	createProvider,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const API = "claude-sdk-structured";
const CLAUDE_CLI = process.env.PI_CLAUDE_CODE_PATH ?? process.env.PI_CLAUDE_CODE_PROVIDER_PATH ?? "claude";
const SDK_ENV_KEYS = ["HOME", "USER", "PATH", "TMPDIR", "LANG", "LC_ALL"] as const;

/** Do not silently inherit an alternate provider, paid API credential, or proxy route. */
export function sdkFirstPartyEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const overrides = Object.keys(source).filter((key) =>
		/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_API_KEY$|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_PROXY)/i.test(key),
	);
	if (overrides.length)
		throw new Error(`SDK subscription route refuses credential/provider overrides: ${overrides.join(", ")}`);
	if (!source.HOME || !source.PATH) throw new Error("SDK subscription route requires HOME and PATH");
	return Object.fromEntries(SDK_ENV_KEYS.flatMap((key) => (source[key] ? [[key, source[key]]] : [])));
}
const PACKAGE_REFERENCE = "pi packages (docs/packages.md)";
const WORK_REFERENCE =
	"- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing";
const PI_SUMMARIZATION_PREFIX = "You are a context summarization assistant.";
const outputSchema = {
	type: "object",
	properties: { name: { type: "string" }, args_json: { type: "string" }, final: { type: "string" } },
	required: ["name", "args_json", "final"],
	additionalProperties: false,
} as const;

type Proposal = { name: string; args_json: string; final: string };
type Awaiting = { resolve: (message: SDKResultMessage) => void; reject: (error: Error) => void };

/** Numeric-only evidence. SDK modelUsage is cumulative; usage is per main-agent turn. */
export type SdkUsageSnapshot = {
	turn: number;
	status: string;
	modelTurns: number;
	estimatedCostUsd: number;
	usage: { input: number; output: number; write: number; read: number; oneHourWrite: number; fiveMinuteWrite: number };
	modelTotals: Record<
		string,
		{ input: number; output: number; write: number; read: number; estimatedCostUsd: number }
	>;
};

/** Keep Pi identity, links, and instructions; avoid the reproducibly rejected documentation phrasing. */
export function adaptPiPromptForClaudeSdk(prompt: string): string {
	if (prompt.split(PACKAGE_REFERENCE).length !== 2 || prompt.split(WORK_REFERENCE).length !== 2) {
		throw new Error("Pi documentation instructions changed; SDK prompt adapter must be reviewed before use");
	}
	return prompt
		.replace(PACKAGE_REFERENCE, "app packages (docs/packages.md)")
		.replace(
			WORK_REFERENCE,
			"- For Pi-related work, consult applicable documentation and examples and follow their linked Markdown pages before implementing.",
		);
}

/** Parse the complete proposal before exposing any call to Pi's existing batch and policy checks. */
export function parseSdkProposal(
	value: unknown,
	context: Context,
): { name?: string; args?: Record<string, unknown>; text?: string } {
	if (!value || typeof value !== "object") throw new Error("SDK did not return a proposal");
	const { name, args_json, final } = value as Partial<Proposal>;
	if (typeof name !== "string" || typeof args_json !== "string" || typeof final !== "string") {
		throw new Error("Invalid SDK proposal fields");
	}
	const toolName = name.trim();
	if (!toolName) {
		if (args_json.trim()) throw new Error("Tool arguments without a tool name");
		if (!final.trim()) throw new Error("Empty SDK response would cause a repeated Pi turn");
		return { text: final };
	}
	if (!context.tools?.some((tool) => tool.name === toolName)) throw new Error("Unknown proposed Pi tool");
	if (final.trim()) throw new Error("Tool and final text cannot be proposed in the same turn");
	const args: unknown = JSON.parse(args_json);
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
	return { name: toolName, args: args as Record<string, unknown> };
}

function textOf(message: Message): string {
	if (message.role === "assistant") return ""; // Already present in the resident SDK session.
	if (typeof message.content === "string") return `User: ${message.content}`;
	if (message.content.some((part) => part.type !== "text")) {
		throw new Error("SDK prototype supports text-only Pi input and tool results");
	}
	const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
	return message.role === "toolResult"
		? `Pi tool result for ${message.toolName}: ${text}${message.isError ? " (error)" : ""}`
		: `User: ${text}`;
}

function emptyOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

export class SdkCarrier {
	private readonly observe?: (snapshot: SdkUsageSnapshot) => void;
	private readonly queryFn: typeof query;
	private cwd?: string;

	constructor(observe?: (snapshot: SdkUsageSnapshot) => void, queryFn: typeof query = query) {
		this.observe = observe;
		this.queryFn = queryFn;
	}
	private readonly abortController = new AbortController();
	private client?: Query;
	private activeModelId?: string;
	private previous: Message[] = [];
	private system?: string;
	private catalog?: string;
	private pendingInputs: Array<string | null> = [];
	private wakeInput?: (value: string | null) => void;
	private results: SDKResultMessage[] = [];
	private waiting?: Awaiting;
	private busy = false;
	private closed = false;
	private turns = 0;

	private async *input(): AsyncGenerator<SDKUserMessage> {
		while (true) {
			const next = await new Promise<string | null>((resolve) => {
				if (this.pendingInputs.length) resolve(this.pendingInputs.shift() ?? null);
				else this.wakeInput = resolve;
			});
			if (next === null) return;
			yield { type: "user", message: { role: "user", content: next }, parent_tool_use_id: null };
		}
	}

	private send(text: string | null): void {
		if (this.wakeInput) {
			const wake = this.wakeInput;
			this.wakeInput = undefined;
			wake(text);
		} else this.pendingInputs.push(text);
	}

	private start(model: Model<Api>, prompt: string, env: Record<string, string>): void {
		this.activeModelId = model.id;
		this.cwd = mkdtempSync(join(tmpdir(), "pi-sdk-structured-"));
		this.client = this.queryFn({
			prompt: this.input(),
			options: {
				cwd: this.cwd,
				model: model.id,
				systemPrompt: adaptPiPromptForClaudeSdk(prompt),
				tools: [],
				settingSources: [],
				env,
				persistSession: false,
				permissionMode: "dontAsk",
				outputFormat: { type: "json_schema", schema: outputSchema },
				maxTurns: 1,
				maxBudgetUsd: 2,
				abortController: this.abortController,
				pathToClaudeCodeExecutable: CLAUDE_CLI,
			},
		});
		void (async () => {
			try {
				for await (const message of this.client!) {
					if (message.type !== "result") continue;
					const waiting = this.waiting;
					this.waiting = undefined;
					if (waiting) waiting.resolve(message);
					else this.results.push(message);
				}
				if (!this.closed) this.close(new Error("SDK session ended unexpectedly"));
			} catch (error) {
				this.close(error instanceof Error ? error : new Error(String(error)));
			}
		})();
	}

	onModelSelect(model: { provider: string; id: string }): void {
		if (this.activeModelId && (model.provider !== API || model.id !== this.activeModelId)) {
			this.close(new Error("Pi model changed; start a new session before returning to Claude SDK"));
		}
	}

	close(error = new Error("SDK session closed")): void {
		if (this.closed) return;
		this.closed = true;
		this.waiting?.reject(error);
		this.waiting = undefined;
		this.results = [];
		this.send(null);
		this.abortController.abort();
		this.client?.close();
		if (this.cwd) rmSync(this.cwd, { recursive: true, force: true });
	}

	stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output = emptyOutput(model);
			const auxiliarySummary = context.systemPrompt?.startsWith(PI_SUMMARIZATION_PREFIX) ?? false;
			try {
				if (auxiliarySummary) {
					throw new Error(
						"Claude SDK carrier cannot summarize Pi history; switch to a supported model before compaction",
					);
				}
				const env = sdkFirstPartyEnv();
				if (this.closed || this.busy || this.turns >= 100)
					throw new Error("SDK session unavailable or safety turn limit reached");
				if (this.client && this.activeModelId !== model.id)
					throw new Error("Pi model changed; start a new session before using Claude SDK");
				if (options?.signal?.aborted) throw new Error("Pi request aborted");
				const originalSystem = context.systemPrompt ?? "";
				const catalog = JSON.stringify(
					context.tools?.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})) ?? [],
				);
				const system = `You are the Pi model, not a tool executor. Return one structured output per turn. If a Pi tool must run, name is its exact name and args_json is a JSON object string, with final empty. For ordinary prose, use an empty name and args_json. Wait for each Pi tool result before proposing another tool or finish_work. Never execute tools yourself. Pi tools: ${catalog}\n${originalSystem}`;
				if (
					this.client &&
					(this.system !== system ||
						this.catalog !== catalog ||
						JSON.stringify(context.messages.slice(0, this.previous.length)) !== JSON.stringify(this.previous))
				) {
					throw new Error("Pi context or tool catalog changed; SDK session cannot be safely replayed");
				}
				if (!this.client && context.messages.length !== 1)
					throw new Error("SDK prototype starts only in a new Pi session");
				const added = context.messages.slice(this.previous.length);
				if (
					added.some(
						(message) => message.role === "assistant" && (message.provider !== API || message.model !== model.id),
					)
				) {
					throw new Error(
						"Pi context contains another model's response; start a new session before using Claude SDK",
					);
				}
				const text = added.map(textOf).filter(Boolean).join("\n") || "Continue the active Pi work.";
				const payload = { systemPrompt: system, input: text, toolCatalog: catalog };
				const fingerprint = JSON.stringify(payload);
				const transformed = await options?.onPayload?.(payload, model);
				if (
					JSON.stringify(payload) !== fingerprint ||
					(transformed !== undefined && JSON.stringify(transformed) !== fingerprint)
				) {
					throw new Error("SDK prototype cannot apply provider payload mutations safely");
				}
				this.busy = true;
				this.system ??= system;
				this.catalog ??= catalog;
				if (!this.client) this.start(model, system, env);
				const answer = new Promise<SDKResultMessage>((resolve, reject) => {
					if (this.results.length) resolve(this.results.shift()!);
					else this.waiting = { resolve, reject };
				});
				const abort = () => this.close(new Error("Pi request aborted"));
				options?.signal?.addEventListener("abort", abort, { once: true });
				let result: SDKResultMessage;
				try {
					this.send(text);
					result = await answer;
				} finally {
					options?.signal?.removeEventListener("abort", abort);
				}
				this.turns++;
				this.observe?.({
					turn: this.turns,
					status: result.subtype === "success" && result.is_error ? "api_error" : result.subtype,
					modelTurns: result.num_turns,
					estimatedCostUsd: result.total_cost_usd,
					usage: {
						input: result.usage.input_tokens,
						output: result.usage.output_tokens,
						write: result.usage.cache_creation_input_tokens ?? 0,
						read: result.usage.cache_read_input_tokens ?? 0,
						oneHourWrite: result.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
						fiveMinuteWrite: result.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
					},
					modelTotals: Object.fromEntries(
						Object.entries(result.modelUsage).map(([name, usage]) => [
							name,
							{
								input: usage.inputTokens,
								output: usage.outputTokens,
								write: usage.cacheCreationInputTokens,
								read: usage.cacheReadInputTokens,
								estimatedCostUsd: usage.costUSD,
							},
						]),
					),
				});
				if (result.subtype !== "success" || result.is_error) {
					throw new Error(
						`SDK turn failed: ${result.subtype}${result.subtype === "success" ? `: ${result.result}` : ""}`,
					);
				}
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				const proposal = parseSdkProposal(result.structured_output, context);
				output.content = proposal.name
					? [{ type: "toolCall", id: randomUUID(), name: proposal.name, arguments: proposal.args! }]
					: [{ type: "text", text: proposal.text ?? "" }];
				output.stopReason = proposal.name ? "toolUse" : "stop";
				const usage = result.usage;
				output.usage = {
					input: usage.input_tokens,
					output: usage.output_tokens,
					cacheRead: usage.cache_read_input_tokens ?? 0,
					cacheWrite: usage.cache_creation_input_tokens ?? 0,
					totalTokens:
						usage.input_tokens +
						usage.output_tokens +
						(usage.cache_read_input_tokens ?? 0) +
						(usage.cache_creation_input_tokens ?? 0),
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				this.previous = context.messages.slice();
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end(output);
			} catch (error) {
				// Pi's auxiliary compaction and branch requests must not poison the
				// resident main-chat SDK query when this unsupported operation fails.
				if (!auxiliarySummary) this.close(error instanceof Error ? error : new Error(String(error)));
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			} finally {
				this.busy = false;
			}
		})();
		return stream;
	}
}

export function registerStructuredSdk(pi: ExtensionAPI, observe?: (snapshot: SdkUsageSnapshot) => void): () => void {
	let carrier = new SdkCarrier(observe);
	pi.on("session_shutdown", () => carrier.close());
	pi.on("model_select", (event) => carrier.onModelSelect(event.model));
	pi.on("session_start", (event) => {
		if (event.reason !== "startup") {
			carrier.close();
			carrier = new SdkCarrier(observe);
		}
	});
	pi.registerProvider(
		createProvider({
			id: API,
			name: "Claude Agent SDK (Pi structured, experimental)",
			auth: {
				apiKey: {
					name: "Official Claude Code local sign-in",
					async resolve() {
						try {
							const { stdout } = await execFileAsync(CLAUDE_CLI, ["auth", "status", "--json"], {
								timeout: 10_000,
								env: sdkFirstPartyEnv(),
							});
							const status = JSON.parse(stdout) as {
								loggedIn?: boolean;
								authMethod?: string;
								apiProvider?: string;
							};
							if (status.loggedIn && status.authMethod === "claude.ai" && status.apiProvider === "firstParty") {
								return { auth: { apiKey: "local-claude-code-only" }, source: "Official Claude Code sign-in" };
							}
						} catch {
							/* No official local sign-in; do not fall back to an API key. */
						}
						return undefined;
					},
				},
			},
			models: [
				{
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5 (SDK structured, experimental)",
					api: API,
					provider: API,
					baseUrl: "claude-agent-sdk://local",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 16_384,
				},
			],
			api: {
				stream: (model, context, options) => carrier.stream(model, context, options),
				streamSimple: (model, context, options) => carrier.stream(model, context, options),
			},
		}),
	);
	return () => carrier.close();
}

export default function (pi: ExtensionAPI): void {
	registerStructuredSdk(pi);
}
