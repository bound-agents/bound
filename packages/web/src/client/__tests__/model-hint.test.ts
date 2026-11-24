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
});
