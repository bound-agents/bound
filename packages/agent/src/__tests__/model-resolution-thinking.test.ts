import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { createModelRouter } from "@bound/llm";
import { resolveModel } from "../model-resolution";

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = `/tmp/test-model-resolution-thinking-${testId}.db`;
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("Model resolution thinkingConfig", () => {
	it("attaches thinkingConfig when backend has thinking: true", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock", region: "us-east-1",
					model: "claude-sonnet-4-20250514",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: true,
				},
			],
			default: "claude",
		});

		const resolution = resolveModel("claude", router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.thinkingConfig).toBeDefined();
			expect(resolution.thinkingConfig?.type).toBe("enabled");
			expect(resolution.thinkingConfig?.budget_tokens).toBe(10000);
		}
	});

	it("attaches thinkingConfig with custom budget_tokens", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock", region: "us-east-1",
					model: "claude-sonnet-4-20250514",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: { budget_tokens: 20000 },
				},
			],
			default: "claude",
		});

		const resolution = resolveModel("claude", router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.thinkingConfig?.budget_tokens).toBe(20000);
		}
	});

	it("does not attach thinkingConfig when backend has no thinking config", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "local",
					provider: "openai-compatible",
					model: "llama3",
					baseUrl: "http://localhost:11434/v1",
					apiKey: "test-key",
					contextWindow: 4096,
				},
			],
			default: "local",
		});

		const resolution = resolveModel("local", router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.thinkingConfig).toBeUndefined();
		}
	});

	it("attaches thinkingConfig when resolved via default", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "claude",
					provider: "bedrock", region: "us-east-1",
					model: "claude-sonnet-4-20250514",
					apiKey: "test-key",
					contextWindow: 200000,
					thinking: true,
				},
			],
			default: "claude",
		});

		const resolution = resolveModel(undefined, router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.thinkingConfig).toBeDefined();
		}
	});
});
