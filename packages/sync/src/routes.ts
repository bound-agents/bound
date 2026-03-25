import type { Database } from "bun:sqlite";
import { insertInbox, markDelivered, readUndelivered, writeOutbox } from "@bound/core";
import type { KeyringConfig, Logger, RelayInboxEntry, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { type RelayRequest, type RelayResponse, fetchInboundChangeset } from "./changeset.js";
import { type EagerPushConfig, eagerPushToSpoke } from "./eager-push.js";
import { createSyncAuthMiddleware } from "./middleware.js";
import { updatePeerCursor } from "./peer-cursor.js";
import { replayEvents } from "./reducers.js";
import { type RelayExecutor, noopRelayExecutor } from "./relay-executor.js";

type AppContext = {
	Variables: {
		siteId: string;
		hostName: string;
		rawBody: string;
	};
};

export function createSyncRoutes(
	db: Database,
	siteId: string,
	keyring: KeyringConfig,
	_eventBus: TypedEventEmitter,
	logger: Logger,
	relayExecutor?: RelayExecutor,
	hubSiteId?: string,
	eagerPushConfig?: EagerPushConfig,
): Hono<AppContext> {
	const app = new Hono<AppContext>();

	// Apply auth middleware to all sync routes
	app.use("/sync/*", createSyncAuthMiddleware(keyring));

	// Apply auth middleware to relay-deliver endpoint
	app.use("/api/relay-deliver", createSyncAuthMiddleware(keyring));

	// POST /sync/push - Receive events from a spoke
	app.post("/sync/push", async (c) => {
		try {
			const body = c.get("rawBody") as string;
			const changeset = JSON.parse(body);

			const events = changeset.events || [];
			const pusherSiteId = c.get("siteId") as string;

			// Replay events through reducers
			const result = replayEvents(db, events);

			// Update peer cursor to mark events as received
			if (events.length > 0) {
				const lastSeq = events[events.length - 1].seq;
				updatePeerCursor(db, pusherSiteId, { last_received: lastSeq });
			}

			// Reset reachability tracking on successful sync
			if (eagerPushConfig) {
				eagerPushConfig.reachabilityTracker.recordSuccess(pusherSiteId);
			}

			logger.info(`Received ${events.length} events from ${pusherSiteId}`);

			return c.json({ ok: true, received: result.applied });
		} catch (error) {
			logger.error(`Push error: ${error instanceof Error ? error.message : "Unknown error"}`);
			return c.json({ error: "Failed to process push" }, 400);
		}
	});

	// POST /sync/pull - Return events to a spoke
	app.post("/sync/pull", async (c) => {
		try {
			const body = c.get("rawBody") as string;
			const request = JSON.parse(body) as { since_seq?: number };
			const sinceSeq = request.since_seq ?? 0;

			const requesterSiteId = c.get("siteId") as string;

			// Fetch inbound changeset with echo suppression
			const changeset = fetchInboundChangeset(db, requesterSiteId, sinceSeq);

			logger.info(
				`Pulling ${changeset.events.length} events for ${requesterSiteId} since seq ${sinceSeq}`,
			);

			return c.json(changeset);
		} catch (error) {
			logger.error(`Pull error: ${error instanceof Error ? error.message : "Unknown error"}`);
			return c.json({ error: "Failed to process pull" }, 400);
		}
	});

	// POST /sync/ack - Spoke confirms receipt
	app.post("/sync/ack", async (c) => {
		try {
			const body = c.get("rawBody") as string;
			const request = JSON.parse(body) as { last_received: number };
			const lastReceived = request.last_received;

			const ackingSiteId = c.get("siteId") as string;

			// Update peer cursor to mark events as sent
			updatePeerCursor(db, ackingSiteId, { last_sent: lastReceived });

			logger.info(`ACK from ${ackingSiteId}: confirmed through seq ${lastReceived}`);

			return c.json({ ok: true });
		} catch (error) {
			logger.error(`Ack error: ${error instanceof Error ? error.message : "Unknown error"}`);
			return c.json({ error: "Failed to process ack" }, 400);
		}
	});

	// POST /sync/relay - Process relay messages
	app.post("/sync/relay", async (c) => {
		try {
			const body = JSON.parse(c.get("rawBody")) as RelayRequest;
			const requesterSiteId = c.get("siteId") as string;
			const executor = relayExecutor ?? noopRelayExecutor;

			const deliveredIds: string[] = [];
			const inboxForRequester: RelayInboxEntry[] = [];

			for (const entry of body.relay_outbox) {
				// Idempotency check on hub side
				if (entry.idempotency_key) {
					const existing = db
						.query("SELECT id FROM relay_outbox WHERE idempotency_key = ? AND target_site_id = ?")
						.get(entry.idempotency_key, entry.target_site_id) as { id: string } | null;
					if (existing) {
						deliveredIds.push(entry.id);
						continue;
					}
				}

				if (entry.target_site_id === siteId) {
					// Hub-local execution
					const results = await executor(entry, siteId);
					for (const result of results) {
						inboxForRequester.push(result);
					}
				} else {
					// Store for target spoke — write to hub's own outbox for delivery
					// Preserve source_site_id so target knows who sent the request
					const inboxEntry: RelayInboxEntry = {
						id: crypto.randomUUID(),
						source_site_id: requesterSiteId,
						kind: entry.kind,
						ref_id: entry.ref_id ?? entry.id,
						idempotency_key: entry.idempotency_key,
						payload: entry.payload,
						expires_at: entry.expires_at,
						received_at: new Date().toISOString(),
						processed: 0,
					};
					writeOutbox(db, {
						id: inboxEntry.id,
						source_site_id: requesterSiteId,
						target_site_id: entry.target_site_id,
						kind: entry.kind,
						ref_id: entry.ref_id ?? entry.id,
						idempotency_key: entry.idempotency_key,
						payload: entry.payload,
						created_at: new Date().toISOString(),
						expires_at: entry.expires_at,
					});

					// Fire-and-forget eager push — push failure is invisible to requester (AC2.3)
					if (eagerPushConfig) {
						void eagerPushToSpoke(eagerPushConfig, entry.target_site_id, [inboxEntry]);
					}
				}
				deliveredIds.push(entry.id);
			}

			// Fetch pending inbox entries for this requester from hub's outbox
			// (messages routed to requester from other spokes)
			const pendingForRequester = readUndelivered(db, requesterSiteId);
			for (const pending of pendingForRequester) {
				inboxForRequester.push({
					id: pending.id,
					source_site_id: pending.source_site_id ?? requesterSiteId,
					kind: pending.kind,
					ref_id: pending.ref_id,
					idempotency_key: pending.idempotency_key,
					payload: pending.payload,
					expires_at: pending.expires_at,
					received_at: new Date().toISOString(),
					processed: 0,
				});
			}
			// Mark those as delivered on hub
			if (pendingForRequester.length > 0) {
				markDelivered(
					db,
					pendingForRequester.map((p) => p.id),
				);
			}

			const response: RelayResponse = {
				relay_inbox: inboxForRequester,
				relay_delivered: deliveredIds,
				relay_draining: false, // Phase 6 implements drain logic
			};

			return c.json(response);
		} catch (error) {
			logger.error(`Relay error: ${error instanceof Error ? error.message : "Unknown error"}`);
			return c.json({ error: "Failed to process relay" }, 400);
		}
	});

	// POST /api/relay-deliver - Receive relay messages pushed from hub
	app.post("/api/relay-deliver", async (c) => {
		try {
			const senderSiteId = c.get("siteId") as string;

			// Only accept messages from the current hub
			if (hubSiteId && senderSiteId !== hubSiteId) {
				return c.json({ ok: false, error: "Not from current hub" }, 403);
			}

			const body = JSON.parse(c.get("rawBody")) as { entries: RelayInboxEntry[] };
			let received = 0;
			for (const entry of body.entries) {
				const inserted = insertInbox(db, entry);
				if (inserted) received++;
			}

			return c.json({ ok: true, received });
		} catch (error) {
			logger.error(
				`Relay deliver error: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return c.json({ error: "Failed to process relay delivery" }, 400);
		}
	});

	return app;
}
