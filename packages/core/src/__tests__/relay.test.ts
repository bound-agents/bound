import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";
import { createDatabase } from "../database";
import {
	PayloadTooLargeError,
	insertInbox,
	markDelivered,
	markProcessed,
	pruneRelayTables,
	readInboxByRefId,
	readUndelivered,
	readUnprocessed,
	writeOutbox,
} from "../relay";
import { applySchema } from "../schema";

describe("Relay CRUD Helpers", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	describe("Outbox Operations", () => {
		it("writeOutbox inserts a valid entry and readUndelivered returns it", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: "ref-1",
				idempotency_key: "idem-1",
				payload: JSON.stringify({ tool: "test", args: {} }),
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			writeOutbox(db, entry);
			const undelivered = readUndelivered(db);

			expect(undelivered).toHaveLength(1);
			expect(undelivered[0].id).toBe("msg-1");
			expect(undelivered[0].delivered).toBe(0);

			db.close();
		});

		it("readUndelivered with targetSiteId filter returns only matching entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const expiry = new Date(Date.now() + 60000).toISOString();

			const entry1: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			};

			const entry2: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-2",
				source_site_id: "site-1",
				target_site_id: "site-3",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			};

			writeOutbox(db, entry1);
			writeOutbox(db, entry2);

			const undeliveredSite2 = readUndelivered(db, "site-2");
			const undeliveredSite3 = readUndelivered(db, "site-3");

			expect(undeliveredSite2).toHaveLength(1);
			expect(undeliveredSite2[0].target_site_id).toBe("site-2");

			expect(undeliveredSite3).toHaveLength(1);
			expect(undeliveredSite3[0].target_site_id).toBe("site-3");

			db.close();
		});

		it("markDelivered marks entries as delivered, readUndelivered no longer returns them", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			writeOutbox(db, entry);
			let undelivered = readUndelivered(db);
			expect(undelivered).toHaveLength(1);

			markDelivered(db, ["msg-1"]);
			undelivered = readUndelivered(db);
			expect(undelivered).toHaveLength(0);

			db.close();
		});

		it("markDelivered with empty array does nothing", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			writeOutbox(db, entry);
			markDelivered(db, []);
			const undelivered = readUndelivered(db);

			expect(undelivered).toHaveLength(1);

			db.close();
		});
	});

	describe("Inbox Operations", () => {
		it("insertInbox inserts a valid entry and readUnprocessed returns it", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: "ref-1",
				idempotency_key: "idem-1",
				payload: JSON.stringify({ stdout: "ok" }),
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			const inserted = insertInbox(db, entry);
			expect(inserted).toBe(true);

			const unprocessed = readUnprocessed(db);
			expect(unprocessed).toHaveLength(1);
			expect(unprocessed[0].id).toBe("msg-1");
			expect(unprocessed[0].processed).toBe(0);

			db.close();
		});

		it("insertInbox with duplicate ID returns false (INSERT OR IGNORE dedup)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			const inserted1 = insertInbox(db, entry);
			expect(inserted1).toBe(true);

			const inserted2 = insertInbox(db, entry);
			expect(inserted2).toBe(false);

			const unprocessed = readUnprocessed(db);
			expect(unprocessed).toHaveLength(1);

			db.close();
		});

		it("markProcessed marks entries as processed, readUnprocessed no longer returns them", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry);
			let unprocessed = readUnprocessed(db);
			expect(unprocessed).toHaveLength(1);

			markProcessed(db, ["msg-1"]);
			unprocessed = readUnprocessed(db);
			expect(unprocessed).toHaveLength(0);

			db.close();
		});

		it("markProcessed with empty array does nothing", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry);
			markProcessed(db, []);
			const unprocessed = readUnprocessed(db);

			expect(unprocessed).toHaveLength(1);

			db.close();
		});

		it("readInboxByRefId returns matching unprocessed entry", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: "ref-123",
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry);
			const found = readInboxByRefId(db, "ref-123");

			expect(found).not.toBeNull();
			expect(found?.id).toBe("msg-1");
			expect(found?.ref_id).toBe("ref-123");

			db.close();
		});

		it("readInboxByRefId returns null when no match found", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const found = readInboxByRefId(db, "non-existent");

			expect(found).toBeNull();

			db.close();
		});

		it("readInboxByRefId ignores processed entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: "ref-123",
				idempotency_key: null,
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry);
			markProcessed(db, ["msg-1"]);

			const found = readInboxByRefId(db, "ref-123");
			expect(found).toBeNull();

			db.close();
		});
	});

	describe("Payload Size Enforcement (AC9.1)", () => {
		it("writeOutbox throws PayloadTooLargeError when payload exceeds 2MB", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const largePayload = "x".repeat(2 * 1024 * 1024 + 1);

			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: largePayload,
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			expect(() => {
				writeOutbox(db, entry);
			}).toThrow(PayloadTooLargeError);

			db.close();
		});

		it("writeOutbox succeeds with payload under 2MB", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const validPayload = "x".repeat(1024 * 1024);

			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: validPayload,
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			writeOutbox(db, entry);
			const undelivered = readUndelivered(db);

			expect(undelivered).toHaveLength(1);

			db.close();
		});

		it("insertInbox throws PayloadTooLargeError when payload exceeds 2MB", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const largePayload = "x".repeat(2 * 1024 * 1024 + 1);

			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: largePayload,
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			expect(() => {
				insertInbox(db, entry);
			}).toThrow(PayloadTooLargeError);

			db.close();
		});

		it("insertInbox succeeds with payload under 2MB", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const validPayload = "x".repeat(1024 * 1024);

			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: validPayload,
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			const inserted = insertInbox(db, entry);
			expect(inserted).toBe(true);

			db.close();
		});
	});

	describe("Pruning (AC9.3)", () => {
		it("pruneRelayTables deletes delivered outbox entries older than retention period", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
			const recentTime = now.toISOString();

			const oldEntry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-old",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: oldTime,
				expires_at: oldTime,
			};

			const recentEntry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-recent",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: recentTime,
				expires_at: recentTime,
			};

			writeOutbox(db, oldEntry);
			writeOutbox(db, recentEntry);

			markDelivered(db, ["msg-old", "msg-recent"]);

			const result = pruneRelayTables(db, 300);

			expect(result.outboxPruned).toBe(1);

			const allRows = db
				.query("SELECT * FROM relay_outbox ORDER BY created_at ASC")
				.all() as RelayOutboxEntry[];
			expect(allRows).toHaveLength(1);
			expect(allRows[0].id).toBe("msg-recent");

			db.close();
		});

		it("pruneRelayTables deletes processed inbox entries older than retention period", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
			const recentTime = now.toISOString();

			const oldEntry: RelayInboxEntry = {
				id: "msg-old",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: oldTime,
				received_at: oldTime,
				processed: 0,
			};

			const recentEntry: RelayInboxEntry = {
				id: "msg-recent",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: recentTime,
				received_at: recentTime,
				processed: 0,
			};

			insertInbox(db, oldEntry);
			insertInbox(db, recentEntry);

			markProcessed(db, ["msg-old", "msg-recent"]);

			const result = pruneRelayTables(db, 300);

			expect(result.inboxPruned).toBe(1);

			const allRows = db
				.query("SELECT * FROM relay_inbox ORDER BY received_at ASC")
				.all() as RelayInboxEntry[];
			expect(allRows).toHaveLength(1);
			expect(allRows[0].id).toBe("msg-recent");

			db.close();
		});

		it("pruneRelayTables does not prune non-delivered outbox entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: oldTime,
				expires_at: oldTime,
			};

			writeOutbox(db, entry);

			const result = pruneRelayTables(db, 300);

			expect(result.outboxPruned).toBe(0);

			const remaining = readUndelivered(db);
			expect(remaining).toHaveLength(1);

			db.close();
		});

		it("pruneRelayTables does not prune non-processed inbox entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const oldTime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: oldTime,
				received_at: oldTime,
				processed: 0,
			};

			insertInbox(db, entry);

			const result = pruneRelayTables(db, 300);

			expect(result.inboxPruned).toBe(0);

			const remaining = readUnprocessed(db);
			expect(remaining).toHaveLength(1);

			db.close();
		});

		it("pruneRelayTables does not prune recently delivered/processed entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();

			const outboxEntry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-out",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: now,
			};

			const inboxEntry: RelayInboxEntry = {
				id: "msg-in",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				expires_at: now,
				received_at: now,
				processed: 0,
			};

			writeOutbox(db, outboxEntry);
			insertInbox(db, inboxEntry);

			markDelivered(db, ["msg-out"]);
			markProcessed(db, ["msg-in"]);

			const result = pruneRelayTables(db, 300);

			expect(result.outboxPruned).toBe(0);
			expect(result.inboxPruned).toBe(0);

			db.close();
		});
	});

	describe("Custom Max Payload Bytes", () => {
		it("writeOutbox respects custom maxPayloadBytes limit", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const payload = "x".repeat(1001);

			const entry: Omit<RelayOutboxEntry, "delivered"> = {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "tool_call",
				ref_id: null,
				idempotency_key: null,
				payload,
				created_at: now,
				expires_at: new Date(Date.now() + 60000).toISOString(),
			};

			expect(() => {
				writeOutbox(db, entry, 1000);
			}).toThrow(PayloadTooLargeError);

			db.close();
		});

		it("insertInbox respects custom maxPayloadBytes limit", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date().toISOString();
			const payload = "x".repeat(1001);

			const entry: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "result",
				ref_id: null,
				idempotency_key: null,
				payload,
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			expect(() => {
				insertInbox(db, entry, 1000);
			}).toThrow(PayloadTooLargeError);

			db.close();
		});
	});
});
