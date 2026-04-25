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
	convertDeltaMessages,
	deriveCapabilityRequirements,
	getResolvedModelId,
	insertThreadMessage,
	isTransientLLMError,
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

		const row = db.query("SELECT exit_code FROM messages WHERE id = ?").get(id) as any;
		expect(row.exit_code).toBe(1);
	});

	it("creates a changelog entry", () => {
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

		const countAfter = (db.query("SELECT COUNT(*) as c FROM change_log").get() as any).c;
		expect(countAfter).toBe(countBefore + 1);
	});
});

describe("isTransientLLMError", () => {
	it("returns true for http2 connection errors", () => {
		const err = new Error("http2 request did not get a response");
		expect(isTransientLLMError(err)).toBe(true);
	});

	it("returns true for ECONNRESET", () => {
		const err = new Error("ECONNRESET");
		expect(isTransientLLMError(err)).toBe(true);
	});

	it("returns true for socket hang up", () => {
		const err = new Error("socket hang up");
		expect(isTransientLLMError(err)).toBe(true);
	});

	it("returns false for 'not valid JSON' — this is a 400 client error, not transient", () => {
		const err = new Error(
			"Bedrock request failed: The model returned the following errors: The request body is not valid JSON.",
		);
		expect(isTransientLLMError(err)).toBe(false);
	});

	it("returns false for LLMError with 4xx status code", () => {
		const { LLMError } = require("@bound/llm");
		const err = new LLMError("Bad request: blank text field", "bedrock", 400);
		expect(isTransientLLMError(err)).toBe(false);
	});

	it("returns false for LLMError with 422 status code even with transport-like message", () => {
		const { LLMError } = require("@bound/llm");
		const err = new LLMError("socket hang up during http2 request", "openai", 422);
		expect(isTransientLLMError(err)).toBe(false);
	});

	it("returns true for LLMError without status code and transport message", () => {
		const { LLMError } = require("@bound/llm");
		const err = new LLMError("http2 connection dropped", "bedrock", undefined);
		expect(isTransientLLMError(err)).toBe(true);
	});

	it("returns false for generic non-transport errors", () => {
		const err = new Error("Something went wrong");
		expect(isTransientLLMError(err)).toBe(false);
	});
});

describe("parseToolResultContent", () => {
	// Lazy import since we're adding this function
	let parseToolResultContent: typeof import("../agent-loop-utils").parseToolResultContent;

	beforeAll(async () => {
		const mod = await import("../agent-loop-utils");
		parseToolResultContent = mod.parseToolResultContent;
	});

	it("returns plain string as-is for regular text content", () => {
		const result = parseToolResultContent("hello world");
		expect(result).toBe("hello world");
	});

	it("returns plain string for invalid JSON", () => {
		const result = parseToolResultContent("not json at all");
		expect(result).toBe("not json at all");
	});

	it("returns plain string for JSON that is not a ContentBlock array", () => {
		const result = parseToolResultContent(JSON.stringify({ key: "value" }));
		expect(result).toBe(JSON.stringify({ key: "value" }));
	});

	it("returns plain string for JSON array without type fields", () => {
		const result = parseToolResultContent(JSON.stringify([1, 2, 3]));
		expect(result).toBe(JSON.stringify([1, 2, 3]));
	});

	it("returns ContentBlock[] when content is valid JSON with image blocks", () => {
		const blocks = [
			{ type: "text", text: "Here is the screenshot" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
			},
		];
		const result = parseToolResultContent(JSON.stringify(blocks));
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(2);
		expect((result as Array<Record<string, unknown>>)[0]).toEqual({
			type: "text",
			text: "Here is the screenshot",
		});
		expect((result as Array<Record<string, unknown>>)[1]).toEqual({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
		});
	});

	it("returns plain string for text-only ContentBlock[] (no images)", () => {
		// Text-only arrays should stay as plain string to avoid unnecessary overhead
		const blocks = [{ type: "text", text: "just text" }];
		const result = parseToolResultContent(JSON.stringify(blocks));
		expect(result).toBe(JSON.stringify(blocks));
	});
});

// ---------------------------------------------------------------------------
// convertDeltaMessages — regression coverage for parallel tool-call delta
// ---------------------------------------------------------------------------
//
// Context: thread 0ab688b2 hit a Bedrock `tool_use_id_mismatch` after a
// parallel-tool-call turn. The LLM emitted two tool_use blocks in one
// assistant message; two client-tool results arrived back-to-back and were
// inserted as two consecutive `tool_result` DB rows. The warm-path delta
// converter dropped the second one because its `previousRole !== "tool_call"`
// predicate saw `tool_result` preceding it and treated it as orphaned.
//
// These tests pin the expected behavior: a `tool_result` whose predecessor is
// itself a `tool_result` tied to an earlier `tool_call` in the same delta is
// valid and must be preserved.

function mkRow(overrides: {
	role: string;
	content: string;
	tool_name?: string | null;
	created_at?: string;
}) {
	return {
		id: randomUUID(),
		thread_id: "t",
		role: overrides.role,
		content: overrides.content,
		model_id: null,
		tool_name: overrides.tool_name ?? null,
		created_at: overrides.created_at ?? new Date().toISOString(),
		modified_at: null,
		host_origin: "h",
		deleted: 0,
	};
}

describe("convertDeltaMessages", () => {
	it("preserves two consecutive tool_result rows that follow a tool_call (parallel tool calls)", () => {
		const rows = [
			mkRow({
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "tu_A", name: "foo", input: {} },
					{ type: "tool_use", id: "tu_B", name: "bar", input: {} },
				]),
			}),
			mkRow({ role: "tool_result", content: "result-A", tool_name: "tu_A" }),
			mkRow({ role: "tool_result", content: "result-B", tool_name: "tu_B" }),
		];

		const out = convertDeltaMessages(rows);

		// Regression: previous behavior dropped the second tool_result.
		expect(out).toHaveLength(3);
		expect(out[0].role).toBe("tool_call");
		expect(out[1].role).toBe("tool_result");
		expect(out[1].tool_use_id).toBe("tu_A");
		expect(out[2].role).toBe("tool_result");
		expect(out[2].tool_use_id).toBe("tu_B");
	});

	it("preserves three consecutive tool_result rows after a 3-way parallel tool_call", () => {
		const rows = [
			mkRow({
				role: "tool_call",
				content: JSON.stringify([
					{ type: "tool_use", id: "tu_1", name: "a", input: {} },
					{ type: "tool_use", id: "tu_2", name: "b", input: {} },
					{ type: "tool_use", id: "tu_3", name: "c", input: {} },
				]),
			}),
			mkRow({ role: "tool_result", content: "r1", tool_name: "tu_1" }),
			mkRow({ role: "tool_result", content: "r2", tool_name: "tu_2" }),
			mkRow({ role: "tool_result", content: "r3", tool_name: "tu_3" }),
		];

		const out = convertDeltaMessages(rows);
		expect(out).toHaveLength(4);
		expect(out.filter((m) => m.role === "tool_result")).toHaveLength(3);
	});

	it("still drops a tool_result that has no preceding tool_call anywhere in the delta", () => {
		const rows = [
			mkRow({ role: "user", content: "hi" }),
			mkRow({ role: "tool_result", content: "orphan", tool_name: "tu_X" }),
		];

		const out = convertDeltaMessages(rows);
		// The tool_result has no tool_call ancestor — it's a genuine orphan.
		expect(out).toHaveLength(1);
		expect(out[0].role).toBe("user");
	});
});
