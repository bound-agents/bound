/**
 * The round-trip test that should have existed from day one: prove that
 * a notification enqueued via enqueueNotification() is actually visible
 * to the LLM after the full pipeline runs.
 *
 * Historically, resolveDelegationMessageId() persisted notifications with
 * role: "system", which context-assembly.ts Stage 2.5 silently filtered
 * out of the LLM input — the message row landed in the DB but the agent
 * never saw it. A single live-traffic symptom: thread
 * a83b945f-d4b1-4b77-904f-bb9b465edc1d received heartbeat anomaly
 * notifications at 07:32, 09:03, 11:32, 14:01, 19:03 UTC 2026-04-26 and
 * produced zero assistant turns in response because the notification
 * never reached the model.
 *
 * This test wires the real producers and consumers together and asserts
 * the notification text survives to assembleContext()'s `messages`
 * output. It is the regression guard for Invariant #19.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleContext } from "@bound/agent";
import { applySchema, claimPending, createDatabase, enqueueNotification } from "@bound/core";
import { resolveDelegationMessageId } from "../commands/start/server";

describe("Notification → LLM round-trip (Invariant #19)", () => {
	let tmpDir: string;
	let db: Database;
	let siteId: string;
	const hostName = "test-host";

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), `notif-llm-${randomBytes(4).toString("hex")}-`));
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

	function createThread(): { userId: string; threadId: string } {
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
		return { userId, threadId };
	}

	it("proactive notification reaches the LLM input messages after full pipeline", () => {
		const { userId, threadId } = createThread();

		// Full producer-side pipeline, mirroring handleThread in server.ts:
		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "heartbeat",
			content: "Heartbeat complete. Clean cycle — 29 stale facts purged.",
		});

		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(1);

		const { delegationMessageId, insertedMessageIds } = resolveDelegationMessageId({
			db,
			siteId,
			hostName,
			threadId,
			claimed,
		});

		expect(insertedMessageIds).toHaveLength(1);
		expect(delegationMessageId).toBe(insertedMessageIds[0]);

		// Full consumer-side pipeline: assembleContext is the real entry point
		// agent-loop hands to the LLM driver. What survives to `messages` is
		// exactly what the model will see.
		const { messages } = assembleContext({ db, threadId, userId });

		// The invariant under test: the notification content appears in the
		// LLM input. Before this fix, the row existed in `messages` table
		// with role="system" but Stage 2.5 dropped it before the LLM got it.
		const contents = messages
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n---\n");
		expect(contents).toContain("Heartbeat complete. Clean cycle");
	});

	it("task_complete notification reaches the LLM input messages", () => {
		const { userId, threadId } = createThread();

		enqueueNotification(db, threadId, {
			type: "task_complete",
			task_id: "t1",
			task_name: "daily-summary",
			result: "3 items processed",
		});

		const claimed = claimPending(db, threadId, siteId);
		resolveDelegationMessageId({ db, siteId, hostName, threadId, claimed });

		const { messages } = assembleContext({ db, threadId, userId });
		const contents = messages
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n---\n");
		expect(contents).toContain("daily-summary");
	});

	it("multiple notifications in a single claim all reach the LLM", () => {
		const { userId, threadId } = createThread();

		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "source-a",
			content: "First notification content.",
		});
		enqueueNotification(db, threadId, {
			type: "proactive",
			source_thread: "source-b",
			content: "Second notification content.",
		});

		const claimed = claimPending(db, threadId, siteId);
		expect(claimed).toHaveLength(2);

		resolveDelegationMessageId({ db, siteId, hostName, threadId, claimed });

		const { messages } = assembleContext({ db, threadId, userId });
		const contents = messages
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
			.join("\n---\n");
		expect(contents).toContain("First notification content.");
		expect(contents).toContain("Second notification content.");
	});
});
