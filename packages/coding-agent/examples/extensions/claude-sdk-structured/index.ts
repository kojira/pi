// Opt-in Claude Agent SDK carrier. Pi alone validates and executes proposed tools.
// Load with `pi -e ./packages/coding-agent/examples/extensions/claude-sdk-structured/index.ts`.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

type SdkInput = SDKUserMessage["message"]["content"];

function sdkInput(messages: Message[]): SdkInput {
	const blocks: Exclude<SdkInput, string> = [];
	let hasImage = false;
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") continue; // Already in the resident SDK session.
		const prefix = message.role === "toolResult" ? `Pi tool result for ${message.toolName}: ` : "User: ";
		const suffix = message.role === "toolResult" && message.isError ? " (error)" : "";
		if (typeof message.content === "string") {
			lines.push(prefix + message.content);
			blocks.push({ type: "text", text: prefix + message.content });
			continue;
		}
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		lines.push(prefix + text + suffix);
		blocks.push({ type: "text", text: prefix });
		for (const part of message.content) {
			if (part.type === "text") blocks.push({ type: "text", text: part.text });
			else if (part.type === "image") {
				hasImage = true;
				if (!(["image/jpeg", "image/png", "image/gif", "image/webp"] as string[]).includes(part.mimeType)) {
					throw new Error("Unsupported image media type for Claude SDK");
				}
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: part.mimeType as "image/png", data: part.data },
				});
			}
		}
		if (suffix) blocks.push({ type: "text", text: suffix });
	}
	return hasImage ? blocks : lines.join("\n") || "Continue the active Pi work.";
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
	private sessionKey?: string;
	private resumeId?: string;
	private thinking?: SimpleStreamOptions["reasoning"];

	setSessionKey(id: string): void {
		if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Pi session ID for Claude SDK");
		this.sessionKey = id;
	}

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
	private pendingInputs: Array<SdkInput | null> = [];
	private wakeInput?: (value: SdkInput | null) => void;
	private results: SDKResultMessage[] = [];
	private waiting?: Awaiting;
	private busy = false;
	private closed = false;
	private turns = 0;

	private async *input(): AsyncGenerator<SDKUserMessage> {
		while (true) {
			const next = await new Promise<SdkInput | null>((resolve) => {
				if (this.pendingInputs.length) resolve(this.pendingInputs.shift() ?? null);
				else this.wakeInput = resolve;
			});
			if (next === null) return;
			yield { type: "user", message: { role: "user", content: next }, parent_tool_use_id: null };
		}
	}

	private send(text: SdkInput | null): void {
		if (this.wakeInput) {
			const wake = this.wakeInput;
			this.wakeInput = undefined;
			wake(text);
		} else this.pendingInputs.push(text);
	}

	private start(model: Model<Api>, prompt: string, env: Record<string, string>): void {
		this.activeModelId = model.id;
		this.cwd = this.sessionKey
			? join(tmpdir(), `pi-sdk-structured-${this.sessionKey}`)
			: mkdtempSync(join(tmpdir(), "pi-sdk-structured-"));
		mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
		this.client = this.queryFn({
			prompt: this.input(),
			options: {
				cwd: this.cwd,
				model: model.id,
				systemPrompt: adaptPiPromptForClaudeSdk(prompt),
				tools: [],
				settingSources: [],
				env,
				persistSession: true,
				...(this.resumeId ? { resume: this.resumeId } : {}),
				thinking: this.thinking ? { type: "adaptive" } : { type: "disabled" },
				...(this.thinking ? { effort: this.thinking === "minimal" ? "low" : this.thinking } : {}),
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
				if (!this.client && context.messages.length !== 1) {
					let last = -1;
					for (let index = context.messages.length - 1; index >= 0; index--) {
						const message = context.messages[index];
						if (
							message.role === "assistant" &&
							message.provider === API &&
							message.model === model.id &&
							message.stopReason !== "error" &&
							message.stopReason !== "aborted" &&
							message.responseId
						) {
							last = index;
							break;
						}
					}
					const checkpoint = context.messages[last];
					const match =
						checkpoint?.role === "assistant"
							? /^([0-9a-f-]{36})\.([0-9a-f]{64})$/i.exec(checkpoint.responseId ?? "")
							: null;
					if (
						!match ||
						!this.sessionKey ||
						match[2] !== createHash("sha256").update(system).digest("hex") ||
						context.messages.some(
							(message) =>
								message.role === "assistant" && (message.provider !== API || message.model !== model.id),
						) ||
						context.messages.slice(last + 1).some((message) => message.role === "assistant")
					) {
						throw new Error("Claude SDK cannot resume this Pi session; start a new session");
					}
					this.resumeId = match[1];
					this.previous = context.messages.slice(0, last + 1);
				}
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
				const input = sdkInput(added);
				const payload = { systemPrompt: system, input, toolCatalog: catalog };
				const fingerprint = JSON.stringify(payload);
				const transformed = await options?.onPayload?.(payload, model);
				if (
					JSON.stringify(payload) !== fingerprint ||
					(transformed !== undefined && JSON.stringify(transformed) !== fingerprint)
				) {
					throw new Error("SDK prototype cannot apply provider payload mutations safely");
				}
				const abort = () => this.close(new Error("Pi request aborted"));
				options?.signal?.addEventListener("abort", abort, { once: true });
				let result: SDKResultMessage;
				try {
					// onPayload is asynchronous: Pi may abort while it is pending.
					if (options?.signal?.aborted) throw new Error("Pi request aborted");
					this.busy = true;
					this.system ??= system;
					this.catalog ??= catalog;
					if (!this.client) {
						this.thinking = options?.reasoning;
						this.start(model, system, env);
					} else if (this.thinking !== options?.reasoning) {
						await this.client.setMaxThinkingTokens(options?.reasoning ? 16384 : 0, "omitted");
						if (options?.reasoning)
							await this.client.applyFlagSettings({
								effortLevel: options.reasoning === "minimal" ? "low" : options.reasoning,
							});
						this.thinking = options?.reasoning;
					}
					const answer = new Promise<SDKResultMessage>((resolve, reject) => {
						if (this.results.length) resolve(this.results.shift()!);
						else this.waiting = { resolve, reject };
					});
					if (this.closed || options?.signal?.aborted) throw new Error("Pi request aborted");
					this.send(input);
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
				if (this.sessionKey && result.session_id) {
					output.responseId = `${result.session_id}.${createHash("sha256").update(system).digest("hex")}`;
				}
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
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") {
			carrier.close();
			carrier = new SdkCarrier(observe);
		}
		carrier.setSessionKey(ctx.sessionManager.getSessionId());
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
					reasoning: true,
					thinkingLevelMap: {
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
					input: ["text", "image"],
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
