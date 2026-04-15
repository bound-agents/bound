/**
 * Test that notification messages can be inserted into the messages table
 * via insertRow — reproduces the exact path from server.ts handleThread.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySchema,
	claimPending,
	createDatabase,
	enqueueNotification,
	insertRow,
} from "@bound/core";
import { formatNotification } from "../commands/start/server";

describe("Notification message insertion", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	const hostName = "test-host";

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `notif-insert-${randomBytes(4).toString("hex")}-`));
		const dbPath = join(tmpDir, "test.db");
		db = createDatabase(dbPath);
		applySchema(db);
	});

	beforeEach(() => {
		siteId = randomUUID();
		db.run("DELETE FROM dispatch_queue");
		db.run("DELETE FROM messages");
		db.run("DELETE FROM threads");
		db.run("DELETE FROM users");
		db.run("DELETE FROM change_log");
	});

	afterAll(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function createThread(): string {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, NULL, ?, ?, 0)",
			[userId, "TestUser", now, now],
		);
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'discord', ?, 0, 'test', NULL, ?, ?, ?, 0)",
			[threadId, userId, hostName, now, now, now],
		);
		return threadId;
	}

	it("inserts a proactive notification as a user message via insertRow", () => {
		const threadId = createThread();

		// Step 1: Enqueue notification (exactly as notify command does)
		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "source-thread-123",
			content: "goose deep read completed",
		});

		// Step 2: Claim pending (exactly as handleThread does)
		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(1);

		const entry = claimed[0];
		expect(entry.event_type).toBe("notification");

		// Step 3: Insert notification as message (exactly as server.ts does)
		const payload = JSON.parse(entry.event_payload as string);
		const notifText = formatNotification(payload);
		const now = new Date().toISOString();

		// This is the exact call that fails silently in production
		insertRow(
			db,
			"messages",
			{
				id: entry.message_id,
				thread_id: threadId,
				role: "system",
				content: notifText,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
				deleted: 0,
			},
			siteId,
		);

		// Step 4: Verify the message is in the table
		const msg = db.query("SELECT * FROM messages WHERE id = ?").get(entry.message_id) as {
			id: string;
			content: string;
			role: string;
		} | null;

		expect(msg).not.toBeNull();
		expect(msg?.content).toContain("goose deep read completed");
		expect(msg?.role).toBe("system");
	});

	it("survives retry — notification message uses fresh UUID, not dispatch entry ID", () => {
		const threadId = createThread();

		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "src",
			content: "test retry",
		});

		// First claim + insert
		const claimed1 = claimPending(db, threadId, siteId);
		const entry = claimed1[0];
		const payload = JSON.parse(entry.event_payload as string);
		const notifText = formatNotification(payload);
		const now = new Date().toISOString();

		// Use fresh UUID instead of entry.message_id
		const msgId1 = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: msgId1,
				thread_id: threadId,
				role: "system",
				content: notifText,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
				deleted: 0,
			},
			siteId,
		);

		// Simulate yield: reset processing back to pending
		db.run("UPDATE dispatch_queue SET status = 'pending', claimed_by = NULL WHERE message_id = ?", [
			entry.message_id,
		]);

		// Second claim — same entry comes back
		const claimed2 = claimPending(db, threadId, siteId);
		expect(claimed2).toHaveLength(1);

		// Second insert with a different fresh UUID — should succeed
		const msgId2 = randomUUID();
		insertRow(
			db,
			"messages",
			{
				id: msgId2,
				thread_id: threadId,
				role: "system",
				content: notifText,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
				deleted: 0,
			},
			siteId,
		);

		// Both messages exist
		const msgs = db.query("SELECT id FROM messages WHERE thread_id = ?").all(threadId) as Array<{
			id: string;
		}>;
		expect(msgs).toHaveLength(2);
	});

	it("inserts a task_complete notification as a user message", () => {
		const threadId = createThread();

		enqueueNotification(db, threadId, {
			type: "task_complete",
			task_id: "t1",
			task_name: "daily-summary",
			result: "3 items processed",
		});

		const claimed = claimPending(db, threadId, siteId);
		const entry = claimed[0];
		const payload = JSON.parse(entry.event_payload as string);
		const notifText = formatNotification(payload);
		const now = new Date().toISOString();

		insertRow(
			db,
			"messages",
			{
				id: entry.message_id,
				thread_id: threadId,
				role: "system",
				content: notifText,
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: hostName,
				deleted: 0,
			},
			siteId,
		);

		const msg = db.query("SELECT content FROM messages WHERE id = ?").get(entry.message_id) as {
			content: string;
		} | null;

		expect(msg).not.toBeNull();
		expect(msg?.content).toContain("daily-summary");
	});
});
