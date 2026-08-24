/**
 * Regression tests for `max_output_tokens` propagation through resolveModel.
 *
 * Background: some Bedrock models cap the response-side `maxOutputTokens`
 * parameter below what the provider would default to. Notably, Nova Pro
 * rejects anything above 10_000 with:
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import { createModelRouter } from "@bound/llm";
import { resolveModel } from "../model-resolution";

let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-model-resolution-system-prompt-suffix-${testId}.db`);
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

describe("Model resolution systemPromptSuffix", () => {
	it("attaches the suffix only to the configured local model", () => {
		const router = createModelRouter({
			backends: [
				{
					id: "configured",
					provider: "bedrock",
					region: "us-west-2",
					model: "anthropic.configured",
					contextWindow: 200000,
					systemPromptSuffix: "Configured only.",
				},
				{
					id: "plain",
					provider: "bedrock",
					region: "us-west-2",
					model: "anthropic.plain",
					contextWindow: 200000,
				},
			],
			default: "configured",
		});
		const configured = resolveModel("configured", router, db, "local-site-id");
		const plain = resolveModel("plain", router, db, "local-site-id");
		expect(configured.kind).toBe("local");
		expect(plain.kind).toBe("local");
		if (configured.kind === "local") expect(configured.systemPromptSuffix).toBe("Configured only.");
		if (plain.kind === "local") expect(plain.systemPromptSuffix).toBeUndefined();
	});
});
