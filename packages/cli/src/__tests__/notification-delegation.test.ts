/**
 * Regression test for "thread notifications ignored when delegation fires"
 * bug. When a notification is claimed from dispatch_queue and the thread
 * delegates to a remote host, the ProcessPayload.message_id must point to a
 * real row in `messages`. Previously, handleThread() used the dispatch_queue
 * entry ID (claimedIds[0]) which for notifications is a synthetic UUID with
 * no matching messages row. The remote host's executeProcess() then hit
 * `Message not found` and silently wrote an error response.
 *
 * Repro in the field: thread a83b945f-d4b1-4b77-904f-bb9b465edc1d had three
 * heartbeat notifications inserted (07:32, 09:03, 11:32 UTC 2026-04-26) that
 * were visible in the messages table but never triggered any turn — the
 * delegating host wrote the dispatch entry ID into ProcessPayload.message_id
 * and the receiving host's lookup returned null.
 *
 * The fix: inject the notification messages FIRST, capture the inserted
 * message IDs, and pass the last inserted ID (or the user message id when
 * the claimed entry was a user message) to delegation.
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
	enqueueMessage,
	enqueueNotification,
} from "@bound/core";
import { resolveDelegationMessageId } from "../commands/start/server";

describe("Notification delegation message_id invariant", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	const hostName = "test-host";

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `notif-deleg-${randomBytes(4).toString("hex")}-`));
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

	it("resolveDelegationMessageId returns a real messages.id when claimed entry is a notification", () => {
		const threadId = createThread();

		// Simulate the heartbeat task calling notify on this thread.
		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "heartbeat",
			content: "Heartbeat complete (09:03 UTC). Clean cycle.",
		});

		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(1);

		// Simulate the handleThread flow: inject the notification(s) as
		// messages and resolve the ID that should be forwarded to the remote
		// host via ProcessPayload.message_id.
		const { delegationMessageId, insertedMessageIds } = resolveDelegationMessageId({
			db,
			siteId,
			hostName,
			threadId,
			claimed,
		});

		expect(insertedMessageIds).toHaveLength(1);
		expect(delegationMessageId).toBe(insertedMessageIds[0]);

		// The invariant under test: the ID used for delegation MUST exist
		// in the messages table. Before the fix, the code passed the
		// dispatch_queue entry ID (claimed[0].message_id) which has no
		// matching messages row, causing executeProcess to bail with
		// "Message not found".
		const row = db
			.query("SELECT id, role, content FROM messages WHERE id = ?")
			.get(delegationMessageId) as { id: string; role: string; content: string } | null;
		expect(row).not.toBeNull();
		// Invariant #19: notifications are persisted with role='developer',
		// not 'system' — 'system' is reserved for the LLM driver layer and
		// rejected by insertRow for the messages table.
		expect(row?.role).toBe("developer");
		expect(row?.content).toContain("Heartbeat complete");
	});

	it("resolveDelegationMessageId returns the user message id when claimed entry is a user message", () => {
		const threadId = createThread();
		const realMsgId = randomUUID();
		const now = new Date().toISOString();
		// The user message already lives in messages; enqueueMessage uses that id.
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, 'user', 'hi', NULL, NULL, ?, ?, ?, 0)",
			[realMsgId, threadId, now, now, hostName],
		);
		enqueueMessage(db, realMsgId, threadId);

		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(1);
		expect(claimed[0].event_type).not.toBe("notification");

		const { delegationMessageId, insertedMessageIds } = resolveDelegationMessageId({
			db,
			siteId,
			hostName,
			threadId,
			claimed,
		});

		// No messages injected for a user-message dispatch entry.
		expect(insertedMessageIds).toHaveLength(0);
		// And the ID forwarded to delegation is the real user-message ID.
		expect(delegationMessageId).toBe(realMsgId);
	});

	it("resolveDelegationMessageId handles mixed batch (notification + user message)", () => {
		const threadId = createThread();

		// Enqueue notification first, then user message — both get claimed together.
		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: null,
			content: "notif content",
		});
		const userMsgId = randomUUID();
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted) VALUES (?, ?, 'user', 'hello', NULL, NULL, ?, ?, ?, 0)",
			[userMsgId, threadId, now, now, hostName],
		);
		enqueueMessage(db, userMsgId, threadId);

		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(2);

		const { delegationMessageId, insertedMessageIds } = resolveDelegationMessageId({
			db,
			siteId,
			hostName,
			threadId,
			claimed,
		});

		expect(insertedMessageIds).toHaveLength(1);
		// Delegation should forward the user message ID — the actual turn trigger
		// — rather than the injected notification.
		expect(delegationMessageId).toBe(userMsgId);
	});
});
