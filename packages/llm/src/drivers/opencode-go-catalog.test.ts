import { describe, expect, it } from "bun:test";
import { DEEPSEEK_ROW } from "../__tests__/opencode-go-fixtures";
import {
	fallbackOpenCodeGoProtocol,
	parseOpenCodeGoModels,
	parseOpenCodeGoPricing,
	selectOpenCodeGoProtocol,
} from "./opencode-go-catalog";

describe("parseOpenCodeGoModels", () => {
	it("extracts a chat row into a catalog entry with full DiscoveredModel metadata", () => {
		const [entry] = parseOpenCodeGoModels({ data: [DEEPSEEK_ROW] });
		expect(entry).toEqual({
			id: "deepseek-v4.1-flash",
			protocol: "chat-completions",
			apiBaseUrl: "https://opencode.ai/inference/go/openai/v1",
			discovered: {
				providerModelId: "deepseek-v4.1-flash",
				displayName: "DeepSeek V4.1 Flash 1017",
				capabilities: {
					max_context: 1_000_000,
					vision: true,
					tool_use: true,
					reasoning: { supported: true, effort_values: ["low", "high", "max"] },
					extended_thinking: true,
				},
				maxOutputTokens: 384_000,
				pricing: {
					input_per_m: 0.15,
					cache_read_per_m: 0.003,
					cache_write_5m_per_m: 0.125,
					output_per_m: 0.6,
					tiers: [
						{
							threshold: 100_000,
							input_per_m: 0.5,
							cache_read_per_m: 0.05,
							cache_write_5m_per_m: 0.625,
							output_per_m: 2.5,
						},
					],
				},
			},
		});
	});

	it("excludes decision and embedding rows", () => {
		const entries = parseOpenCodeGoModels({
			data: [
				{ id: "router", type: "decision", recommended_api: "systemone", api: { systemone: {} } },
				{
					id: "embed-1",
					type: "embedding",
					recommended_api: "embeddings",
					api: { embeddings: {} },
				},
				DEEPSEEK_ROW,
			],
		});
		expect(entries.map((e) => e.id)).toEqual(["deepseek-v4.1-flash"]);
	});

	it("excludes a chat row whose api lists only unsupported protocols", () => {
		const entries = parseOpenCodeGoModels({
			data: [
				{
					id: "gemini-4-argon",
					type: "chat",
					recommended_api: "interactions",
					api: {
						interactions: { base_url: "https://x" },
						"generate-content": { base_url: "https://y" },
					},
				},
			],
		});
		expect(entries).toEqual([]);
	});

	it("text-only modalities report vision false; a bare `image` modality reports true", () => {
		const [textOnly, bare] = parseOpenCodeGoModels({
			data: [
				{ id: "glm-5", modalities: { input: ["text"] } },
				{ id: "kimi-k3", modalities: { input: ["text", "image"] } },
			],
		});
		expect(textOnly?.discovered.capabilities?.vision).toBe(false);
		expect(bare?.discovered.capabilities?.vision).toBe(true);
	});

	it("accepts a row with no type and no api block (minimal fixture) via the family fallback", () => {
		const entries = parseOpenCodeGoModels({ data: [{ id: "minimax-m3" }, { id: "glm-5" }] });
		expect(entries.map((e) => [e.id, e.protocol, e.apiBaseUrl])).toEqual([
			["minimax-m3", "messages", undefined],
			["glm-5", "chat-completions", undefined],
		]);
		expect(entries[0]?.discovered).toEqual({ providerModelId: "minimax-m3" });
	});

	it("tolerates malformed input and drops duplicate / id-less rows", () => {
		expect(parseOpenCodeGoModels(null)).toEqual([]);
		expect(parseOpenCodeGoModels({ data: "nope" })).toEqual([]);
		const entries = parseOpenCodeGoModels([{ id: "glm-5" }, { id: "glm-5" }, { name: "x" }, 7]);
		expect(entries.map((e) => e.id)).toEqual(["glm-5"]);
	});
});

describe("selectOpenCodeGoProtocol", () => {
	it("prefers a supported recommended_api", () => {
		expect(
			selectOpenCodeGoProtocol(
				{
					recommended_api: "responses",
					api: { responses: { base_url: "https://r" }, messages: { base_url: "https://m" } },
				},
				"m",
			),
		).toEqual({ protocol: "responses", apiBaseUrl: "https://r" });
	});

	it("falls back to messages → responses → chat-completions when recommended_api is unsupported", () => {
		expect(
			selectOpenCodeGoProtocol(
				{
					recommended_api: "interactions",
					api: {
						interactions: {},
						"chat-completions": { base_url: "https://c" },
						responses: { base_url: "https://r" },
					},
				},
				"m",
			),
		).toEqual({ protocol: "responses", apiBaseUrl: "https://r" });
		expect(
			selectOpenCodeGoProtocol(
				{ api: { "chat-completions": {}, messages: { base_url: "https://m" } } },
				"m",
			),
		).toEqual({ protocol: "messages", apiBaseUrl: "https://m" });
	});

	it("omits apiBaseUrl when the surface publishes none", () => {
		expect(selectOpenCodeGoProtocol({ api: { "chat-completions": {} } }, "m")).toEqual({
			protocol: "chat-completions",
		});
	});

	it("returns null when api lists nothing the driver speaks", () => {
		expect(selectOpenCodeGoProtocol({ api: { systemone: {} } }, "m")).toBeNull();
	});
});

describe("fallbackOpenCodeGoProtocol", () => {
	it("routes qwen / minimax (prefixed or not) to messages, others to chat-completions", () => {
		expect(fallbackOpenCodeGoProtocol("opencode-go/Qwen3.7-max")).toBe("messages");
		expect(fallbackOpenCodeGoProtocol("minimax-m3")).toBe("messages");
		expect(fallbackOpenCodeGoProtocol("kimi-k3")).toBe("chat-completions");
		expect(fallbackOpenCodeGoProtocol("opencode-go/MiniMax-M2")).toBe("messages");
	});
});

describe("parseOpenCodeGoPricing", () => {
	it("returns undefined without a cost.text block", () => {
		expect(parseOpenCodeGoPricing(undefined)).toBeUndefined();
		expect(parseOpenCodeGoPricing({ image: {} })).toBeUndefined();
		expect(parseOpenCodeGoPricing({ text: {} })).toBeUndefined();
	});

	it("merges input and output overrides into ascending tiers and ignores non-context overrides", () => {
		const pricing = parseOpenCodeGoPricing({
			text: {
				input: {
					price: 1,
					overrides: [
						{ when: { context: { gt: 500_000 } }, price: 3 },
						{ when: { context: { gt: 200_000 } }, price: 2 },
						{ when: { region: "eu" }, price: 9 },
					],
				},
				output: { price: 4, overrides: [{ when: { context: { gt: 200_000 } }, price: 8 }] },
			},
		});
		expect(pricing).toEqual({
			input_per_m: 1,
			output_per_m: 4,
			tiers: [
				{ threshold: 200_000, input_per_m: 2, output_per_m: 8 },
				{ threshold: 500_000, input_per_m: 3 },
			],
		});
	});
});
