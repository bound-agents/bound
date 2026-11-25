import { describe, expect, it } from "bun:test";
import { buildModelOptions, logicalModelFor, resolveInitialModel } from "../lib/model-hint";

const models = [
	{ id: "zai-glm-5.3-flash", logical_model: "glm-5-3-flash", display_name: "GLM-5.3 Flash" },
	{ id: "copilot-glm-5.3-flash", logical_model: "glm-5-3-flash", display_name: "GLM-5.3 Flash" },
	{ id: "opencode-go-kimi-k3", logical_model: "kimi-k3", display_name: "Kimi K3" },
	{ id: "legacy", display_name: "legacy" },
];
const options = buildModelOptions(models, []);

describe("buildModelOptions", () => {
	it("collapses backends of one logical model and labels by display name", () => {
		expect(options).toEqual([
			{ id: "glm-5-3-flash", label: "GLM-5.3 Flash" },
			{ id: "kimi-k3", label: "Kimi K3" },
			{ id: "legacy", label: "legacy" },
		]);
	});

	it("prefers the routing API and never labels with a backend id", () => {
		const opts = buildModelOptions(models, [
			{ logical_model: "gpt-6-1-sol", display_name: null },
			{ logical_model: "kimi-k3", display_name: "Kimi K3" },
		]);
		expect(opts).toEqual([
			{ id: "gpt-6-1-sol", label: "gpt-6-1-sol" },
			{ id: "kimi-k3", label: "Kimi K3" },
		]);
		for (const o of opts) expect(models.map((m) => m.id)).not.toContain(o.label);
	});
});

describe("resolveInitialModel", () => {
	it("maps a backend-id default to its logical option", () => {
		expect(resolveInitialModel(options, models, "zai-glm-5.3-flash", null)).toEqual({
			selectedModel: "glm-5-3-flash",
			modelId: "glm-5-3-flash",
		});
	});

	it("hint (backend or logical id) takes precedence over the default", () => {
		expect(
			resolveInitialModel(options, models, "zai-glm-5.3-flash", "opencode-go-kimi-k3").modelId,
		).toBe("kimi-k3");
		expect(resolveInitialModel(options, models, "zai-glm-5.3-flash", "kimi-k3").modelId).toBe(
			"kimi-k3",
		);
	});

	it("falls back to the default when the hint is unknown, and to the raw default when nothing matches", () => {
		expect(resolveInitialModel(options, models, "kimi-k3", "ghost").modelId).toBe("kimi-k3");
		expect(resolveInitialModel([], [], "ghost", undefined)).toEqual({
			selectedModel: "ghost",
			modelId: "ghost",
		});
	});

	it("logicalModelFor returns undefined for unknown ids", () => {
		expect(logicalModelFor("nope", options, models)).toBeUndefined();
	});

	const routing = [
		{ logical_model: "claude-opus-5-5", display_name: "Claude Opus 5.5", routes: [] },
		{
			logical_model: "gpt-6-astra",
			display_name: "GPT-6 Astra",
			routes: [{ route_id: "site-hub:openai:bedrock-main-openai.gpt-6-astra" }],
		},
		{ logical_model: "deepseek-v4-1-flash", display_name: "DeepSeek", routes: [] },
	];
	const rOptions = buildModelOptions([], routing);

	it("maps a remote backend id to its logical model through routing routes", () => {
		expect(logicalModelFor("bedrock-main-openai.gpt-6-astra", rOptions, [], routing)).toBe(
			"gpt-6-astra",
		);
	});

	it("prefills a hintless thread from its latest message model before any default", () => {
		expect(
			resolveInitialModel(rOptions, [], "deepseek-v4-1-flash", null, {
				fallbackModel: "bedrock-main-openai.gpt-6-astra",
				clusterDefault: "claude-opus-5-5",
				routing,
			}).modelId,
		).toBe("gpt-6-astra");
	});

	it("uses the cluster default role over the host default when the thread has no model", () => {
		expect(
			resolveInitialModel(rOptions, [], "deepseek-v4-1-flash", null, {
				clusterDefault: "claude-opus-5-5",
				routing,
			}).modelId,
		).toBe("claude-opus-5-5");
	});

	it("the thread hint still wins over the latest message model", () => {
		expect(
			resolveInitialModel(rOptions, [], "deepseek-v4-1-flash", "claude-opus-5-5", {
				fallbackModel: "gpt-6-astra",
				routing,
			}).modelId,
		).toBe("claude-opus-5-5");
	});
});
