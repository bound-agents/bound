import type { Database } from "bun:sqlite";
import type { KeyringConfig, Logger, TypedEventEmitter } from "@bound/shared";
import { Hono } from "hono";
import { fetchInboundChangeset } from "./changeset.js";
import { createSyncAuthMiddleware } from "./middleware.js";
import { updatePeerCursor } from "./peer-cursor.js";
import { replayEvents } from "./reducers.js";

type AppContext = {
	Variables: {
		siteId: string;
		hostName: string;
	};
};

export function createSyncRoutes(
	db: Database,
	_siteId: string,
	keyring: KeyringConfig,
	_eventBus: TypedEventEmitter,
	logger: Logger,
): Hono<AppContext> {
	const app = new Hono<AppContext>();

	// Apply auth middleware to all sync routes
	app.use("/sync/*", createSyncAuthMiddleware(keyring));

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

	return app;
}
