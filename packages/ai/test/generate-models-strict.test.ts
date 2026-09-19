import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation", () => {
	it("recovers omitted handwritten providers from the matching published package", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-retain-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-empty-models-dev.mjs");
		const individualModelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(individualModelIds.map((id) => [id, { id, name: id, tool_call: true }])),
			},
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  if (String(input) === "https://openrouter.ai/api/v1/models" || String(input) === "https://ai-gateway.vercel.sh/v1/models") {\n` +
				`    return new Response('{"data":[]}', { status: 200 });\n` +
				`  }\n` +
				`  if (String(input) === "https://registry.npmjs.org/%40earendil-works%2Fpi-ai/latest") {\n` +
				`    return new Response('{"version":"0.84.0"}', { status: 200 });\n` +
				`  }\n` +
				`  if (String(input).startsWith("https://unpkg.com/@earendil-works/pi-ai@0.84.0/")) {\n` +
				`    const provider = decodeURIComponent(String(input).split("/").at(-1).replace(/\\.json$/, ""));\n` +
				`    const id = provider + "-published";\n` +
				`    const model = { id, name: id, api: "anthropic-messages", provider, baseUrl: "https://example.test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };\n` +
				`    return new Response(JSON.stringify({ "anthropic-messages": { [id]: model } }), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unavailable in fixture: \${String(input)}\`);\n` +
				`};\n`,
		);

		rmSync(join(isolatedPackageRoot, "src/providers/data"), { force: true, recursive: true });
		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"Live model sources omitted kimi-coding; using 1 model(s) from @earendil-works/pi-ai@0.84.0.",
		);
		const aggregator = readFileSync(join(isolatedPackageRoot, "src/models.generated.ts"), "utf8");
		expect(aggregator).toContain('import { KIMI_CODING_MODELS } from "./providers/kimi-coding.models.ts";');
		expect(aggregator).toContain('import { AMAZON_BEDROCK_MODELS } from "./providers/amazon-bedrock.models.ts";');
		expect(
			JSON.parse(readFileSync(join(isolatedPackageRoot, "src/providers/data/kimi-coding.json"), "utf8")),
		).toEqual({
			"anthropic-messages": {
				"kimi-coding-published": expect.objectContaining({ provider: "kimi-coding" }),
			},
		});
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-flash",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
