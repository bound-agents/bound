import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import { redactMessage, redactThread } from "../redaction";

describe("Redaction", () => {
	let db: Database.Database;
	const siteId = "test-site";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("should redact a message", () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const messageId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now, now);

		// Create message
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(messageId, threadId, "user", "Secret content", now, "localhost");

		// Redact it
		const result = redactMessage(db, messageId, siteId);
		expect(result.ok).toBe(true);

		// Check that content was redacted
		const message = db.prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as {
			content: string;
		};
		expect(message.content).toBe("[redacted]");
	});

	it("should redact all messages in a thread", () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now, now);

		// Create multiple messages
		const message1Id = randomUUID();
		const message2Id = randomUUID();
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(message1Id, threadId, "user", "Content 1", now, "localhost");
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(message2Id, threadId, "assistant", "Content 2", now, "localhost");

		// Redact thread
		const result = redactThread(db, threadId, siteId);
		expect(result.ok).toBe(true);
		expect(result.value?.messagesRedacted).toBe(2);

		// Check that all messages are redacted
		const messages = db
			.prepare("SELECT content FROM messages WHERE thread_id = ?")
			.all(threadId) as Array<{ content: string }>;
		expect(messages.length).toBe(2);
		expect(messages[0].content).toBe("[redacted]");
		expect(messages[1].content).toBe("[redacted]");
	});

	it("should tombstone memories when redacting a thread", () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const memoryId = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create thread
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now, now);

		// Create message
		const messageId = randomUUID();
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin) VALUES (?, ?, ?, ?, ?, ?)",
		).run(messageId, threadId, "user", "Content", now, "localhost");

		// Create memory sourced from the thread
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(memoryId, "test_key", "test_value", threadId, now, now);

		// Redact thread
		const result = redactThread(db, threadId, siteId);
		expect(result.ok).toBe(true);
		expect(result.value?.memoriesAffected).toBe(1);

		// Check that memory is soft-deleted
		const memory = db.prepare("SELECT deleted FROM semantic_memory WHERE id = ?").get(memoryId) as {
			deleted: number;
		};
		expect(memory.deleted).toBe(1);
	});

	// Bug #7: redaction must write change_log entries so changes sync to other nodes
	it("redactMessage creates a change_log entry for the message", () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const messageId = randomUUID();
		const now = new Date().toISOString();

		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now, now);
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(messageId, threadId, "user", "Secret", now, now, "localhost");

		redactMessage(db, messageId, siteId);

		const entry = db
			.prepare("SELECT COUNT(*) as c FROM change_log WHERE table_name = 'messages' AND row_id = ?")
			.get(messageId) as { c: number };

		expect(entry.c).toBeGreaterThan(0);
	});

	it("redactThread creates change_log entries for all redacted messages and tombstoned memories", () => {
		const userId = randomUUID();
		const threadId = randomUUID();
		const msg1Id = randomUUID();
		const msg2Id = randomUUID();
		const memId = randomUUID();
		const now = new Date().toISOString();

		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId, userId, "web", "localhost", now, now, now);
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(msg1Id, threadId, "user", "Msg1", now, now, "localhost");
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(msg2Id, threadId, "assistant", "Msg2", now, now, "localhost");
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(memId, "k", "v", threadId, now, now);

		redactThread(db, threadId, siteId);

		// Each message must have a change_log entry
		const msgEntries = db
			.prepare(
				"SELECT COUNT(*) as c FROM change_log WHERE table_name = 'messages' AND row_id IN (?, ?)",
			)
			.get(msg1Id, msg2Id) as { c: number };
		expect(msgEntries.c).toBe(2);

		// The tombstoned memory must have a change_log entry
		const memEntry = db
			.prepare(
				"SELECT COUNT(*) as c FROM change_log WHERE table_name = 'semantic_memory' AND row_id = ?",
			)
			.get(memId) as { c: number };
		expect(memEntry.c).toBeGreaterThan(0);
	});

	it("should not tombstone memories from other threads", () => {
		const userId = randomUUID();
		const threadId1 = randomUUID();
		const threadId2 = randomUUID();
		const memoryId1 = randomUUID();
		const memoryId2 = randomUUID();
		const now = new Date().toISOString();

		// Create user
		db.prepare(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at) VALUES (?, ?, ?, ?)",
		).run(userId, "Test User", now, now);

		// Create threads
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId1, userId, "web", "localhost", now, now, now);
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(threadId2, userId, "web", "localhost", now, now, now);

		// Create memories
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(memoryId1, "key1", "value1", threadId1, now, now);
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
		).run(memoryId2, "key2", "value2", threadId2, now, now);

		// Redact thread 1
		redactThread(db, threadId1, siteId);

		// Check memory 1 is deleted
		const memory1 = db
			.prepare("SELECT deleted FROM semantic_memory WHERE id = ?")
			.get(memoryId1) as { deleted: number };
		expect(memory1.deleted).toBe(1);

		// Check memory 2 is NOT deleted
		const memory2 = db
			.prepare("SELECT deleted FROM semantic_memory WHERE id = ?")
			.get(memoryId2) as { deleted: number };
		expect(memory2.deleted).toBe(0);
	});
});
