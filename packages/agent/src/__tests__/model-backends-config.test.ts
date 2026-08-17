import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "@bound/shared/test-utils";
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

	it("loads the default export and preserves a backend price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, tier: 1, base_url: "\${TEST_BACKEND_URL:-http://localhost:11434/v1}", price(turn) { return turn.inputTokens / 1000; } }], default: "local" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.backends[0]?.base_url).toBe("http://localhost:11434/v1");
		expect(config.backends[0]).not.toHaveProperty("price_function");
		expect(config.backends[0]).not.toHaveProperty("price");
	});

	it("rejects functions outside backend.price", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: () => "x", context_window: 8192, tier: 1, base_url: "http://localhost:11434/v1" }], default: "local" };`,
		);

		await expect(loadModelBackendsConfig(configDir)).rejects.toThrow(
			"only backend.price may be a function",
		);
	});

	it("does not expose backend price callbacks as inline price_function fields", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, tier: 1, base_url: "http://localhost:11434/v1", price() { return 1; } }], default: "local" };`,
		);

		const config = await loadModelBackendsConfig(configDir);
		expect(config.backends[0]).not.toHaveProperty("price_function");
	});

	it("does not publish a candidate with an invalid price callback", async () => {
		writeFileSync(
			join(configDir, "model_backends.js"),
			`export default { backends: [{ id: "local", provider: "openai-compatible", model: "x", context_window: 8192, tier: 1, base_url: "http://localhost:11434/v1", price() { return -1; } }], default: "local" };`,
		);

		await expect(loadModelBackendsConfig(configDir)).rejects.toThrow("finite non-negative number");
	});
});
