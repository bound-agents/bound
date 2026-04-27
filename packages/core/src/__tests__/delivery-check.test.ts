/**
 * Post-loop verifyDelivery hook: when a platform connector returns
 * "missing", the hook enqueues a retry-nudge notification AND writes the
 * platform's tombstone key into messages.metadata on the inserted
 * nudge message. verifyDelivery uses that tombstone on the next turn to
 * decide silence-is-intentional vs first-shot-missing.
 *
 * This test exercises the helper in isolation. P2.1 tested the connector;
 * here we test the glue that wires a "missing" verdict into the system.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { insertRow, readMessageMetadata } from "../change-log";
import { createDatabase } from "../database";
import { runPostLoopDeliveryCheck } from "../delivery-check";
import { applySchema } from "../schema";

describe("runPostLoopDeliveryCheck", () => {
	let db: Database;
	let dbPath: string;
	const siteId = "hook-site";

	beforeEach(() => {
		dbPath = `/tmp/test-delivery-hook-${randomBytes(4).toString("hex")}.db`;
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {}
		try {
			unlinkSync(dbPath);
		} catch {}
	});

	function seedThread(): string {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{ id: userId, display_name: "h", first_seen_at: now, modified_at: now, deleted: 0 },
			siteId,
		);
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: userId,
				interface: "discord",
				host_origin: "test",
				color: 0,
				title: "t",
				summary: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		return threadId;
	}

	it("inserts a developer nudge message with tombstone metadata when verdict is missing", async () => {
		const threadId = seedThread();
		const nudgeText = "[Delivery retry] plain text did not reach the user on Discord.";
		const fakeConnector = {
			verifyDelivery: async () => ({ kind: "missing" as const, nudge: nudgeText }),
		};

		await runPostLoopDeliveryCheck({
			db,
			siteId,
			hostName: "host",
			threadId,
			turnStartAt: new Date(Date.now() - 10_000).toISOString(),
			connector: fakeConnector,
			platform: "discord",
		});

		// Atomic result of the hook: a developer-role message row with the
		// nudge content AND the tombstone key in its metadata, plus a
		// dispatch_queue entry pointing at the same id so the next loop
		// iteration picks up the nudge as a trigger.
		const msgs = db
			.query("SELECT id, role, content FROM messages WHERE thread_id = ?")
			.all(threadId) as Array<{ id: string; role: string; content: string }>;
		expect(msgs).toHaveLength(1);
		expect(msgs[0].role).toBe("developer");
		expect(msgs[0].content).toContain("Delivery retry");

		const meta = readMessageMetadata(db, msgs[0].id);
		expect(meta).not.toBeNull();
		expect(meta).toHaveProperty("discord_platform_delivery_retry");

		const queue = db
			.query(
				"SELECT message_id, status FROM dispatch_queue WHERE thread_id = ? AND status = 'pending'",
			)
			.all(threadId) as Array<{ message_id: string; status: string }>;
		expect(queue).toHaveLength(1);
		// The dispatch entry references the same messages.id, so
		// ProcessPayload.message_id flows a real row through delegation
		// (Invariant #18).
		expect(queue[0].message_id).toBe(msgs[0].id);
	});

	it("does nothing when verdict is delivered", async () => {
		const threadId = seedThread();
		const fakeConnector = {
			verifyDelivery: async () => ({ kind: "delivered" as const }),
		};

		await runPostLoopDeliveryCheck({
			db,
			siteId,
			hostName: "host",
			threadId,
			turnStartAt: new Date(Date.now() - 10_000).toISOString(),
			connector: fakeConnector,
			platform: "discord",
		});

		const queue = db
			.query("SELECT * FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as unknown[];
		expect(queue).toHaveLength(0);

		const messages = db
			.query("SELECT * FROM messages WHERE thread_id = ?")
			.all(threadId) as unknown[];
		expect(messages).toHaveLength(0);
	});

	it("does nothing when verdict is intentional-silence", async () => {
		const threadId = seedThread();
		const fakeConnector = {
			verifyDelivery: async () => ({ kind: "intentional-silence" as const }),
		};

		await runPostLoopDeliveryCheck({
			db,
			siteId,
			hostName: "host",
			threadId,
			turnStartAt: new Date(Date.now() - 10_000).toISOString(),
			connector: fakeConnector,
			platform: "discord",
		});

		const queue = db
			.query("SELECT * FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as unknown[];
		expect(queue).toHaveLength(0);
	});

	it("is a no-op when the connector has no verifyDelivery method", async () => {
		const threadId = seedThread();
		// Connector without verifyDelivery — e.g. webhook stub or future
		// auto-send platform. The hook must tolerate its absence.
		const bareConnector = {};

		await runPostLoopDeliveryCheck({
			db,
			siteId,
			hostName: "host",
			threadId,
			turnStartAt: new Date(Date.now() - 10_000).toISOString(),
			connector: bareConnector,
			platform: "webhook",
		});

		const queue = db
			.query("SELECT * FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as unknown[];
		expect(queue).toHaveLength(0);
	});

	it("swallows verifyDelivery throws and logs but doesn't crash the caller", async () => {
		const threadId = seedThread();
		const fakeConnector = {
			verifyDelivery: async () => {
				throw new Error("DB unavailable");
			},
		};

		// Must not throw.
		await runPostLoopDeliveryCheck({
			db,
			siteId,
			hostName: "host",
			threadId,
			turnStartAt: new Date(Date.now() - 10_000).toISOString(),
			connector: fakeConnector,
			platform: "discord",
		});

		// And must not have enqueued anything.
		const queue = db
			.query("SELECT * FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as unknown[];
		expect(queue).toHaveLength(0);
	});
});
