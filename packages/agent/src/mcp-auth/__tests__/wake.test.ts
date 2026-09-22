import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { applySchema, markFailed, markResolved, raiseChallenge } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import {
	consumeWaiter,
	findAllUnconsumedWaiters,
	findUnconsumedWaiters,
	upsertWaiter,
} from "../waiters";
import { formatWakeText, reconcileWaitersOnBoot, wakeWaitersForChallenge } from "../wake";

/**
 * Waiter-store + wake tests (R-MO15/R-MO16/R-MO16b). The wake path is exercised
 * through routeNotificationWakeup, which with no client session enqueues locally
 * — we assert the dispatch_queue fence and the waiter consumption bookkeeping.
 */

const SITE = "site-requester";

let db: Database;
let bus: TypedEventEmitter;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	bus = new EventEmitter() as unknown as TypedEventEmitter;
});

afterEach(() => {
	db.close();
});

function seed(serverName: string, granted = ""): string {
	return raiseChallenge(
		db,
		{
			serverName,
			owningSiteId: SITE,
			serverUrl: "https://mcp.example.com",
			scopeDemand: "read",
			grantedScopes: granted,
			resourceMetadataHint: null,
			clientId: null,
		},
		SITE,
	);
}

describe("waiter store upsert (R-MO15)", () => {
	it("upserts, never appends, on a repeated settle for the same pair", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		upsertWaiter(db, id, "thread-1");
		expect(findUnconsumedWaiters(db, id)).toHaveLength(1);
	});

	it("keeps distinct rows for distinct threads on one challenge", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		upsertWaiter(db, id, "thread-2");
		expect(findUnconsumedWaiters(db, id)).toHaveLength(2);
	});

	it("consumeWaiter is exactly-once (second call returns false)", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		expect(consumeWaiter(db, id, "thread-1")).toBe(true);
		expect(consumeWaiter(db, id, "thread-1")).toBe(false);
		expect(findUnconsumedWaiters(db, id)).toHaveLength(0);
	});

	it("a re-settle after consumption re-arms the waiter (consumed_at reset)", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		consumeWaiter(db, id, "thread-1");
		upsertWaiter(db, id, "thread-1");
		expect(findUnconsumedWaiters(db, id)).toHaveLength(1);
	});
});

describe("formatWakeText (R-MO16)", () => {
	it("resolved → invites re-issue", () => {
		const id = seed("srv");
		markResolved(db, id, SITE);
		const { findChallengeById } = require("@bound/core");
		const text = formatWakeText(findChallengeById(db, id));
		expect(text).toContain("resolved");
		expect(text).toContain("re-issue");
	});

	it("failed with granted scopes → step-up denial (prior grant intact)", () => {
		const id = seed("srv", "read");
		markFailed(db, id, "invalid_scope", SITE);
		const { findChallengeById } = require("@bound/core");
		const text = formatWakeText(findChallengeById(db, id));
		expect(text).toContain("invalid_scope");
		expect(text.toLowerCase()).toContain("narrower grant");
	});

	it("failed with no granted scopes → no-grant-at-all", () => {
		const id = seed("srv", "");
		markFailed(db, id, "access_denied", SITE);
		const { findChallengeById } = require("@bound/core");
		const text = formatWakeText(findChallengeById(db, id));
		expect(text).toContain("access_denied");
		expect(text.toLowerCase()).toContain("unauthenticated");
	});
});

describe("wakeWaitersForChallenge (R-MO16)", () => {
	it("wakes each waiter once and enqueues an idempotent notification", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		upsertWaiter(db, id, "thread-2");
		markResolved(db, id, SITE);
		const woken = wakeWaitersForChallenge(db, bus, SITE, id);
		expect(woken).toBe(2);
		// Both consumed.
		expect(findUnconsumedWaiters(db, id)).toHaveLength(0);
		// A second wake is a no-op (already consumed).
		expect(wakeWaitersForChallenge(db, bus, SITE, id)).toBe(0);
	});

	it("does not wake for a still-pending challenge", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		expect(wakeWaitersForChallenge(db, bus, SITE, id)).toBe(0);
		expect(findUnconsumedWaiters(db, id)).toHaveLength(1);
	});

	it("the wake dispatch idempotency key is challenge-wake:<cid>:<tid>", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		markResolved(db, id, SITE);
		wakeWaitersForChallenge(db, bus, SITE, id);
		// With no client session the wake enqueues locally. Under durable dispatch it
		// lands as a durable_work `dispatch_message` row whose payload carries the
		// deterministic fence key as the notification_id (R-MO16).
		const row = db
			.query("SELECT payload FROM durable_work WHERE kind = 'dispatch_message'")
			.get() as { payload: string } | null;
		if (!row) throw new Error("expected a dispatch_message row");
		const outer = JSON.parse(row.payload) as { event_payload: string };
		const notif = JSON.parse(outer.event_payload) as { notification_id: string };
		expect(notif.notification_id).toBe(`challenge-wake:${id}:thread-1`);
	});
});

describe("reconcileWaitersOnBoot (R-MO16b)", () => {
	it("wakes waiters whose challenge is already terminal, skips still-pending", () => {
		const resolvedId = seed("srv-a");
		const pendingId = seed("srv-b");
		upsertWaiter(db, resolvedId, "thread-1");
		upsertWaiter(db, pendingId, "thread-2");
		markResolved(db, resolvedId, SITE);

		const woken = reconcileWaitersOnBoot(db, bus, SITE);
		expect(woken).toBe(1);
		expect(findUnconsumedWaiters(db, resolvedId)).toHaveLength(0);
		expect(findUnconsumedWaiters(db, pendingId)).toHaveLength(1);
	});

	it("a wake already delivered before restart leaves no record to re-fire", () => {
		const id = seed("srv");
		upsertWaiter(db, id, "thread-1");
		markResolved(db, id, SITE);
		wakeWaitersForChallenge(db, bus, SITE, id);
		// Restart sweep: nothing unconsumed remains.
		expect(findAllUnconsumedWaiters(db)).toHaveLength(0);
		expect(reconcileWaitersOnBoot(db, bus, SITE)).toBe(0);
	});
});
