/**
 * messages.metadata — opaque JSON property bag scoped to platform
 * connectors. Most of the application treats this field as "does not
 * exist." Platform-specific logic (e.g. Discord delivery-retry tombstones)
 * reads and writes it to thread platform-specific state through messages
 * without polluting a general concept.
 *
 * Convention: platform writers prefix keys with their platform name
 * (`discord_*`, `slack_*`) to avoid collisions. Enforced by documentation,
 * not by code — the field is intentionally a loose Record<string, unknown>.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertRow, readMessageMetadata, writeMessageMetadata } from "../change-log";
import { createDatabase } from "../database";
import { applySchema } from "../schema";

describe("messages.metadata property bag", () => {
	let dbPath: string;
	let db: ReturnType<typeof createDatabase>;
	const siteId = "site-meta-test";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-meta-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// ignore
		}
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	function seedThread(): { userId: string; threadId: string } {
		const userId = randomUUID();
		const threadId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"users",
			{ id: userId, display_name: "m", first_seen_at: now, modified_at: now, deleted: 0 },
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
		return { userId, threadId };
	}

	function insertMessage(
		threadId: string,
		metadata: Record<string, unknown> | null = null,
	): string {
		const messageId = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"messages",
			{
				id: messageId,
				thread_id: threadId,
				role: "developer",
				content: "test",
				model_id: null,
				tool_name: null,
				created_at: now,
				modified_at: now,
				host_origin: "test",
				deleted: 0,
				metadata: metadata === null ? null : JSON.stringify(metadata),
			},
			siteId,
		);
		return messageId;
	}

	it("schema exposes messages.metadata column", () => {
		const cols = db
			.query<{ name: string; type: string }, []>(
				"SELECT name, type FROM pragma_table_info('messages')",
			)
			.all();
		const meta = cols.find((c) => c.name === "metadata");
		expect(meta).toBeDefined();
		expect(meta?.type.toUpperCase()).toBe("TEXT");
	});

	it("insertRow accepts a metadata field and round-trips through the DB", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, {
			discord_platform_delivery_retry: "tombstone-uuid",
		});

		const row = db.query("SELECT metadata FROM messages WHERE id = ?").get(messageId) as {
			metadata: string | null;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.metadata).toBe(
			JSON.stringify({ discord_platform_delivery_retry: "tombstone-uuid" }),
		);
	});

	it("insertRow permits metadata to be null or omitted", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, null);

		const row = db.query("SELECT metadata FROM messages WHERE id = ?").get(messageId) as {
			metadata: string | null;
		} | null;
		expect(row?.metadata).toBeNull();
	});

	it("readMessageMetadata returns the parsed object", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, { foo: "bar", n: 42 });

		const meta = readMessageMetadata(db, messageId);
		expect(meta).toEqual({ foo: "bar", n: 42 });
	});

	it("readMessageMetadata returns null when metadata is absent", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, null);

		const meta = readMessageMetadata(db, messageId);
		expect(meta).toBeNull();
	});

	it("readMessageMetadata returns null for a missing message id", () => {
		const meta = readMessageMetadata(db, randomUUID());
		expect(meta).toBeNull();
	});

	it("writeMessageMetadata overwrites existing keys and bumps modified_at", async () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, { discord_platform_delivery_retry: "uuid-old" });

		const before = db.query("SELECT modified_at FROM messages WHERE id = ?").get(messageId) as {
			modified_at: string;
		};

		// Sleep past ISO-second precision to guarantee modified_at changes.
		await new Promise((resolve) => setTimeout(resolve, 5));

		writeMessageMetadata(db, messageId, { discord_platform_delivery_retry: "uuid-new" }, siteId);

		const after = db
			.query("SELECT metadata, modified_at FROM messages WHERE id = ?")
			.get(messageId) as { metadata: string; modified_at: string };

		expect(JSON.parse(after.metadata)).toEqual({ discord_platform_delivery_retry: "uuid-new" });
		expect(after.modified_at >= before.modified_at).toBe(true);
	});

	it("writeMessageMetadata merges additively when called with existing keys", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, { alpha: 1 });

		// First write: a Discord-scoped key.
		writeMessageMetadata(db, messageId, { discord_platform_delivery_retry: "abc" }, siteId);
		// Second write: a Slack-scoped key from a future connector.
		writeMessageMetadata(db, messageId, { slack_audit: "xyz" }, siteId);

		const meta = readMessageMetadata(db, messageId);
		expect(meta).toEqual({
			alpha: 1,
			discord_platform_delivery_retry: "abc",
			slack_audit: "xyz",
		});
	});

	it("writeMessageMetadata produces a change_log entry for sync", () => {
		const { threadId } = seedThread();
		const messageId = insertMessage(threadId, null);
		const beforeEntries = db
			.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
			.get(messageId) as { c: number };

		writeMessageMetadata(db, messageId, { discord_platform_delivery_retry: "uuid-1" }, siteId);

		const afterEntries = db
			.query("SELECT COUNT(*) as c FROM change_log WHERE row_id = ?")
			.get(messageId) as { c: number };

		expect(afterEntries.c).toBe(beforeEntries.c + 1);
	});
});
