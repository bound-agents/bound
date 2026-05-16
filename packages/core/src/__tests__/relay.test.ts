import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayInboxEntry, RelayOutboxEntry } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import { createDatabase } from "../database";
import {
	PayloadTooLargeError,
	insertInbox,
	markDelivered,
	markProcessed,
	pruneRelayTables,
	readInboxByRefId,
	readInboxByStreamId,
	readUndelivered,
	readUnprocessed,
	setRelayOutboxEventBus,
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
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("writeOutbox inserts a valid entry and readUndelivered returns it", () => {
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
		});

		it("readUndelivered with targetSiteId filter returns only matching entries", () => {
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
		});

		it("markDelivered marks entries as delivered, readUndelivered no longer returns them", () => {
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
		});

		it("markDelivered with empty array does nothing", () => {
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
		});
	});

	describe("Inbox Operations", () => {
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("insertInbox inserts a valid entry and readUnprocessed returns it", () => {
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
		});

		it("insertInbox with duplicate ID returns false (INSERT OR IGNORE dedup)", () => {
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
		});

		it("markProcessed marks entries as processed, readUnprocessed no longer returns them", () => {
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
		});

		it("markProcessed with empty array does nothing", () => {
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
		});

		it("readInboxByRefId returns matching unprocessed entry", () => {
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
		});

		it("readInboxByRefId returns null when no match found", () => {
			const found = readInboxByRefId(db, "non-existent");

			expect(found).toBeNull();
		});

		it("readInboxByRefId returns entries regardless of processed state", () => {
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
			expect(found).not.toBeNull();
			expect(found?.id).toBe("msg-1");
		});

		it("readInboxByStreamId returns empty array when no matching stream_id", () => {
			const results = readInboxByStreamId(db, "non-existent-stream");
			expect(results).toHaveLength(0);
		});

		it("readInboxByStreamId returns entries ordered by received_at", () => {
			const now = new Date().toISOString();
			const later = new Date(Date.now() + 1000).toISOString();

			const entry1: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "stream_chunk",
				ref_id: null,
				idempotency_key: null,
				stream_id: "stream-123",
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: later,
				processed: 0,
			};

			const entry2: RelayInboxEntry = {
				id: "msg-2",
				source_site_id: "site-1",
				kind: "stream_chunk",
				ref_id: null,
				idempotency_key: null,
				stream_id: "stream-123",
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry1);
			insertInbox(db, entry2);

			const results = readInboxByStreamId(db, "stream-123");
			expect(results).toHaveLength(2);
			expect(results[0].id).toBe("msg-2");
			expect(results[1].id).toBe("msg-1");
		});

		it("readInboxByStreamId excludes processed entries", () => {
			const now = new Date().toISOString();
			const entry1: RelayInboxEntry = {
				id: "msg-1",
				source_site_id: "site-1",
				kind: "stream_chunk",
				ref_id: null,
				idempotency_key: null,
				stream_id: "stream-456",
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			const entry2: RelayInboxEntry = {
				id: "msg-2",
				source_site_id: "site-1",
				kind: "stream_chunk",
				ref_id: null,
				idempotency_key: null,
				stream_id: "stream-456",
				payload: "{}",
				expires_at: new Date(Date.now() + 60000).toISOString(),
				received_at: now,
				processed: 0,
			};

			insertInbox(db, entry1);
			insertInbox(db, entry2);
			markProcessed(db, ["msg-1"]);

			const results = readInboxByStreamId(db, "stream-456");
			expect(results).toHaveLength(1);
			expect(results[0].id).toBe("msg-2");
		});
	});

	describe("Outbox Idempotency (duplicate prevention)", () => {
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("writeOutbox silently ignores duplicate idempotency_key + target_site_id", () => {
			const now = new Date().toISOString();
			const expiry = new Date(Date.now() + 60000).toISOString();

			writeOutbox(db, {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			// Second write with same idempotency_key + target should be silently ignored
			writeOutbox(db, {
				id: "msg-2",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			const all = readUndelivered(db);
			expect(all).toHaveLength(1);
			expect(all[0].id).toBe("msg-1");
		});

		it("writeOutbox allows same idempotency_key with different target_site_id", () => {
			const now = new Date().toISOString();
			const expiry = new Date(Date.now() + 60000).toISOString();

			writeOutbox(db, {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			writeOutbox(db, {
				id: "msg-2",
				source_site_id: "site-1",
				target_site_id: "site-3",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			const all = readUndelivered(db);
			expect(all).toHaveLength(2);
		});

		it("writeOutbox allows same key after first entry is delivered", () => {
			const now = new Date().toISOString();
			const expiry = new Date(Date.now() + 60000).toISOString();

			writeOutbox(db, {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			// Mark first as delivered
			markDelivered(db, ["msg-1"]);

			// Second write with same key should succeed (first is delivered)
			writeOutbox(db, {
				id: "msg-2",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "intake",
				ref_id: null,
				idempotency_key: "intake:discord:12345",
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			const undelivered = readUndelivered(db);
			expect(undelivered).toHaveLength(1);
			expect(undelivered[0].id).toBe("msg-2");
		});

		it("writeOutbox allows entries with null idempotency_key (no dedup)", () => {
			const now = new Date().toISOString();
			const expiry = new Date(Date.now() + 60000).toISOString();

			writeOutbox(db, {
				id: "msg-1",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "status_forward",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			writeOutbox(db, {
				id: "msg-2",
				source_site_id: "site-1",
				target_site_id: "site-2",
				kind: "status_forward",
				ref_id: null,
				idempotency_key: null,
				payload: "{}",
				created_at: now,
				expires_at: expiry,
			});

			const all = readUndelivered(db);
			expect(all).toHaveLength(2);
		});
	});

	describe("Outbox event emission (relay:outbox-written)", () => {
		// Regression suite for the spin-loop bug where writeOutbox emitted
		// `relay:outbox-written` even on no-op INSERT-OR-IGNORE, causing
		// synchronous infinite recursion through WsTransport.handleRelaySend
		// (~5000 frames per burst until V8 RangeError, observed in production
		// as 286k log lines / 99% of total log volume in 26 minutes with the
		// hub crash-restarting 35 times).
		let db: ReturnType<typeof createDatabase>;
		let bus: TypedEventEmitter;
		let emitted: Array<{ id: string; target_site_id: string }>;
		let listener: (event: { id: string; target_site_id: string }) => void;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
			db = createDatabase(dbPath);
			applySchema(db);
			bus = new TypedEventEmitter();
			emitted = [];
			listener = (event) => emitted.push(event);
			bus.on("relay:outbox-written", listener);
		});

		afterEach(() => {
			bus.off("relay:outbox-written", listener);
			db.close();
		});

		const baseEntry = (
			overrides: Partial<RelayOutboxEntry> = {},
		): Omit<RelayOutboxEntry, "delivered"> => ({
			id: "msg-1",
			source_site_id: "hub-site",
			target_site_id: "spoke-site",
			kind: "error",
			ref_id: "req-1",
			idempotency_key: null,
			stream_id: null,
			payload: "{}",
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 60_000).toISOString(),
			...overrides,
		});

		it("emits relay:outbox-written when a new row is inserted", () => {
			writeOutbox(db, baseEntry(), undefined, bus);
			expect(emitted).toHaveLength(1);
			expect(emitted[0]).toEqual({ id: "msg-1", target_site_id: "spoke-site" });
		});

		it("does NOT emit relay:outbox-written on duplicate primary-key INSERT-OR-IGNORE", () => {
			// First write: row inserted, event fires.
			writeOutbox(db, baseEntry(), undefined, bus);
			// Second write with same id: PK conflict, INSERT OR IGNORE is a no-op.
			// This is exactly the scenario that occurs in
			// WsTransport.handleRelaySend's offline-async-buffer branch when
			// re-buffering a hub-self-originated entry that's already in
			// relay_outbox. Emitting on this no-op INSERT is what produced the
			// recursion: emit → listener → handleRelaySend → writeOutbox(same id) → emit ...
			writeOutbox(db, baseEntry(), undefined, bus);
			expect(emitted).toHaveLength(1);
		});

		it("does NOT emit relay:outbox-written on duplicate idempotency_key + target_site_id", () => {
			writeOutbox(
				db,
				baseEntry({ id: "msg-A", idempotency_key: "intake:discord:12345" }),
				undefined,
				bus,
			);
			writeOutbox(
				db,
				baseEntry({ id: "msg-B", idempotency_key: "intake:discord:12345" }),
				undefined,
				bus,
			);
			expect(emitted).toHaveLength(1);
			expect(emitted[0].id).toBe("msg-A");
		});

		it("emits separately for the same idempotency_key targeting different sites", () => {
			writeOutbox(
				db,
				baseEntry({
					id: "msg-A",
					target_site_id: "spoke-1",
					idempotency_key: "intake:discord:12345",
				}),
				undefined,
				bus,
			);
			writeOutbox(
				db,
				baseEntry({
					id: "msg-B",
					target_site_id: "spoke-2",
					idempotency_key: "intake:discord:12345",
				}),
				undefined,
				bus,
			);
			expect(emitted).toHaveLength(2);
		});

		it("breaks a re-entrant listener that calls writeOutbox with the same id (the hub spin-loop reproducer)", () => {
			// Reproduces the production loop: a listener that re-buffers the
			// entry through writeOutbox with the same id. With the fix, the
			// second writeOutbox is a no-op INSERT and emits nothing, so the
			// listener fires exactly once. Without the fix this would recurse
			// until V8 throws RangeError around depth ~5000.
			let depth = 0;
			const reEntrantListener = (event: { id: string; target_site_id: string }) => {
				depth++;
				// Re-buffer with the same id (mirrors handleRelaySend's
				// offline-async path). Use a defensive cap so a regression
				// doesn't blow this test's stack: if the fix regresses, the
				// throw aborts the run with a clear message instead.
				if (depth > 100) throw new Error("re-entrant emit was not gated");
				writeOutbox(db, baseEntry({ id: event.id }), undefined, bus);
			};
			bus.off("relay:outbox-written", listener);
			bus.on("relay:outbox-written", reEntrantListener);

			writeOutbox(db, baseEntry(), undefined, bus);
			expect(depth).toBe(1);

			bus.off("relay:outbox-written", reEntrantListener);
		});

		it("uses the module-level event bus when no explicit eventBus is passed", () => {
			const moduleEmitted: Array<{ id: string; target_site_id: string }> = [];
			const moduleListener = (e: { id: string; target_site_id: string }) => moduleEmitted.push(e);
			bus.on("relay:outbox-written", moduleListener);
			setRelayOutboxEventBus(bus);
			try {
				writeOutbox(db, baseEntry({ id: "msg-module" }));
				expect(moduleEmitted).toHaveLength(1);
				expect(moduleEmitted[0].id).toBe("msg-module");
				// Duplicate insert via module-level bus also no-ops.
				writeOutbox(db, baseEntry({ id: "msg-module" }));
				expect(moduleEmitted).toHaveLength(1);
			} finally {
				bus.off("relay:outbox-written", moduleListener);
				setRelayOutboxEventBus(null as unknown as TypedEventEmitter);
			}
		});
	});

	describe("Payload Size Enforcement (AC9.1)", () => {
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("writeOutbox throws PayloadTooLargeError when payload exceeds 2MB", () => {
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
		});

		it("writeOutbox succeeds with payload under 2MB", () => {
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
		});

		it("insertInbox throws PayloadTooLargeError when payload exceeds 2MB", () => {
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
		});

		it("insertInbox succeeds with payload under 2MB", () => {
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
		});
	});

	describe("Pruning (AC9.3)", () => {
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("pruneRelayTables deletes delivered outbox entries older than retention period", () => {
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
		});

		it("pruneRelayTables deletes processed inbox entries older than retention period", () => {
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
		});

		it("pruneRelayTables does not prune non-delivered outbox entries", () => {
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
		});

		it("pruneRelayTables does not prune non-processed inbox entries", () => {
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
		});

		it("pruneRelayTables does not prune recently delivered/processed entries", () => {
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
		});
	});

	describe("Custom Max Payload Bytes", () => {
		let db: ReturnType<typeof createDatabase>;

		beforeEach(() => {
			dbPath = join(tmpdir(), `bound-relay-test-${randomBytes(4).toString("hex")}.db`);
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
				unlinkSync(dbPath);
			} catch {
				// ignore
			}
		});

		it("writeOutbox respects custom maxPayloadBytes limit", () => {
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
		});

		it("insertInbox respects custom maxPayloadBytes limit", () => {
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
		});
	});
});
