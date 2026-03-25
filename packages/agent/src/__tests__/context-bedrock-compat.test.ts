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
	opts?: {
		id?: string;
		model_id?: string;
		tool_name?: string;
		offset?: number;
		timestamp?: string;
	},
) {
	const id = opts?.id ?? randomUUID();
	const ts = opts?.timestamp ?? new Date(new Date().getTime() + (opts?.offset ?? 0)).toISOString();
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

	it("fixes assistant message between tool_call and tool_result", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// Insert the EXACT sequence from the production bug:
		// user, assistant, user, assistant, user, tool_call, assistant, tool_result, system, user
		insertMessage(db, threadId, "user", "testing - tell me about yourself", { offset: 0 });
		insertMessage(db, threadId, "assistant", "I am an AI assistant.", {
			offset: 1000,
			model_id: "anthropic.claude-sonnet",
		});
		insertMessage(db, threadId, "user", "Asking for debugging purposes...", { offset: 2000 });
		insertMessage(db, threadId, "assistant", "Here is some debug info.", {
			offset: 3000,
			model_id: "anthropic.claude-sonnet",
		});
		insertMessage(db, threadId, "user", "Updated - check again?", { offset: 4000 });
		insertMessage(
			db,
			threadId,
			"tool_call",
			JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_xxx",
					name: "bash",
					input: { command: "hostinfo" },
				},
			]),
			{ tool_name: "bash", offset: 5000 },
		);
		insertMessage(db, threadId, "assistant", "Let me look at what's actually loaded now...", {
			offset: 6000,
			model_id: "anthropic.claude-sonnet",
		});
		insertMessage(db, threadId, "tool_result", "bash: hostinfo: command not found", {
			tool_name: "bash",
			offset: 7000,
		});
		insertMessage(db, threadId, "system", "Agent response was interrupted due to an error.", {
			offset: 8000,
		});
		insertMessage(db, threadId, "user", "Just fixed another bug...", { offset: 9000 });

		const messages = assembleContext({ db, threadId, userId });

		// Extract only the history portion (skip system prompt / orientation / volatile)
		const history = messages.filter(
			(m) =>
				m.role !== "system" ||
				(typeof m.content === "string" &&
					!m.content.startsWith("You are a helpful") &&
					!m.content.startsWith("## Orientation") &&
					!m.content.startsWith("User ID:") &&
					!m.content.startsWith("Model switched")),
		);

		// Find tool_call and tool_result in the output
		const toolCallIdx = history.findIndex((m) => m.role === "tool_call");
		const toolResultIdx = history.findIndex((m) => m.role === "tool_result");

		expect(toolCallIdx).not.toBe(-1);
		expect(toolResultIdx).not.toBe(-1);

		// CRITICAL: tool_result must immediately follow tool_call (no assistant between them)
		expect(toolResultIdx).toBe(toolCallIdx + 1);

		// The interleaved assistant message should appear BEFORE the tool_call, not between
		const assistantBeforeToolCall = history
			.slice(0, toolCallIdx)
			.filter((m) => m.role === "assistant");
		const hasMovedAssistant = assistantBeforeToolCall.some(
			(m) =>
				typeof m.content === "string" &&
				m.content.includes("Let me look at what's actually loaded now"),
		);
		expect(hasMovedAssistant).toBe(true);
	});

	it("handles conversation with multiple alert messages in history", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// Insert: user, assistant, alert, alert, system, user
		insertMessage(db, threadId, "user", "Hello there", { offset: 0 });
		insertMessage(db, threadId, "assistant", "Hi! How can I help?", {
			offset: 1000,
			model_id: "anthropic.claude-sonnet",
		});
		insertMessage(db, threadId, "alert", "Internal error: timeout exceeded", {
			offset: 2000,
		});
		insertMessage(db, threadId, "alert", "Internal error: retry failed", {
			offset: 3000,
		});
		insertMessage(db, threadId, "system", "Agent response was interrupted due to an error.", {
			offset: 4000,
		});
		insertMessage(db, threadId, "user", "Are you still there?", { offset: 5000 });

		const messages = assembleContext({ db, threadId, userId });

		// Alerts should be completely filtered out
		const alertMessages = messages.filter((m) => m.role === "alert");
		expect(alertMessages).toHaveLength(0);

		// User and assistant messages should remain
		const userMessages = messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(2);
		expect(userMessages[0].content).toBe("Hello there");
		expect(userMessages[1].content).toBe("Are you still there?");

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages).toHaveLength(1);
		expect(assistantMessages[0].content).toBe("Hi! How can I help?");
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

	it("production 17-message sequence: alerts and system messages filtered before sanitizer", () => {
		const threadId = randomUUID();
		insertThread(db, threadId, userId);

		// EXACT 17-message sequence from the production database, ORDER BY created_at ASC.
		// Messages 6 and 7 share the same timestamp (tool_call emitted alongside assistant).
		// alert and system messages appear between tool_result and subsequent user messages.

		// 1. user
		insertMessage(db, threadId, "user", "testing - tell me about yourself", {
			timestamp: "2026-03-23T14:34:53.000Z",
		});
		// 2. assistant
		insertMessage(db, threadId, "assistant", "About Me...", {
			timestamp: "2026-03-23T14:35:01.322Z",
			model_id: "anthropic.claude-sonnet",
		});
		// 3. user
		insertMessage(db, threadId, "user", "Asking for debugging...", {
			timestamp: "2026-03-23T14:35:50.049Z",
		});
		// 4. assistant
		insertMessage(db, threadId, "assistant", "What's in My Context...", {
			timestamp: "2026-03-23T14:35:58.937Z",
			model_id: "anthropic.claude-sonnet",
		});
		// 5. user
		insertMessage(db, threadId, "user", "Updated - check again?", {
			timestamp: "2026-03-23T14:52:52.468Z",
		});
		// 6. tool_call — SAME TIMESTAMP as message 7
		insertMessage(
			db,
			threadId,
			"tool_call",
			JSON.stringify([
				{
					type: "tool_use",
					id: "tooluse_xxx",
					name: "bash",
					input: { command: "hostinfo" },
				},
			]),
			{ tool_name: "bash", timestamp: "2026-03-23T14:52:56.204Z" },
		);
		// 7. assistant — SAME TIMESTAMP as tool_call
		insertMessage(db, threadId, "assistant", "Let me look...", {
			timestamp: "2026-03-23T14:52:56.204Z",
			model_id: "anthropic.claude-sonnet",
		});
		// 8. tool_result
		insertMessage(db, threadId, "tool_result", "bash: hostinfo: command not found", {
			tool_name: "tooluse_xxx",
			timestamp: "2026-03-23T14:52:56.205Z",
		});
		// 9. alert
		insertMessage(db, threadId, "alert", "Error: Bedrock...", {
			timestamp: "2026-03-23T14:52:58.583Z",
		});
		// 10. user
		insertMessage(db, threadId, "user", "Continue", {
			timestamp: "2026-03-23T14:53:32.191Z",
		});
		// 11. alert
		insertMessage(db, threadId, "alert", "Error: Bedrock...", {
			timestamp: "2026-03-23T14:53:34.774Z",
		});
		// 12. system
		insertMessage(db, threadId, "system", "Agent response interrupted...", {
			timestamp: "2026-03-23T15:10:42.488Z",
		});
		// 13. user
		insertMessage(db, threadId, "user", "Just fixed...", {
			timestamp: "2026-03-23T15:11:30.662Z",
		});
		// 14. alert
		insertMessage(db, threadId, "alert", "Error: Bedrock...", {
			timestamp: "2026-03-23T15:11:33.459Z",
		});
		// 15. system
		insertMessage(db, threadId, "system", "Agent response interrupted...", {
			timestamp: "2026-03-23T16:41:52.377Z",
		});
		// 16. user
		insertMessage(db, threadId, "user", "again", {
			timestamp: "2026-03-23T16:42:07.435Z",
		});
		// 17. alert
		insertMessage(db, threadId, "alert", "Error: Bedrock...", {
			timestamp: "2026-03-23T16:42:10.114Z",
		});

		const messages = assembleContext({ db, threadId, userId });

		// Helper: extract the history portion (skip assembly-injected system messages)
		const isAssemblySystem = (m: { role: string; content: string | unknown }) =>
			m.role === "system" &&
			typeof m.content === "string" &&
			(m.content.startsWith("You are a helpful") ||
				m.content.startsWith("## Orientation") ||
				m.content.startsWith("User ID:") ||
				m.content.startsWith("Model switched"));

		const history = messages.filter((m) => !isAssemblySystem(m));

		// 1. NO alert-role messages in the output
		const alerts = history.filter((m) => m.role === "alert");
		expect(alerts).toHaveLength(0);

		// 2. NO DB-originated system-role messages in the history
		//    (assembly-injected system messages are already filtered above)
		const dbSystems = history.filter(
			(m) =>
				m.role === "system" &&
				typeof m.content === "string" &&
				m.content.includes("Agent response interrupted"),
		);
		expect(dbSystems).toHaveLength(0);

		// 3. tool_call is immediately followed by tool_result (Bedrock requires adjacency)
		const toolCallIdx = history.findIndex((m) => m.role === "tool_call");
		const toolResultIdx = history.findIndex((m) => m.role === "tool_result");
		expect(toolCallIdx).not.toBe(-1);
		expect(toolResultIdx).not.toBe(-1);
		expect(toolResultIdx).toBe(toolCallIdx + 1);

		// 4. The assistant that shared tool_call's timestamp was moved BEFORE tool_call
		const assistantsBefore = history.slice(0, toolCallIdx).filter((m) => m.role === "assistant");
		const movedAssistant = assistantsBefore.some(
			(m) => typeof m.content === "string" && m.content === "Let me look...",
		);
		expect(movedAssistant).toBe(true);

		// 5. Only LLM-compatible roles remain in the entire output
		const validRoles = new Set(["user", "assistant", "system", "tool_call", "tool_result"]);
		for (const msg of messages) {
			expect(validRoles.has(msg.role)).toBe(true);
		}

		// 6. Expected history role sequence after filtering 4 alerts + 2 systems
		//    and moving the assistant (msg 7) before tool_call:
		//    user, assistant, user, assistant, user, assistant, tool_call, tool_result, user, user, user
		const expectedRoles = [
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"tool_call",
			"tool_result",
			"user",
			"user",
			"user",
		];
		const historyRoles = history.map((m) => m.role);
		expect(historyRoles).toEqual(expectedRoles);
	});
});
