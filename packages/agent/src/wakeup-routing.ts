import type { Database } from "bun:sqlite";
import { enqueueNotification } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import { resolveClientSessionHost } from "./delegation";
import { routeRelayRequest } from "./relay-router";
import type { TopologyRole } from "./topology";

/**
 * Route a notify/introspect wakeup to the host that should run the woken
 * loop (#91 regression under unified delegation).
 *
 * dispatch_queue is LOCAL-ONLY: enqueueing a notification wakes a loop on
 * whatever host the notify happened to run on. When the target thread's live
 * boundless session — and typically its active loop — is on ANOTHER host,
 * that local enqueue mints a second, detached loop for the same thread:
 * two hosts, two loops, one thread, no cross-host lock, and the detached
 * loop can't run the thread's client tools anyway.
 *
 * The pre-unified-delegation fix (71d67d12) solved this by delegating the
 * whole LOOP to the session host; unified delegation (R-UD1) removed
 * whole-loop delegation, which silently regressed this into the
 * two-loops-per-thread behavior. Under R-UD1 the correct primitive is to
 * route the WAKEUP, not the loop: ship the notification payload to the
 * session host over the relay (kind "notify_wakeup"); that host enqueues
 * into its own dispatch_queue and wakes the thread beside its session.
 *
 * Routing (mirrors resolveClientSessionHost semantics):
 *   1. live session on a REMOTE host → relay the wakeup there; NO local
 *      enqueue (that's the whole point).
 *   2. live session on THIS host, or no session anywhere, or only stale
 *      sessions → enqueue locally + emit notify:enqueued (current behavior).
 *
 * The receiving host enqueues UNCONDITIONALLY — it does not re-run this
 * router — so a session row churning mid-flight cannot ping-pong the wakeup
 * between hosts. Worst case (session died in flight) the wakeup runs where
 * the session was last seen, which is exactly the pre-#91 behavior for a
 * just-disconnected client.
 */
export interface WakeupRoutingResult {
	delivery: "local" | "relayed";
	/** Set when delivery === "relayed". */
	targetSiteId?: string;
	targetHostName?: string;
}

/** Relay payload for kind "notify_wakeup". */
export interface NotifyWakeupPayload {
	thread_id: string;
	payload: Record<string, unknown>;
	/** Stable producer-minted ID; absent on legacy senders. */
	notification_id?: string;
	/** Sender-derived key, retained through the local dispatch fence. */
	idempotency_key?: string;
}

const NOTIFY_WAKEUP_TTL_MS = 5 * 60 * 1000;

export function routeNotificationWakeup(
	db: Database,
	eventBus: TypedEventEmitter,
	localSiteId: string,
	threadId: string,
	payload: Record<string, unknown>,
	topologyRole?: TopologyRole,
): WakeupRoutingResult {
	const sessionHost = resolveClientSessionHost(db, threadId, localSiteId);

	if (sessionHost) {
		// Legacy senders did not carry an identity. Leave those unkeyed so their
		// historical random dispatch IDs (and accepted duplicate deliveries) remain.
		const notificationId =
			typeof payload.notification_id === "string" && payload.notification_id.length > 0
				? payload.notification_id
				: undefined;
		const idempotencyKey = notificationId ? `notify:${notificationId}` : undefined;
		const wire: NotifyWakeupPayload = {
			thread_id: threadId,
			payload,
			notification_id: notificationId,
			idempotency_key: idempotencyKey,
		};
		routeRelayRequest(db, {
			targetSiteId: sessionHost.site_id,
			sourceSiteId: localSiteId,
			kind: "notify_wakeup",
			payload: JSON.stringify(wire),
			timeoutMs: NOTIFY_WAKEUP_TTL_MS,
			// Verbatim key when the sender carried an identity (notify:<id>);
			// legacy unkeyed senders keep their historical random dispatch id on
			// the legacy path and, on the durable path, the minted row id.
			idempotencyKey,
			topologyRole,
		});
		return {
			delivery: "relayed",
			targetSiteId: sessionHost.site_id,
			targetHostName: sessionHost.host_name,
		};
	}

	enqueueNotification(db, threadId, payload);
	eventBus.emit("notify:enqueued", { thread_id: threadId });
	return { delivery: "local" };
}

/**
 * Receiving-side delivery for a relayed "notify_wakeup": enqueue into THIS
 * host's dispatch_queue and wake the thread. Unconditional by design — see
 * routeNotificationWakeup's no-ping-pong contract.
 */
export function deliverNotificationWakeup(
	db: Database,
	eventBus: TypedEventEmitter,
	wire: NotifyWakeupPayload,
): void {
	enqueueNotification(db, wire.thread_id, wire.payload, wire.idempotency_key);
	eventBus.emit("notify:enqueued", { thread_id: wire.thread_id });
}
