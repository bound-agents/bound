import { describe, expect, it } from "bun:test";
import { resolveInitialModel } from "../lib/model-hint";

const models = [
	{ id: "claude-opus-4", host: "local" },
	{ id: "claude-sonnet-4-5", host: "local" },
	{ id: "gpt-4o", host: "remote" },
];

describe("resolveInitialModel", () => {
	it("uses global default when no hint provided", () => {
		const result = resolveInitialModel(models, "claude-opus-4", null);
		expect(result.selectedModel).toBe("claude-opus-4@local");
		expect(result.modelId).toBe("claude-opus-4");
	});

	it("uses hint when the hint model exists in the list", () => {
		const result = resolveInitialModel(models, "claude-opus-4", "claude-sonnet-4-5");
		expect(result.selectedModel).toBe("claude-sonnet-4-5@local");
		expect(result.modelId).toBe("claude-sonnet-4-5");
	});

	it("falls back to global default when hint model is not found", () => {
		const result = resolveInitialModel(models, "claude-opus-4", "unknown-model");
		expect(result.selectedModel).toBe("claude-opus-4@local");
		expect(result.modelId).toBe("claude-opus-4");
	});

	it("returns raw default string when models list is empty", () => {
		const result = resolveInitialModel([], "claude-opus-4", null);
		expect(result.selectedModel).toBe("claude-opus-4");
		expect(result.modelId).toBe("claude-opus-4");
	});

	it("treats undefined hint same as null", () => {
		const result = resolveInitialModel(models, "claude-opus-4", undefined);
		expect(result.selectedModel).toBe("claude-opus-4@local");
		expect(result.modelId).toBe("claude-opus-4");
	});

	it("hint takes precedence over global default", () => {
		const result = resolveInitialModel(models, "claude-opus-4", "gpt-4o");
		expect(result.selectedModel).toBe("gpt-4o@remote");
		expect(result.modelId).toBe("gpt-4o");
	});
});
