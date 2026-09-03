import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { deliverNotificationWakeup, routeNotificationWakeup } from "../wakeup-routing";
import type { NotifyWakeupPayload } from "../wakeup-routing";

/**
 * Wakeup routing (#91 regression under unified delegation): dispatch_queue is
 * local-only, so a notify/introspect wakeup enqueued on host A runs a loop on
 * host A even when the thread's live boundless session (and typically its
 * active loop) is on host B — two hosts, two loops, one thread, no cross-host
 * lock. The router sends the WAKEUP to the session host over the relay
 * (kind "notify_wakeup") instead of delegating the loop, so exactly one host
 * ever wakes the thread. No live remote session → current local behavior.
 */

function insertHost(db: Database, siteId: string, hostName: string, modifiedAt: string) {
	db.prepare(
		"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted, work_spool_capable) VALUES (?, ?, ?, ?, 0, 1)",
	).run(siteId, hostName, modifiedAt, modifiedAt);
}

function insertSession(db: Database, threadId: string, siteId: string) {
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, deleted, modified_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
	).run(`conn-${siteId}::${threadId}`, `conn-${siteId}`, threadId, siteId, now, now);
}

function getDispatchRows(db: Database, threadId: string): Array<{ event_payload: string }> {
	return db
		.prepare(
			"SELECT json_extract(payload, '$.event_payload') AS event_payload FROM durable_work WHERE kind = 'dispatch_message' AND json_extract(payload, '$.thread_id') = ?",
		)
		.all(threadId) as Array<{ event_payload: string }>;
}

// Post-N+1 the relay path is durable-only: routeNotificationWakeup writes a
// peer-targeted durable_work row (kind "notify_wakeup") that transfers to the
// session host. The legacy relay_outbox is gone; assertions read durable_work.
function getOutboxRows(db: Database): Array<{
	kind: string;
	target_site_id: string;
	payload: string;
	idempotency_key: string | null;
}> {
	return db
		.prepare(
			"SELECT kind, target_site_id, payload, idempotency_key FROM durable_work WHERE kind = 'notify_wakeup'",
		)
		.all() as Array<{
		kind: string;
		target_site_id: string;
		payload: string;
		idempotency_key: string | null;
	}>;
}

describe("routeNotificationWakeup", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let notifyEvents: Array<{ thread_id: string }>;
	const localSite = "local-site";
	const threadId = "thread-1";
	const payload = { type: "proactive", content: "hello", source_thread: null };

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		notifyEvents = [];
		eventBus.on("notify:enqueued", (e: { thread_id: string }) => notifyEvents.push(e));
	});

	afterEach(() => {
		db.close();
	});

	it("enqueues locally when the thread has no client session", () => {
		const result = routeNotificationWakeup(db, eventBus, localSite, threadId, payload);
		expect(result.delivery).toBe("local");
		expect(getDispatchRows(db, threadId)).toHaveLength(1);
		expect(getOutboxRows(db)).toHaveLength(0);
		expect(notifyEvents).toEqual([{ thread_id: threadId }]);
	});

	it("enqueues locally when the live session is on THIS host", () => {
		insertHost(db, localSite, "local-host", new Date().toISOString());
		insertSession(db, threadId, localSite);
		const result = routeNotificationWakeup(db, eventBus, localSite, threadId, payload);
		expect(result.delivery).toBe("local");
		expect(getDispatchRows(db, threadId)).toHaveLength(1);
		expect(getOutboxRows(db)).toHaveLength(0);
	});

	it("relays the wakeup to a live remote session host instead of enqueueing locally", () => {
		insertHost(db, "remote-site", "remote-host", new Date().toISOString());
		insertSession(db, threadId, "remote-site");

		const result = routeNotificationWakeup(db, eventBus, localSite, threadId, payload);

		expect(result.delivery).toBe("relayed");
		expect(result.targetHostName).toBe("remote-host");
		// The whole point: NO local loop wakeup.
		expect(getDispatchRows(db, threadId)).toHaveLength(0);
		expect(notifyEvents).toHaveLength(0);

		const outbox = getOutboxRows(db);
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.kind).toBe("notify_wakeup");
		expect(outbox[0]?.target_site_id).toBe("remote-site");
		const shipped = JSON.parse(outbox[0]?.payload ?? "{}") as {
			thread_id: string;
			payload: Record<string, unknown>;
		};
		expect(shipped.thread_id).toBe(threadId);
		expect(shipped.payload).toEqual(payload);
	});

	it("uses one sender-derived key through relay and receiver dispatch fences", () => {
		insertHost(db, "remote-site", "remote-host", new Date().toISOString());
		insertSession(db, threadId, "remote-site");
		const identifiedPayload = { ...payload, notification_id: "notification-1" };
		routeNotificationWakeup(db, eventBus, localSite, threadId, identifiedPayload);
		const [outbox] = getOutboxRows(db);
		expect(outbox?.idempotency_key).toBe("notify:notification-1");
		const wire = JSON.parse(outbox?.payload ?? "{}") as NotifyWakeupPayload;
		deliverNotificationWakeup(db, eventBus, wire);
		deliverNotificationWakeup(db, eventBus, wire);
		expect(getDispatchRows(db, threadId)).toHaveLength(1);
	});

	it("delivers identical notifications with distinct producer IDs while fencing redelivery", () => {
		insertHost(db, "remote-site", "remote-host", new Date().toISOString());
		insertSession(db, threadId, "remote-site");
		const firstId = randomUUID();
		const secondId = randomUUID();
		const firstPayload = { ...payload, notification_id: firstId };
		const secondPayload = { ...payload, notification_id: secondId };

		routeNotificationWakeup(db, eventBus, localSite, threadId, firstPayload);
		routeNotificationWakeup(db, eventBus, localSite, threadId, secondPayload);

		const outbox = getOutboxRows(db);
		expect(outbox).toHaveLength(2);
		expect(outbox.map((row) => row.idempotency_key).sort()).toEqual(
			[`notify:${firstId}`, `notify:${secondId}`].sort(),
		);
		expect(outbox.every((row) => row.idempotency_key !== null)).toBe(true);

		const wirePayloads = outbox.map((row) => JSON.parse(row.payload) as NotifyWakeupPayload);
		for (const wirePayload of wirePayloads) {
			deliverNotificationWakeup(db, eventBus, wirePayload);
		}
		expect(getDispatchRows(db, threadId)).toHaveLength(2);

		const [redeliveryPayload] = wirePayloads;
		if (!redeliveryPayload) throw new Error("expected a relay payload to redeliver");
		deliverNotificationWakeup(db, eventBus, redeliveryPayload);
		expect(getDispatchRows(db, threadId)).toHaveLength(2);
	});

	it("falls back to local when the remote session host is stale", () => {
		const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		insertHost(db, "remote-site", "remote-host", stale);
		insertSession(db, threadId, "remote-site");

		const result = routeNotificationWakeup(db, eventBus, localSite, threadId, payload);
		expect(result.delivery).toBe("local");
		expect(getDispatchRows(db, threadId)).toHaveLength(1);
		expect(getOutboxRows(db)).toHaveLength(0);
	});
});
