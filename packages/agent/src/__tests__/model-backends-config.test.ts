import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { calculateDynamicPrice } from "../dynamic-pricing";
import { loadModelBackendsConfig } from "../model-backends-config";

describe("model_backends.js loader", () => {
	let configDir: string;

	beforeEach(() => {
		configDir = join(tmpdir(), `bound-model-backends-${randomBytes(4).toString("hex")}`);
		mkdirSync(configDir, { recursive: true });
	});

	afterEach(async () => {
		await cleanupTmpDir(configDir);
	});

	it("falls back to model_backends.json when no JavaScript config exists", async () => {
		writeFileSync(
			join(configDir, "model_backends.json"),
			JSON.stringify({
				backends: [
					{
						id: "json",
						provider: "openai-compatible",
						model: "x",
						context_window: 8192,
						base_url: "http://localhost:11434/v1",
					},
				],
				default: "json",
			}),
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.default).toBe("json");
	});

	it("prefers model_backends.js over model_backends.json", async () => {
		writeFileSync(
			join(configDir, "model_backends.json"),
			JSON.stringify({
				backends: [
					{
						id: "json",
						provider: "openai-compatible",
						model: "x",
						context_window: 8192,
						base_url: "http://localhost:11434/v1",
					},
				],
				default: "json",
			}),
		);
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "js", provider: "openai-compatible", model: "x", context_window: 8192, base_url: "http://localhost:11434/v1" }], default: "js" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.default).toBe("js");
	});

	it("loads the default export and preserves a backend price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, base_url: "\${TEST_BACKEND_URL:-http://localhost:11434/v1}", price(turn) { return turn.inputTokens / 1000; } }], default: "local" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.backends[0]?.base_url).toBe("http://localhost:11434/v1");
		expect(config.backends[0]).not.toHaveProperty("price");
	});

	it("loads a helper-prefixed default export with an arrow price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`const price = (turn) => turn.inputTokens / 1_000_000;
export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, base_url: "http://localhost:11434/v1", price }], default: "local" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.default).toBe("local");
	});

	it("preserves helpers closed over by a price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`const scaled = (rate, turn) => rate * turn.inputTokens / 1_000_000;
export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, base_url: "http://localhost:11434/v1", price(turn) { return scaled(2, turn); } }], default: "local" };`,
		);

		await loadModelBackendsConfig(configDir);
		expect(
			calculateDynamicPrice("local", {
				modelId: "local",
				inputTokens: 100,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				pricesPerM: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		).toEqual({ value: 0.0002, error: null });
	});

	it("loads template literals in helpers and price callbacks without env expansion (#280)", async () => {
		// biome-ignore lint/performance/noDelete: `process.env.X = undefined` stores the string "undefined"; only delete makes the var absent
		delete process.env.id;
		// biome-ignore lint/performance/noDelete: `process.env.X = undefined` stores the string "undefined"; only delete makes the var absent
		delete process.env.rate;
		writeFileSync(
			join(configDir, "model_backends.js"),
			`const test = (id) => ({ id: \`test-\${id}\`, provider: "openai-compatible", model: "x", context_window: 8192, base_url: "\${TEST_BACKEND_URL:-http://localhost:11434/v1}", price(turn) { const rate = 3; const tag = \`r\${rate}\`; return tag === "r3" ? turn.inputTokens * rate / 1000 : -1; } });
export default { backends: [test("a")], default: "test-a" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.backends[0]?.id).toBe("test-a");
		expect(config.backends[0]?.base_url).toBe("http://localhost:11434/v1");
		expect(
			calculateDynamicPrice("test-a", {
				modelId: "test-a",
				inputTokens: 100,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				pricesPerM: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		).toEqual({ value: 0.3, error: null });
	});

	it("rejects functions outside backend.price or a model_overrides[*].price", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: () => "x", context_window: 8192, base_url: "http://localhost:11434/v1" }], default: "local" };`,
		);

		await expect(loadModelBackendsConfig(configDir)).rejects.toThrow(
			"only backend.price or a model_overrides[*].price may be a function",
		);
	});

	it("does not publish a candidate with an invalid price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, base_url: "http://localhost:11434/v1", price() { return -1; } }], default: "local" };`,
		);

		await expect(loadModelBackendsConfig(configDir)).rejects.toThrow("finite non-negative number");
	});

	it("compiles a model_overrides[*].price callback keyed by the expanded backend id", async () => {
		// Requirement 5: a per-model `price(turn)` callback on a namespace entry's
		// override object is the per-model analogue of the top-level per-backend
		// `price`. The loader must compile it into the hardened pricing registry
		// keyed by the expanded `${backendId}-${providerModelId}` so the hot path
		// resolves it for the expanded backend.
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "bedrock", provider: "bedrock", region: "us-east-1", profile: "admin", model_overrides: { "anthropic.claude-haiku-5-5": { price(turn) { return turn.inputTokens / 1000; } } } }], default: "bedrock" };`,
		);

		await loadModelBackendsConfig(configDir);
		expect(
			calculateDynamicPrice("bedrock-anthropic.claude-haiku-5-5", {
				modelId: "bedrock-anthropic.claude-haiku-5-5",
				inputTokens: 100,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				pricesPerM: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		).toEqual({ value: 0.1, error: null });
	});

	it("rejects a function at a non-price key inside model_overrides", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "bedrock", provider: "bedrock", region: "us-east-1", profile: "admin", model_overrides: { "anthropic.claude-haiku-5-5": { logical_model: () => "haiku" } } }], default: "bedrock" };`,
		);

		await expect(loadModelBackendsConfig(configDir)).rejects.toThrow(
			"only backend.price or a model_overrides[*].price may be a function",
		);
	});
});
