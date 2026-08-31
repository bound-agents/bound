// Producer-flip coverage for the connector (MCP) intake write. With
// BOUND_DURABLE_INTAKE ON (the 4C-3 default), a leader-local delivery writes
// a durable_work row (kind connector_intake) keyed
// connector_intake:<handleId>:<eventId> and NO relay_inbox twin, and a
// duplicate eventId folds to exactly one row.
//
// deliverBatch is @internal (test-only) and both push/poll modes route
// through it, so it is the direct producer seam. Leader-local mode is
// selected by leaving hubSiteId unset (or equal to siteId), which is the
// path that folds connector_intake rows through buildEventWakeupContent.

import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema, insertRow, setDurableIntakeEnabledForTesting } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { createConnectorHandle } from "../connector-handle.js";
import { PlatformMcpRegistry } from "../mcp-registry.js";

const mockLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

class SimpleEventBus {
	emit(_event: string, _payload: unknown): void {}
	on(): void {}
	off(): void {}
}

interface McpEvent {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	cursor: string;
}

interface ActiveSubscription {
	handleId: string;
	serverName: string;
	eventName: string;
	params: Record<string, unknown>;
	taskId: string;
	threadId: string;
	buffer: McpEvent[];
	flushTimer: ReturnType<typeof setTimeout> | null;
	deduplicationSet: Set<string>;
}

describe("connector intake producer flip (deliverBatch, leader-local)", () => {
	let db: Database.Database;
	let siteId: string;
	let registry: PlatformMcpRegistry;

	beforeEach(() => {
		setDurableIntakeEnabledForTesting(false);
		db = new Database(":memory:");
		applySchema(db);
		siteId = `test-site-${randomBytes(4).toString("hex")}`;
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			// Leader-local: no hub mismatch, so deliverBatch writes connector_intake.
			eventBus: new SimpleEventBus() as unknown as TypedEventEmitter,
			logger: mockLogger,
			pollIntervalSeconds: 0.001,
		});
	});

	afterEach(async () => {
		setDurableIntakeEnabledForTesting(true);
		await registry.shutdown();
		db.close();
	});

	function seedSubscription(): ActiveSubscription {
		const threadId = `thread-${randomBytes(4).toString("hex")}`;
		const taskId = `task-${randomBytes(4).toString("hex")}`;
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "test-user",
				interface: "mcp",
				host_origin: siteId,
				summary: null,
				last_message_at: now,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: `connector:event:${taskId}`,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		const handleId = createConnectorHandle(db, siteId, {
			serverName: "test-server",
			eventName: "test.event",
			eventArgs: {},
			deliveryMode: "poll",
			taskId,
		});
		return {
			handleId,
			serverName: "test-server",
			eventName: "test.event",
			params: {},
			taskId,
			threadId,
			buffer: [],
			flushTimer: null,
			deduplicationSet: new Set<string>(),
		};
	}

	function makeEvent(eventId: string, seq: number): McpEvent {
		return {
			eventId,
			name: "test.event",
			timestamp: new Date().toISOString(),
			data: { hello: eventId },
			cursor: `cursor-${seq}`,
		};
	}

	function durableRows() {
		return db
			.query(
				"SELECT idempotency_key, ref_id, source_site, kind, received_at, expires_at, claim_state, payload FROM durable_work ORDER BY received_at ASC",
			)
			.all() as Array<{
			idempotency_key: string;
			ref_id: string;
			source_site: string;
			kind: string;
			received_at: string;
			expires_at: string;
			claim_state: string;
			payload: string;
		}>;
	}

	describe("durable intake ON", () => {
		beforeEach(() => setDurableIntakeEnabledForTesting(true));
		afterEach(() => setDurableIntakeEnabledForTesting(true));

		it("writes one connector_intake row keyed connector_intake:<handleId>:<eventId> and no relay twin", () => {
			const sub = seedSubscription();
			const deliver = registry as unknown as {
				deliverBatch: (s: ActiveSubscription, events: McpEvent[]) => void;
			};

			deliver.deliverBatch(sub, [makeEvent("evt-1", 1)]);

			const rows = durableRows();
			expect(rows.length).toBe(1);
			expect(rows[0].kind).toBe("connector_intake");
			expect(rows[0].idempotency_key).toBe(`connector_intake:${sub.handleId}:evt-1`);
			expect(rows[0].ref_id).toBe(sub.threadId);
			expect(rows[0].source_site).toBe(siteId);
			expect(rows[0].received_at).toEqual(expect.any(String));
			expect(rows[0].claim_state).toBe("pending");
			expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].received_at)).toBeGreaterThan(
				6 * 24 * 60 * 60 * 1000,
			);
			expect(JSON.parse(rows[0].payload)).toEqual([{ hello: "evt-1" }]);
			// No legacy twin.
			expect(db.query("SELECT COUNT(*) AS count FROM relay_inbox").get()).toEqual({ count: 0 });
		});

		it("a duplicate eventId folds to exactly one row", () => {
			const sub = seedSubscription();
			const deliver = registry as unknown as {
				deliverBatch: (s: ActiveSubscription, events: McpEvent[]) => void;
			};

			// deduplicationSet drops the second same-eventId delivery before the
			// write; even if it slipped past, insertDurableWork's (kind, key) fence
			// would still keep it a single row. Assert the observable end state.
			deliver.deliverBatch(sub, [makeEvent("evt-dup", 1)]);
			deliver.deliverBatch(sub, [makeEvent("evt-dup", 2)]);

			const rows = durableRows();
			expect(rows.length).toBe(1);
			expect(rows[0].idempotency_key).toBe(`connector_intake:${sub.handleId}:evt-dup`);
			expect(db.query("SELECT COUNT(*) AS count FROM relay_inbox").get()).toEqual({ count: 0 });
		});
	});
});

describe("connector intake producer flip (deliverBatch, spoke leader)", () => {
	let db: Database.Database;
	let siteId: string;
	let registry: PlatformMcpRegistry;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		siteId = `spoke-${randomBytes(4).toString("hex")}`;
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
	});
	afterEach(async () => {
		await registry.shutdown();
		db.close();
	});

	function setup(insert: (key: string, payload: string) => boolean) {
		registry = new PlatformMcpRegistry({
			db,
			siteId,
			hubSiteId: "hub",
			eventBus: new SimpleEventBus() as unknown as TypedEventEmitter,
			logger: mockLogger,
			pollIntervalSeconds: 0.001,
			routeRelayRequest: (params) => ({ inserted: insert(params.idempotencyKey, params.payload) }),
		});
		const threadId = "spoke-thread";
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id: threadId,
				user_id: "u",
				interface: "mcp",
				host_origin: siteId,
				summary: null,
				last_message_at: now,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		const taskId = "spoke-task";
		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "event",
				status: "pending",
				trigger_spec: `connector:event:${taskId}`,
				thread_id: threadId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		const handleId = createConnectorHandle(db, siteId, {
			serverName: "discord",
			eventName: "x",
			eventArgs: {},
			deliveryMode: "poll",
			taskId,
		});
		return {
			threadId,
			taskId,
			handleId,
			deliver: registry as unknown as {
				deliverBatch: (s: ActiveSubscription, e: McpEvent[]) => void;
			},
		};
	}

	it("routes capable spoke intake durably and gates a replayed developer message on inserted", () => {
		const { threadId, taskId, handleId, deliver } = setup((key, payload) => {
			const result = db.run(
				"INSERT OR IGNORE INTO durable_work (id, target_site_id, kind, payload, idempotency_key, claim_state, attempt_count, created_at) VALUES (?, 'hub', 'intake', ?, ?, 'pending', 0, ?)",
				[randomBytes(8).toString("hex"), payload, key, new Date().toISOString()],
			);
			return result.changes === 1;
		});
		const sub: ActiveSubscription = {
			handleId,
			serverName: "discord",
			eventName: "x",
			params: {},
			taskId,
			threadId,
			buffer: [],
			flushTimer: null,
			deduplicationSet: new Set(),
		};
		const event = makeSpokeEvent("event-1");
		deliver.deliverBatch(sub, [event]);
		// Clear only the in-memory early dedupe: persistence's idempotency fence must
		// still gate the dependent message on a crash/replay.
		sub.deduplicationSet.clear();
		deliver.deliverBatch(sub, [event]);
		expect(db.query("SELECT idempotency_key FROM durable_work").all()).toEqual([
			{ idempotency_key: "intake:discord:event-1" },
		]);
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
		expect(db.query("SELECT COUNT(*) AS count FROM relay_outbox").get()).toEqual({ count: 0 });
	});

	it("preserves legacy outbox and message gating when the router selects legacy", () => {
		const { threadId, taskId, handleId, deliver } = setup((key, payload) => {
			const result = db.run(
				"INSERT OR IGNORE INTO relay_outbox (id, source_site_id, target_site_id, kind, ref_id, idempotency_key, stream_id, payload, created_at, expires_at, delivered) VALUES (?, ?, 'hub', 'intake', NULL, ?, NULL, ?, ?, ?, 0)",
				[
					randomBytes(8).toString("hex"),
					siteId,
					key,
					payload,
					new Date().toISOString(),
					new Date(Date.now() + 300000).toISOString(),
				],
			);
			return result.changes === 1;
		});
		const sub: ActiveSubscription = {
			handleId,
			serverName: "discord",
			eventName: "x",
			params: {},
			taskId,
			threadId,
			buffer: [],
			flushTimer: null,
			deduplicationSet: new Set(),
		};
		deliver.deliverBatch(sub, [makeSpokeEvent("event-2")]);
		expect(db.query("SELECT idempotency_key FROM relay_outbox").all()).toEqual([
			{ idempotency_key: "intake:discord:event-2" },
		]);
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
		expect(db.query("SELECT COUNT(*) AS count FROM durable_work").get()).toEqual({ count: 0 });
	});
});

function makeSpokeEvent(eventId: string): McpEvent {
	return {
		eventId,
		name: "x",
		timestamp: new Date().toISOString(),
		data: { eventId },
		cursor: eventId,
	};
}
