import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { routeNotificationWakeup } from "../wakeup-routing";

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
		"INSERT INTO hosts (site_id, host_name, online_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
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
		.prepare("SELECT event_payload FROM dispatch_queue WHERE thread_id = ?")
		.all(threadId) as Array<{ event_payload: string }>;
}

function getOutboxRows(
	db: Database,
): Array<{ kind: string; target_site_id: string; payload: string }> {
	return db.prepare("SELECT kind, target_site_id, payload FROM relay_outbox").all() as Array<{
		kind: string;
		target_site_id: string;
		payload: string;
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
