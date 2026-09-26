// Opt-in Claude Agent SDK carrier. Pi alone validates and executes proposed tools.
// Load with `pi -e ./packages/coding-agent/examples/extensions/claude-sdk-structured/index.ts`.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const PI_SUMMARIZATION_PREFIX = "You are a context summarization assistant.";
const outputSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		args_json: {
			type: "string",
			description:
				"When name is set, one valid JSON object string with quoted keys and escaped string contents; otherwise empty.",
		},
		final: { type: "string" },
	},
	required: ["name", "args_json", "final"],
	additionalProperties: false,
} as const;

type Proposal = { name: string; args_json: string; final: string };

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

/** Preserve literal control characters in JSON string values as escaped JSON, without changing their decoded value. */
function escapeJsonStringControls(raw: string): string {
	let quoted = false;
	let escaped = false;
	let normalized = "";
	for (const char of raw) {
		if (escaped) {
			normalized += char;
			escaped = false;
		} else if (quoted && char === "\\") {
			normalized += char;
			escaped = true;
		} else if (char === '"') {
			normalized += char;
			quoted = !quoted;
		} else if (quoted && char.charCodeAt(0) < 0x20) {
			normalized += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
		} else {
			normalized += char;
		}
	}
	return normalized;
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
	let args: unknown;
	try {
		args = JSON.parse(args_json);
	} catch (error) {
		const normalized = escapeJsonStringControls(args_json);
		if (normalized === args_json) throw error;
		args = JSON.parse(normalized);
	}
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
	return { name: toolName, args: args as Record<string, unknown> };
}

type SdkInput = SDKUserMessage["message"]["content"];

/** A Gateway-managed channel session supplies the target; never infer it from model prose. */
export function discordAttachmentHint(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const channel = /^ch_([1-9][0-9]{16,19})$/.exec(basename(dirname(sessionFile)))?.[1];
	if (!channel) return undefined;
	return `If this Discord user asks to attach a local file, Pi's bash tool can run the host Gateway CLI: piscord send --channel dc:${channel} --file <absolute-path> [--text <message>]. Use only this channel and only when explicitly asked. The CLI checks file existence/size and handles credentials; never read or print its token. Confirm the command succeeded before claiming an upload, and do not send the same file twice.`;
}

function sdkInput(messages: Message[]): SdkInput {
	const blocks: Exclude<SdkInput, string> = [];
	const lines: string[] = [];
	let hasImage = false;
	for (const message of messages) {
		const prefix =
			message.role === "toolResult"
				? `Pi tool result for ${message.toolName} (${message.toolCallId})${message.isError ? " (error)" : ""}: `
				: message.role === "assistant"
					? "Assistant: "
					: "User: ";
		lines.push(prefix);
		blocks.push({ type: "text", text: prefix });
		if (typeof message.content === "string") {
			lines.push(message.content);
			blocks.push({ type: "text", text: message.content });
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") {
				lines.push(part.text);
				blocks.push({ type: "text", text: part.text });
			} else if (part.type === "toolCall") {
				const call = `Pi tool call ${part.name} (${part.id}): ${JSON.stringify(part.arguments)}`;
				lines.push(call);
				blocks.push({ type: "text", text: call });
			} else if (part.type === "image") {
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
		lines.push("\n");
		blocks.push({ type: "text", text: "\n" });
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
	private readonly active = new Map<AbortController, Query>();
	private deliveryHint?: string;
	private closed = false;
	private turns = 0;

	constructor(observe?: (snapshot: SdkUsageSnapshot) => void, queryFn: typeof query = query) {
		this.observe = observe;
		this.queryFn = queryFn;
	}

	setDeliveryHint(hint: string | undefined): void {
		this.deliveryHint = hint;
	}

	close(): void {
		this.closed = true;
		for (const [controller, client] of this.active) {
			controller.abort();
			client.close();
		}
		this.active.clear();
	}

	stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		void (async () => {
			const output = emptyOutput(model);
			let controller = new AbortController();
			const abort = () => controller.abort();
			let client: Query | undefined;
			let cwd: string | undefined;
			try {
				if (this.closed) throw new Error("SDK carrier closed");
				const summarizing = context.systemPrompt?.startsWith(PI_SUMMARIZATION_PREFIX) ?? false;
				const env = sdkFirstPartyEnv();
				const catalog = JSON.stringify(
					context.tools?.map((tool) => ({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					})) ?? [],
				);
				const system = summarizing
					? `${context.systemPrompt}\nReturn the summary in the final field of the structured response; leave name and args_json empty.`
					: `You are the Pi model, not a tool executor. Return one structured output per turn. If a Pi tool must run, name is its exact name and args_json is one valid JSON object string with quoted keys, escaped quotes and control characters, and no trailing commas; leave final empty. For ordinary prose, use an empty name and args_json. Wait for each Pi tool result before proposing another tool or finish_work. Never execute tools yourself. The supplied Pi conversation is history, not a request to rerun earlier tools. Pi tools: ${catalog}\n${context.systemPrompt ?? ""}`;
				const baseInput = sdkInput(context.messages);
				const input: SdkInput =
					!summarizing && this.deliveryHint
						? typeof baseInput === "string"
							? `${baseInput}\n\n[Pi host capability] ${this.deliveryHint}`
							: [...baseInput, { type: "text", text: `[Pi host capability] ${this.deliveryHint}` }]
						: baseInput;
				const payload = { systemPrompt: system, input, toolCatalog: catalog };
				const fingerprint = JSON.stringify(payload);
				const transformed = await options?.onPayload?.(payload, model);
				if (
					JSON.stringify(payload) !== fingerprint ||
					(transformed !== undefined && JSON.stringify(transformed) !== fingerprint)
				)
					throw new Error("SDK prototype cannot apply provider payload mutations safely");
				if (this.closed || options?.signal?.aborted) throw new Error("Pi request aborted");
				options?.signal?.addEventListener("abort", abort, { once: true });
				cwd = mkdtempSync(join(tmpdir(), "pi-sdk-structured-"));
				let proposal: ReturnType<typeof parseSdkProposal> | undefined;
				for (let attempt = 0; attempt < 2; attempt++) {
					if (this.closed || options?.signal?.aborted || controller.signal.aborted)
						throw new Error("Pi request aborted");
					// A malformed proposal never reached Pi. One fresh SDK request may correct its format.
					const correction =
						"Your previous structured response was discarded before any Pi tool ran. Return exactly one allowed Pi tool name with args_json as one syntactically valid JSON object string (quoted keys, escaped quotes and control characters, no trailing commas) and final empty; or empty name and args_json with nonempty final text.";
					const retryInput: SdkInput =
						attempt === 0
							? input
							: typeof input === "string"
								? `${input}\n\n${correction}`
								: [...input, { type: "text", text: correction }];
					const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
						yield { type: "user", message: { role: "user", content: retryInput }, parent_tool_use_id: null };
					})();
					client = this.queryFn({
						prompt,
						options: {
							cwd,
							model: model.id,
							systemPrompt: system,
							tools: [],
							settingSources: [],
							env,
							persistSession: false,
							thinking: options?.reasoning ? { type: "adaptive" } : { type: "disabled" },
							...(options?.reasoning
								? { effort: options.reasoning === "minimal" ? "low" : options.reasoning }
								: {}),
							permissionMode: "dontAsk",
							outputFormat: { type: "json_schema", schema: outputSchema },
							abortController: controller,
							pathToClaudeCodeExecutable: CLAUDE_CLI,
						},
					});
					this.active.set(controller, client);
					let result: SDKResultMessage | undefined;
					for await (const message of client) {
						if (message.type === "result") {
							result = message;
							break;
						}
					}
					if (!result) throw new Error("SDK session ended without a result");
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
					const usage = result.usage;
					output.usage.input += usage.input_tokens;
					output.usage.output += usage.output_tokens;
					output.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
					output.usage.cacheWrite += usage.cache_creation_input_tokens ?? 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					if (result.subtype !== "success" || result.is_error)
						throw new Error(
							`SDK turn failed: ${result.subtype}${result.subtype === "success" ? `: ${result.result}` : ""}`,
						);
					try {
						proposal = parseSdkProposal(result.structured_output, context);
					} catch (error) {
						if (
							attempt !== 0 ||
							(!(error instanceof SyntaxError) &&
								!(
									error instanceof Error &&
									[
										"Tool and final text cannot be proposed in the same turn",
										"Tool arguments must be an object",
									].includes(error.message)
								))
						)
							throw error;
						client.close();
						this.active.delete(controller);
						controller = new AbortController();
						continue;
					}
					break;
				}
				if (!proposal) throw new Error("SDK did not return a valid proposal");
				await options?.onResponse?.({ status: 200, headers: {} }, model);
				output.content = proposal.name
					? [{ type: "toolCall", id: randomUUID(), name: proposal.name, arguments: proposal.args! }]
					: [{ type: "text", text: proposal.text ?? "" }];
				output.stopReason = proposal.name ? "toolUse" : "stop";
				stream.push({ type: "start", partial: output });
				stream.push({ type: "done", reason: output.stopReason, message: output });
				stream.end(output);
			} catch (error) {
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: output.stopReason, error: output });
				stream.end(output);
			} finally {
				options?.signal?.removeEventListener("abort", abort);
				this.active.delete(controller);
				client?.close();
				if (cwd) rmSync(cwd, { recursive: true, force: true });
			}
		})();
		return stream;
	}
}

export function registerStructuredSdk(pi: ExtensionAPI, observe?: (snapshot: SdkUsageSnapshot) => void): () => void {
	let carrier = new SdkCarrier(observe);
	const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		carrier.stream(model, context, options);
	pi.on("session_shutdown", () => carrier.close());
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") {
			carrier.close();
			carrier = new SdkCarrier(observe);
		}
		carrier.setDeliveryHint(discordAttachmentHint(ctx.sessionManager.getSessionFile()));
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
			api: { stream, streamSimple: stream },
		}),
	);
	return () => carrier.close();
}

export default function (pi: ExtensionAPI): void {
	registerStructuredSdk(pi);
}
