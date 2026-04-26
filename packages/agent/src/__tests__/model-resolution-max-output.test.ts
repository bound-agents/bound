/**
 * Regression tests for `max_output_tokens` propagation through resolveModel.
 *
 * Background: some Bedrock models cap the response-side `maxOutputTokens`
 * parameter below the agent-loop default (DEFAULT_MAX_OUTPUT_TOKENS =
 * 16_384). Notably, Nova Pro rejects anything above 10_000 with:
 *
 *   ValidationException: max_tokens exceeds model limit of 10000
 *
 * The fix threads a `maxOutputTokens` field from the backend config through
 * `toRouterConfig()` (CLI layer) → router → `ModelResolution.local` →
 * agent-loop chat() call. This test locks the router → resolution hop so
 * the agent-loop can trust `resolution.maxOutputTokens` when clamping.
 */

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
	testDbPath = `/tmp/test-model-resolution-max-output-${testId}.db`;
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

describe("Model resolution maxOutputTokens", () => {
	it("attaches maxOutputTokens when backend has the cap set", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "nova-pro",
					provider: "bedrock",
					region: "us-west-2",
					model: "us.amazon.nova-pro-v1:0",
					contextWindow: 300000,
					maxOutputTokens: 8192,
				},
			],
			default: "nova-pro",
		});

		const resolution = resolveModel("nova-pro", router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.maxOutputTokens).toBe(8192);
		}
	});

	it("leaves maxOutputTokens undefined when backend has no cap configured", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "opus",
					provider: "bedrock",
					region: "us-west-2",
					model: "global.anthropic.claude-opus-4-7",
					contextWindow: 200000,
				},
			],
			default: "opus",
		});

		const resolution = resolveModel("opus", router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.maxOutputTokens).toBeUndefined();
		}
	});

	it("attaches maxOutputTokens when resolved via default", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "nova-pro",
					provider: "bedrock",
					region: "us-west-2",
					model: "us.amazon.nova-pro-v1:0",
					contextWindow: 300000,
					maxOutputTokens: 8192,
				},
			],
			default: "nova-pro",
		});

		const resolution = resolveModel(undefined, router, db, "local-site-id");
		expect(resolution.kind).toBe("local");
		if (resolution.kind === "local") {
			expect(resolution.maxOutputTokens).toBe(8192);
		}
	});
});
