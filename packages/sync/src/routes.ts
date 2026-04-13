import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertInbox, markDelivered, readUndelivered, writeOutbox } from "@bound/core";
import {
	type ChangeLogEntry,
	type KeyringConfig,
	type Logger,
	RELAY_RESPONSE_KINDS,
	type RelayInboxEntry,
	type RelayResponseKind,
	type TypedEventEmitter,
	parseJsonUntyped,
} from "@bound/shared";
import { Hono } from "hono";
import { type RelayRequest, type RelayResponse, fetchInboundChangeset } from "./changeset.js";
import { type EagerPushConfig, eagerPushToSpoke } from "./eager-push.js";
import type { KeyManager } from "./key-manager.js";
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
	threadAffinityMap?: Map<string, string>,
	keyManager?: KeyManager,
): Hono<AppContext> {
	const app = new Hono<AppContext>();

	// Apply auth middleware to all sync routes
	app.use("/sync/*", createSyncAuthMiddleware(keyring, keyManager, logger));

	// Apply auth middleware to relay-deliver endpoint
	app.use("/api/relay-deliver", createSyncAuthMiddleware(keyring, keyManager, logger));

	// POST /sync/push - Receive events from a spoke
	app.post("/sync/push", async (c) => {
		try {
			const body = c.get("rawBody") as string;
			const parseResult = parseJsonUntyped(body, "sync/push");
			if (!parseResult.ok) {
				logger.error(`Push JSON parse error: ${parseResult.error}`);
				return c.json({ error: "Malformed request body" }, 400);
			}
			const changeset = parseResult.value as { events?: ChangeLogEntry[] };

			const events = changeset.events || [];
			const pusherSiteId = c.get("siteId") as string;

			// Replay events through reducers
			const result = replayEvents(db, events);

			// Update peer cursor to mark events as received
			if (events.length > 0) {
				const lastEvent = events[events.length - 1];
				const lastHlc = lastEvent.hlc;
				updatePeerCursor(db, pusherSiteId, { last_received: lastHlc });
			}

			// Reset reachability tracking on successful sync
			if (eagerPushConfig) {
				eagerPushConfig.reachabilityTracker.recordSuccess(pusherSiteId);
			}

			logger.debug(`Received ${events.length} events from ${pusherSiteId}`);

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
			const parseResult = parseJsonUntyped(body, "sync/pull");
			if (!parseResult.ok) {
				logger.error(`Pull JSON parse error: ${parseResult.error}`);
				return c.json({ error: "Malformed request body" }, 400);
			}
			const request = parseResult.value as { since_hlc?: string };
			const sinceHlc = request.since_hlc ?? "0000-00-00T00:00:00.000Z_0000_0000";

			const requesterSiteId = c.get("siteId") as string;

			// Fetch inbound changeset with echo suppression
			const changeset = fetchInboundChangeset(db, requesterSiteId, sinceHlc);

			logger.debug(
				`Pulling ${changeset.events.length} events for ${requesterSiteId} since hlc ${sinceHlc}`,
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
			const parseResult = parseJsonUntyped(body, "sync/ack");
			if (!parseResult.ok) {
				logger.error(`Ack JSON parse error: ${parseResult.error}`);
				return c.json({ error: "Malformed request body" }, 400);
			}
			const request = parseResult.value as { last_received: string };
			const lastReceived = request.last_received;

			const ackingSiteId = c.get("siteId") as string;

			// Update peer cursor to mark events as sent
			updatePeerCursor(db, ackingSiteId, { last_sent: lastReceived });

			logger.debug(`ACK from ${ackingSiteId}: confirmed through hlc ${lastReceived}`);

			return c.json({ ok: true });
		} catch (error) {
			logger.error(`Ack error: ${error instanceof Error ? error.message : "Unknown error"}`);
			return c.json({ error: "Failed to process ack" }, 400);
		}
	});

	// POST /sync/relay - Process relay messages
	app.post("/sync/relay", async (c) => {
		try {
			const bodyStr = c.get("rawBody");
			const parseResult = parseJsonUntyped(bodyStr, "sync/relay");
			if (!parseResult.ok) {
				logger.error(`Relay JSON parse error: ${parseResult.error}`);
				return c.json({ error: "Malformed request body" }, 400);
			}
			const body = parseResult.value as RelayRequest;
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

				// Broadcast: fan-out to all known spokes except the source
				if (entry.target_site_id === "*") {
					const allSiteIds = Object.keys(keyring.hosts ?? {});
					const targets = allSiteIds.filter((id) => id !== requesterSiteId);
					for (const targetId of targets) {
						const inboxEntry: RelayInboxEntry = {
							id: randomUUID(),
							source_site_id: requesterSiteId,
							kind: entry.kind,
							ref_id: entry.id,
							idempotency_key: entry.idempotency_key,
							stream_id: entry.stream_id ?? null,
							payload: entry.payload,
							expires_at: entry.expires_at,
							received_at: new Date().toISOString(),
							processed: 0,
						};
						insertInbox(db, inboxEntry);
						if (eagerPushConfig) {
							void eagerPushToSpoke(eagerPushConfig, targetId, [inboxEntry]);
						}
					}
					deliveredIds.push(entry.id);
					continue; // skip the single-target routing below
				}
				// Update thread-affinity map when a status_forward passes through
				if (entry.kind === "status_forward" && threadAffinityMap) {
					const sfParseResult = parseJsonUntyped(entry.payload, "status_forward");
					if (sfParseResult.ok) {
						const sfPayload = sfParseResult.value as { thread_id?: string };
						if (sfPayload.thread_id) {
							threadAffinityMap.set(sfPayload.thread_id, requesterSiteId);
						}
					}
					// Malformed payload — ignore, affinity is best-effort
				}
				if (entry.target_site_id === siteId) {
					// Response kinds (stream_chunk, stream_end, result, error, status_forward)
					// targeting the hub must go into the hub's relay_inbox so the polling loop
					// (e.g. RELAY_STREAM, RELAY_WAIT) can read them — NOT through the executor.
					const isResponseKind = (kind: string): kind is RelayResponseKind =>
						RELAY_RESPONSE_KINDS.includes(kind as RelayResponseKind);
					if (isResponseKind(entry.kind)) {
						// Use the original outbox entry ID so INSERT OR IGNORE
						// deduplicates retransmissions (at-least-once delivery).
						const inboxEntry: RelayInboxEntry = {
							id: entry.id,
							source_site_id: requesterSiteId,
							kind: entry.kind,
							ref_id: entry.ref_id ?? entry.id,
							idempotency_key: entry.idempotency_key,
							stream_id: entry.stream_id ?? null,
							payload: entry.payload,
							expires_at: entry.expires_at,
							received_at: new Date().toISOString(),
							processed: 0,
						};
						insertInbox(db, inboxEntry);
					} else {
						// Hub-local execution for request kinds
						const results = await executor(entry, siteId);
						for (const result of results) {
							inboxForRequester.push(result);
						}
					}
				} else {
					// Store for target spoke — write to hub's own outbox for delivery
					// Preserve source_site_id so target knows who sent the request
					// Use original outbox entry ID for dedup on retransmission.
					const inboxEntry: RelayInboxEntry = {
						id: entry.id,
						source_site_id: requesterSiteId,
						kind: entry.kind,
						ref_id: entry.ref_id ?? entry.id,
						idempotency_key: entry.idempotency_key,
						stream_id: entry.stream_id ?? null,
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
						stream_id: entry.stream_id ?? null,
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
					stream_id: pending.stream_id ?? null,
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

			// Read relay_draining flag from host_meta (non-synced, local-only)
			const drainState = db
				.query("SELECT value FROM host_meta WHERE key = ?")
				.get("relay_draining") as { value: string } | null;

			// Check if hub has more pending relay entries for this spoke.
			// This can happen when new entries arrive between the readUndelivered
			// call above and now (e.g., from concurrent agent loops or relay routing).
			const stillPending = readUndelivered(db, requesterSiteId);

			const response: RelayResponse = {
				relay_inbox: inboxForRequester,
				relay_delivered: deliveredIds,
				relay_draining: drainState?.value === "true",
				relay_pending: stillPending.length > 0,
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

			const bodyStr = c.get("rawBody");
			const parseResult = parseJsonUntyped(bodyStr, "relay-deliver");
			if (!parseResult.ok) {
				logger.error(`Relay deliver JSON parse error: ${parseResult.error}`);
				return c.json({ error: "Malformed request body" }, 400);
			}
			const body = parseResult.value as { entries: RelayInboxEntry[] };
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
