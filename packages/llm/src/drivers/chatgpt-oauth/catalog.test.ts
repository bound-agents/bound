import { describe, expect, it } from "bun:test";
import { parseCodexModels } from "./catalog";

describe("parseCodexModels", () => {
	it("keeps listed, API-callable rows and maps their metadata", () => {
		const models = parseCodexModels({
			models: [
				{
					slug: "gpt-6.2-sol",
					display_name: "GPT-6.2 Sol",
					visibility: "list",
					supported_in_api: true,
					context_window: 1_050_000,
					max_context_window: 1_050_000,
					input_modalities: ["text", "image"],
					default_reasoning_level: "medium",
					supported_reasoning_levels: [
						{ effort: "low" },
						{ effort: "medium" },
						"high",
						{ effort: "medium" },
						{ effort: "" },
						{},
					],
					supports_reasoning_summaries: true,
				},
			],
		});
		expect(models).toEqual([
			{
				providerModelId: "gpt-6.2-sol",
				displayName: "GPT-6.2 Sol",
				capabilities: {
					tool_use: true,
					vision: true,
					max_context: 1_050_000,
					reasoning: { supported: true, effort_values: ["low", "medium", "high"] },
				},
			},
		]);
	});

	it("excludes hidden rows and rows not supported in the API", () => {
		const models = parseCodexModels({
			models: [
				{ slug: "codex-auto-review", visibility: "hide" },
				{ slug: "gpt-reserve", visibility: "hide" },
				{ slug: "gpt-internal", visibility: "list", supported_in_api: false },
				{ slug: "gpt-6-luna", visibility: "list" },
			],
		});
		expect(models.map((m) => m.providerModelId)).toEqual(["gpt-6-luna"]);
	});

	it("includes rows without a visibility field", () => {
		expect(parseCodexModels({ models: [{ slug: "gpt-6-astra" }] })).toEqual([
			{ providerModelId: "gpt-6-astra", capabilities: { tool_use: true, vision: false } },
		]);
	});

	it("drops empty slugs, duplicate slugs, and non-object rows", () => {
		const models = parseCodexModels({
			models: [null, "gpt-x", { slug: "" }, { slug: 42 }, { slug: "a" }, { slug: "a" }],
		});
		expect(models.map((m) => m.providerModelId)).toEqual(["a"]);
	});

	it("omits non-positive context windows, empty display names, and empty effort ladders", () => {
		const [model] = parseCodexModels({
			models: [
				{
					slug: "m",
					display_name: "",
					context_window: 0,
					input_modalities: "image",
					supported_reasoning_levels: [],
				},
			],
		});
		expect(model).toEqual({
			providerModelId: "m",
			capabilities: { tool_use: true, vision: false },
		});
	});

	it("returns [] for malformed bodies", () => {
		expect(parseCodexModels(null)).toEqual([]);
		expect(parseCodexModels("nope")).toEqual([]);
		expect(parseCodexModels({})).toEqual([]);
		expect(parseCodexModels({ models: {} })).toEqual([]);
	});
});
