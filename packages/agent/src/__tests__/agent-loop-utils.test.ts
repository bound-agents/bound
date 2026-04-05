import type { Database } from "bun:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import {
	buildCommandOutput,
	calculateTurnCost,
	deriveCapabilityRequirements,
	getResolvedModelId,
	insertThreadMessage,
} from "../agent-loop-utils";
import type { ModelResolution } from "../model-resolution";

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------
let db: Database;
let tmpDir: string;
const siteId = "test-site-0001";
const hostName = "test-host";

beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "helpers-test-"));
	db = createDatabase(join(tmpDir, "test.db"));
	applySchema(db);
});

beforeEach(() => {
	db.exec("DELETE FROM messages");
	db.exec("DELETE FROM change_log");
});

// ---------------------------------------------------------------------------
// buildCommandOutput
// ---------------------------------------------------------------------------
describe("buildCommandOutput", () => {
	it("returns stdout when present", () => {
		expect(buildCommandOutput("hello", undefined, 0)).toBe("hello");
	});

	it("returns stderr when present", () => {
		expect(buildCommandOutput(undefined, "err", 1)).toBe("err");
	});

	it("joins stdout and stderr with newline", () => {
		expect(buildCommandOutput("out", "err", 0)).toBe("out\nerr");
	});

	it("returns success message when no output and exitCode 0", () => {
		expect(buildCommandOutput(undefined, undefined, 0)).toBe("Command completed successfully");
	});

	it("returns exit code message when no output and non-zero exit", () => {
		expect(buildCommandOutput(undefined, undefined, 3)).toBe("Exit code: 3");
	});

	it("defaults exitCode to 0 when undefined", () => {
		expect(buildCommandOutput(undefined, undefined, undefined)).toBe(
			"Command completed successfully",
		);
	});

	it("treats empty strings as falsy", () => {
		expect(buildCommandOutput("", "", 0)).toBe("Command completed successfully");
	});
});

// ---------------------------------------------------------------------------
// calculateTurnCost
// ---------------------------------------------------------------------------
describe("calculateTurnCost", () => {
	const backends = [
		{
			id: "claude-opus",
			price_per_m_input: 15,
			price_per_m_output: 75,
			price_per_m_cache_read: 1.5,
			price_per_m_cache_write: 18.75,
		},
		{
			id: "claude-haiku",
			price_per_m_input: 0.25,
			price_per_m_output: 1.25,
		},
	];

	it("computes cost from input and output tokens", () => {
		const cost = calculateTurnCost(
			"claude-opus",
			{
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
			backends,
		);
		expect(cost).toBe(15 + 75); // $90
	});

	it("includes cache read and write costs", () => {
		const cost = calculateTurnCost(
			"claude-opus",
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 1_000_000,
				cacheWriteTokens: 1_000_000,
			},
			backends,
		);
		expect(cost).toBe(1.5 + 18.75);
	});

	it("returns 0 for unknown model", () => {
		const cost = calculateTurnCost(
			"unknown-model",
			{
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
			backends,
		);
		expect(cost).toBe(0);
	});

	it("handles backend without cache pricing", () => {
		const cost = calculateTurnCost(
			"claude-haiku",
			{
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
				cacheReadTokens: 500_000,
				cacheWriteTokens: 500_000,
			},
			backends,
		);
		// Only input + output, cache prices default to 0
		expect(cost).toBe(0.25 + 1.25);
	});

	it("returns 0 for empty backends array", () => {
		const cost = calculateTurnCost(
			"claude-opus",
			{
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
			[],
		);
		expect(cost).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// getResolvedModelId
// ---------------------------------------------------------------------------
describe("getResolvedModelId", () => {
	it("returns modelId from local resolution", () => {
		const res: ModelResolution = {
			kind: "local",
			// biome-ignore lint/suspicious/noExplicitAny: test mock
			backend: {} as any,
			modelId: "claude-opus",
		};
		expect(getResolvedModelId(res)).toBe("claude-opus");
	});

	it("returns modelId from remote resolution", () => {
		const res: ModelResolution = {
			kind: "remote",
			hosts: [],
			modelId: "claude-sonnet",
		};
		expect(getResolvedModelId(res)).toBe("claude-sonnet");
	});

	it("returns 'unknown' for error resolution with no fallback", () => {
		const res: ModelResolution = {
			kind: "error",
			error: "no backends",
		};
		expect(getResolvedModelId(res)).toBe("unknown");
	});

	it("returns fallback for error resolution", () => {
		const res: ModelResolution = {
			kind: "error",
			error: "no backends",
		};
		expect(getResolvedModelId(res, "my-fallback")).toBe("my-fallback");
	});

	it("returns 'unknown' for null resolution", () => {
		expect(getResolvedModelId(null)).toBe("unknown");
	});
});

// ---------------------------------------------------------------------------
// deriveCapabilityRequirements
// ---------------------------------------------------------------------------
describe("deriveCapabilityRequirements", () => {
	const threadId = "thread-caps-test";

	it("returns tool_use when hasTools is true", () => {
		const req = deriveCapabilityRequirements(db, threadId, true);
		expect(req).toEqual({ tool_use: true });
	});

	it("returns undefined when no tools and no images", () => {
		const req = deriveCapabilityRequirements(db, threadId, false);
		expect(req).toBeUndefined();
	});

	it("detects vision requirement from image content blocks", () => {
		const imageContent = JSON.stringify([
			{ type: "text", text: "Look at this" },
			{ type: "image", source: { type: "base64", data: "abc" } },
		]);
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: imageContent,
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: hostName,
			},
			siteId,
		);

		const req = deriveCapabilityRequirements(db, threadId, false);
		expect(req).toEqual({ vision: true });
	});

	it("returns both tool_use and vision when applicable", () => {
		const imageContent = JSON.stringify([
			{ type: "image", source: { type: "base64", data: "abc" } },
		]);
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: imageContent,
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: hostName,
			},
			siteId,
		);

		const req = deriveCapabilityRequirements(db, threadId, true);
		expect(req).toEqual({ tool_use: true, vision: true });
	});

	it("ignores non-JSON content gracefully", () => {
		insertRow(
			db,
			"messages",
			{
				id: randomUUID(),
				thread_id: threadId,
				role: "user",
				content: "just plain text",
				model_id: null,
				tool_name: null,
				created_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				host_origin: hostName,
			},
			siteId,
		);

		const req = deriveCapabilityRequirements(db, threadId, false);
		expect(req).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// insertThreadMessage
// ---------------------------------------------------------------------------
describe("insertThreadMessage", () => {
	const threadId = "thread-msg-test";

	it("inserts a message and returns its id", () => {
		const id = insertThreadMessage(
			db,
			{
				threadId,
				role: "assistant",
				content: "Hello world",
				hostOrigin: hostName,
			},
			siteId,
		);

		expect(typeof id).toBe("string");
		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const row = db.query("SELECT * FROM messages WHERE id = ?").get(id) as any;
		expect(row).not.toBeNull();
		expect(row.thread_id).toBe(threadId);
		expect(row.role).toBe("assistant");
		expect(row.content).toBe("Hello world");
		expect(row.host_origin).toBe(hostName);
	});

	it("sets model_id when provided", () => {
		const id = insertThreadMessage(
			db,
			{
				threadId,
				role: "assistant",
				content: "test",
				hostOrigin: hostName,
				modelId: "claude-opus",
			},
			siteId,
		);

		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const row = db.query("SELECT model_id FROM messages WHERE id = ?").get(id) as any;
		expect(row.model_id).toBe("claude-opus");
	});

	it("sets tool_name when provided", () => {
		const id = insertThreadMessage(
			db,
			{
				threadId,
				role: "tool_result",
				content: "result",
				hostOrigin: hostName,
				toolName: "tool-call-123",
			},
			siteId,
		);

		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const row = db.query("SELECT tool_name FROM messages WHERE id = ?").get(id) as any;
		expect(row.tool_name).toBe("tool-call-123");
	});

	it("sets exit_code when provided", () => {
		const id = insertThreadMessage(
			db,
			{
				threadId,
				role: "tool_result",
				content: "error output",
				hostOrigin: hostName,
				exitCode: 1,
			},
			siteId,
		);

		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const row = db.query("SELECT exit_code FROM messages WHERE id = ?").get(id) as any;
		expect(row.exit_code).toBe(1);
	});

	it("creates a changelog entry", () => {
		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const countBefore = (db.query("SELECT COUNT(*) as c FROM change_log").get() as any).c;

		insertThreadMessage(
			db,
			{
				threadId,
				role: "alert",
				content: "test alert",
				hostOrigin: hostName,
			},
			siteId,
		);

		// biome-ignore lint/suspicious/noExplicitAny: DB row type
		const countAfter = (db.query("SELECT COUNT(*) as c FROM change_log").get() as any).c;
		expect(countAfter).toBe(countBefore + 1);
	});
});
