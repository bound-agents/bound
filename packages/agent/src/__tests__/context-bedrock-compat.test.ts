import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { assembleContext } from "../context-assembly";

/**
 * Tests for Bedrock-compatibility bugs found during live Discord testing:
 * 1. alert-role messages leaking into LLM context
 * 2. tool_result messages with empty/null tool_use_id
 * 3. orphaned tool_results without matching tool_call
 */

function insertThread(db: Database, threadId: string, userId: string) {
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			threadId,
			userId,
			"web",
			"local",
			0,
			"Test Thread",
			null,
			null,
			null,
			null,
			new Date().toISOString(),
			new Date().toISOString(),
			new Date().toISOString(),
			0,
		],
	);
}

function insertMessage(
	db: Database,
	threadId: string,
	role: string,
	content: string,
	opts?: { id?: string; model_id?: string; tool_name?: string; offset?: number },
) {
	const id = opts?.id ?? randomUUID();
	const baseTime = new Date();
	const ts = new Date(baseTime.getTime() + (opts?.offset ?? 0)).toISOString();
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[id, threadId, role, content, opts?.model_id ?? null, opts?.tool_name ?? null, ts, ts, "local"],
	);
	return id;
}

describe("Context assembly Bedrock compatibility", () => {
	let tmpDir: string;
	let db: Database;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "bedrock-compat-test-"));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);

		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("filters out alert-role messages from context", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		insertMessage(db, threadId, "user", "Hello", { offset: 0 });
		insertMessage(db, threadId, "assistant", "Hi there", { offset: 1000 });
		insertMessage(db, threadId, "alert", "Something went wrong internally", { offset: 2000 });
		insertMessage(db, threadId, "user", "Continue please", { offset: 3000 });

		const messages = assembleContext({ db, threadId, userId });

		// No message in the output should have role "alert"
		const alertMessages = messages.filter((m) => m.role === "alert");
		expect(alertMessages).toHaveLength(0);

		// The non-alert messages should still be present
		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(2);
		expect(userMessages[0].content).toBe("Hello");
		expect(userMessages[1].content).toBe("Continue please");
	});

	it("filters out purge-role messages from context (not just substitution)", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		insertMessage(db, threadId, "user", "First message", { offset: 0 });
		// A purge message with invalid JSON that won't parse for substitution
		insertMessage(db, threadId, "purge", "not-json", { offset: 1000 });
		insertMessage(db, threadId, "user", "Second message", { offset: 2000 });

		const messages = assembleContext({ db, threadId, userId });

		// No message in the output should have role "purge"
		const purgeMessages = messages.filter((m) => m.role === "purge");
		expect(purgeMessages).toHaveLength(0);

		// The user messages should still be present
		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(2);
	});

	it("only outputs LLM-compatible roles (user, assistant, system, tool_call, tool_result)", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		insertMessage(db, threadId, "user", "Hello", { offset: 0 });
		insertMessage(db, threadId, "alert", "Error alert", { offset: 1000 });
		insertMessage(db, threadId, "assistant", "Response", { offset: 2000 });

		const messages = assembleContext({ db, threadId, userId });

		const validRoles = new Set(["user", "assistant", "system", "tool_call", "tool_result"]);
		for (const msg of messages) {
			expect(validRoles.has(msg.role)).toBe(true);
		}
	});

	it("ensures all tool_result messages have non-empty tool_use_id after assembly", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// Insert: user, tool_call, tool_result (but the tool_result in DB has no tool_use_id
		// because that field doesn't exist in the messages table)
		const toolCallId = randomUUID();
		insertMessage(db, threadId, "user", "Do something", { offset: 0 });
		insertMessage(
			db,
			threadId,
			"tool_call",
			JSON.stringify([
				{ type: "tool_use", id: "tu-123", name: "query", input: { sql: "SELECT 1" } },
			]),
			{ id: toolCallId, tool_name: "query", offset: 1000 },
		);
		insertMessage(db, threadId, "tool_result", "Result: 1", { tool_name: "query", offset: 2000 });
		insertMessage(db, threadId, "assistant", "Done", { offset: 3000 });

		const messages = assembleContext({ db, threadId, userId });

		// Find the tool_result message
		const toolResults = messages.filter((m) => m.role === "tool_result");
		expect(toolResults.length).toBeGreaterThanOrEqual(1);

		// Every tool_result must have a non-empty tool_use_id for Bedrock compatibility
		for (const tr of toolResults) {
			expect(tr.tool_use_id).toBeDefined();
			expect(tr.tool_use_id).not.toBe("");
		}
	});

	it("removes orphaned tool_results without matching tool_call or pairs them", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// Insert an orphaned tool_result with no preceding tool_call
		insertMessage(db, threadId, "user", "Hello", { offset: 0 });
		insertMessage(db, threadId, "tool_result", "Orphaned result", {
			tool_name: "query",
			offset: 1000,
		});
		insertMessage(db, threadId, "assistant", "Continuing", { offset: 2000 });

		const messages = assembleContext({ db, threadId, userId });

		// If tool_result exists in output, it must have a preceding tool_call
		const toolResults = messages.filter((m) => m.role === "tool_result");
		const toolCalls = messages.filter((m) => m.role === "tool_call");

		// The number of tool_results should not exceed tool_calls
		expect(toolResults.length).toBeLessThanOrEqual(toolCalls.length);

		// Every tool_result that exists must have a non-empty tool_use_id
		for (const tr of toolResults) {
			expect(tr.tool_use_id).toBeDefined();
			expect(tr.tool_use_id).not.toBe("");
		}
	});
});
