import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { assembleContext } from "../context-assembly";

describe("Context Assembly Pipeline", () => {
	let tmpDir: string;
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "context-test-"));
		dbPath = join(tmpDir, "test.db");

		// Create database and apply schema
		db = createDatabase(dbPath);
		applySchema(db);

		// Create a test user and thread
		userId = randomUUID();
		threadId = randomUUID();

		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

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
	});

	afterAll(() => {
		db.close();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("should return an array of LLMMessages", async () => {
		const messages = assembleContext({
			db,
			threadId,
			userId,
		});

		expect(Array.isArray(messages)).toBe(true);
	});

	it("should assemble context with message history", async () => {
		// Insert a user message
		const msgId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				msgId,
				threadId,
				"user",
				"Hello",
				null,
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				"local",
			],
		);

		const messages = assembleContext({
			db,
			threadId,
			userId,
		});

		expect(Array.isArray(messages)).toBe(true);
	});

	it("should support no_history mode", async () => {
		const messages = assembleContext({
			db,
			threadId,
			userId,
			noHistory: true,
		});

		expect(Array.isArray(messages)).toBe(true);
	});

	it("should inject persona when config/persona.md exists", async () => {
		const configDir = join(tmpDir, "config");
		mkdirSync(configDir, { recursive: true });

		const personaContent =
			"You are a specialized technical assistant focused on system architecture.";
		writeFileSync(join(configDir, "persona.md"), personaContent);

		const messages = assembleContext({
			db,
			threadId,
			userId,
			configDir,
		});

		// Should have system message with persona content
		const personaMessage = messages.find(
			(m) => m.role === "system" && m.content.includes("specialized technical assistant"),
		);
		expect(personaMessage).toBeDefined();
		expect(personaMessage?.content).toContain(personaContent);
	});

	it("should work without persona when config/persona.md does not exist", async () => {
		const configDir = join(tmpDir, "no-persona");
		mkdirSync(configDir, { recursive: true });

		const messages = assembleContext({
			db,
			threadId,
			userId,
			configDir,
		});

		// Should still have system messages but without persona
		expect(Array.isArray(messages)).toBe(true);
		expect(messages.length > 0).toBe(true);
	});

	it("should cache persona content for the same config directory", async () => {
		const configDir = join(tmpDir, "cached-persona");
		mkdirSync(configDir, { recursive: true });

		const personaContent = "Cached persona content";
		writeFileSync(join(configDir, "persona.md"), personaContent);

		// First call - loads from file
		const messages1 = assembleContext({
			db,
			threadId,
			userId,
			configDir,
		});

		// Modify file
		writeFileSync(join(configDir, "persona.md"), "Modified content");

		// Second call - should use cache
		const messages2 = assembleContext({
			db,
			threadId,
			userId,
			configDir,
		});

		// Both should have the original persona content due to caching
		const persona1 = messages1.find(
			(m) => m.role === "system" && m.content.includes("Cached persona"),
		);
		const persona2 = messages2.find(
			(m) => m.role === "system" && m.content.includes("Cached persona"),
		);

		expect(persona1).toBeDefined();
		expect(persona2).toBeDefined();
	});

	describe("Purge Message Substitution", () => {
		it("should replace purged messages with a system message containing summary", async () => {
			const testThreadId = randomUUID();
			const testUserId = randomUUID();

			// Create a new thread for this test
			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					testThreadId,
					testUserId,
					"web",
					"local",
					0,
					"Purge Test Thread",
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

			// Insert some messages
			const msg1Id = randomUUID();
			const msg2Id = randomUUID();
			const msg3Id = randomUUID();

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg1Id,
					testThreadId,
					"user",
					"Message 1",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg2Id,
					testThreadId,
					"assistant",
					"Message 2",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg3Id,
					testThreadId,
					"user",
					"Message 3",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			// Create a purge message targeting msg1 and msg2
			const purgeId = randomUUID();
			const purgeContent = JSON.stringify({
				target_ids: [msg1Id, msg2Id],
				summary: "Removed initial greeting messages",
			});

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					purgeId,
					testThreadId,
					"purge",
					purgeContent,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			const messages = assembleContext({
				db,
				threadId: testThreadId,
				userId: testUserId,
			});

			// Should have system messages + purge summary + msg3
			const userMessages = messages.filter((m) => m.role === "user");
			const systemMessages = messages.filter((m) => m.role === "system");

			// Only msg3 should remain as a user message
			expect(userMessages.length).toBe(1);
			expect(userMessages[0].content).toBe("Message 3");

			// Should have a system message with the purge summary
			const purgeSummary = systemMessages.find((m) => m.content.includes("purged 2 messages"));
			expect(purgeSummary).toBeDefined();
			expect(purgeSummary?.content).toContain("Removed initial greeting messages");
		});

		it("should purge tool_call/tool_result pairs together", async () => {
			const testThreadId = randomUUID();
			const testUserId = randomUUID();

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					testThreadId,
					testUserId,
					"web",
					"local",
					0,
					"Tool Purge Test",
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

			// Insert a tool_call and tool_result pair
			const toolCallId = randomUUID();
			const toolResultId = randomUUID();
			const userMsgId = randomUUID();

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					toolCallId,
					testThreadId,
					"tool_call",
					JSON.stringify({ tool_name: "query", input: {} }),
					null,
					"query",
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					toolResultId,
					testThreadId,
					"tool_result",
					"Query result",
					null,
					"query",
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					userMsgId,
					testThreadId,
					"user",
					"Keep this message",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			// Purge only the tool_call - the tool_result should be automatically included
			const purgeId = randomUUID();
			const purgeContent = JSON.stringify({
				target_ids: [toolCallId],
				summary: "Removed tool execution",
			});

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					purgeId,
					testThreadId,
					"purge",
					purgeContent,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			const messages = assembleContext({
				db,
				threadId: testThreadId,
				userId: testUserId,
			});

			// Neither tool_call nor tool_result should be in the output
			const toolMessages = messages.filter(
				(m) => m.role === "tool_call" || m.role === "tool_result",
			);
			expect(toolMessages.length).toBe(0);

			// User message should remain
			const userMessages = messages.filter((m) => m.role === "user");
			expect(userMessages.length).toBe(1);
			expect(userMessages[0].content).toBe("Keep this message");

			// Should have purge summary indicating 2 messages (tool_call + tool_result)
			const systemMessages = messages.filter((m) => m.role === "system");
			const purgeSummary = systemMessages.find((m) => m.content.includes("purged 2 messages"));
			expect(purgeSummary).toBeDefined();
		});

		it("should handle multiple purge groups independently", async () => {
			const testThreadId = randomUUID();
			const testUserId = randomUUID();

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					testThreadId,
					testUserId,
					"web",
					"local",
					0,
					"Multiple Purge Test",
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

			// Insert messages
			const msg1Id = randomUUID();
			const msg2Id = randomUUID();
			const msg3Id = randomUUID();
			const msg4Id = randomUUID();

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg1Id,
					testThreadId,
					"user",
					"Message 1",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg2Id,
					testThreadId,
					"assistant",
					"Message 2",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg3Id,
					testThreadId,
					"user",
					"Message 3",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msg4Id,
					testThreadId,
					"assistant",
					"Message 4",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			// Create two separate purge messages
			const purge1Id = randomUUID();
			const purge1Content = JSON.stringify({
				target_ids: [msg1Id],
				summary: "First purge group",
			});

			const purge2Id = randomUUID();
			const purge2Content = JSON.stringify({
				target_ids: [msg3Id],
				summary: "Second purge group",
			});

			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					purge1Id,
					testThreadId,
					"purge",
					purge1Content,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					purge2Id,
					testThreadId,
					"purge",
					purge2Content,
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			const messages = assembleContext({
				db,
				threadId: testThreadId,
				userId: testUserId,
			});

			// Should have two purge summary messages
			const systemMessages = messages.filter((m) => m.role === "system");
			const purgeSummaries = systemMessages.filter((m) => m.content.includes("purged"));
			expect(purgeSummaries.length).toBe(2);

			// Should have the two non-purged messages
			const assistantMessages = messages.filter((m) => m.role === "assistant");
			expect(assistantMessages.length).toBe(2);
			expect(assistantMessages[0].content).toBe("Message 2");
			expect(assistantMessages[1].content).toBe("Message 4");
		});

		it("should handle purge messages with invalid JSON gracefully", async () => {
			const testThreadId = randomUUID();
			const testUserId = randomUUID();

			db.run(
				"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					testThreadId,
					testUserId,
					"web",
					"local",
					0,
					"Invalid Purge Test",
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

			const msgId = randomUUID();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					msgId,
					testThreadId,
					"user",
					"Keep this",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			// Create a purge message with invalid JSON
			const purgeId = randomUUID();
			db.run(
				"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					purgeId,
					testThreadId,
					"purge",
					"not valid json",
					null,
					null,
					new Date().toISOString(),
					new Date().toISOString(),
					"local",
				],
			);

			// Should not throw and should keep the user message
			const messages = assembleContext({
				db,
				threadId: testThreadId,
				userId: testUserId,
			});

			const userMessages = messages.filter((m) => m.role === "user");
			expect(userMessages.length).toBe(1);
			expect(userMessages[0].content).toBe("Keep this");
		});
	});
});
