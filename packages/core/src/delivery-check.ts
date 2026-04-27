/**
 * Post-loop platform delivery check.
 *
 * Called after an agent turn completes on a platform thread (from both
 * the local handleThread path in @bound/cli and the delegated
 * executeProcess path in @bound/agent's relay-processor). A "missing"
 * verdict from the platform's verifyDelivery hook inserts a
 * developer-role nudge + enqueues a dispatch entry so the next turn has
 * a chance to emit the egress tool call.
 *
 * Lives in @bound/core because every state primitive it touches —
 * insertRow, enqueueMessage, formatError, Logger — is already core. No
 * cross-package dep is added by relay-processor or server.ts calling
 * this, which is what lets both the spoke and the hub share the same
 * implementation.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Logger } from "@bound/shared";
import { formatError } from "@bound/shared";
import { insertRow } from "./change-log";
import { enqueueMessage } from "./dispatch";

/**
 * Connector surface required by runPostLoopDeliveryCheck. Intentionally a
 * structural subset of PlatformConnector so call sites don't need to
 * import from @bound/platforms just to call this function, and so tests
 * can pass plain objects.
 */
export interface DeliveryCheckConnector {
	verifyDelivery?: (
		threadId: string,
		turnStartAt: string,
	) => Promise<
		{ kind: "delivered" } | { kind: "intentional-silence" } | { kind: "missing"; nudge: string }
	>;
}

export interface RunPostLoopDeliveryCheckParams {
	db: Database;
	siteId: string;
	hostName: string;
	threadId: string;
	/** ISO timestamp of when the turn being evaluated began. */
	turnStartAt: string;
	/** Platform key — used to namespace the metadata tombstone key. */
	platform: string;
	connector: DeliveryCheckConnector;
	logger?: Logger;
}

/**
 * Consult the platform connector's verifyDelivery hook after an agent
 * turn completes. When the verdict is "missing", inserts a
 * developer-role nudge message with a platform-scoped tombstone in
 * messages.metadata AND enqueues it via dispatch_queue so the next loop
 * cycle picks it up as a trigger. The tombstone lets the connector's
 * verifyDelivery on the FOLLOWING turn recognize "agent already nudged;
 * respect silence."
 *
 * No-op when:
 *   - The connector has no verifyDelivery method.
 *   - The verdict is "delivered" or "intentional-silence".
 *   - verifyDelivery throws — logged but swallowed to avoid crashing the
 *     post-loop path for an observability feature.
 */
export async function runPostLoopDeliveryCheck(
	params: RunPostLoopDeliveryCheckParams,
): Promise<void> {
	const { db, siteId, hostName, threadId, turnStartAt, platform, connector, logger } = params;
	if (!connector.verifyDelivery) return;

	let verdict: Awaited<ReturnType<NonNullable<DeliveryCheckConnector["verifyDelivery"]>>>;
	try {
		verdict = await connector.verifyDelivery(threadId, turnStartAt);
	} catch (err) {
		logger?.warn("[delivery-check] verifyDelivery threw — skipping nudge", {
			threadId,
			platform,
			error: formatError(err),
		});
		return;
	}

	if (verdict.kind !== "missing") return;

	// Insert the nudge as a developer-role message with a platform-scoped
	// tombstone so the NEXT turn's verifyDelivery can recognize "nudge
	// already issued" and respect silence. Enqueue the message via
	// dispatch_queue so the agent loop re-triggers on this row (Invariant
	// #18: ProcessPayload.message_id must reference a real messages row —
	// enqueueMessage stores the real id, so delegation is safe).
	const tombstoneUuid = randomUUID();
	const messageId = randomUUID();
	const now = new Date().toISOString();
	const metadataKey = `${platform}_platform_delivery_retry`;

	insertRow(
		db,
		"messages",
		{
			id: messageId,
			thread_id: threadId,
			role: "developer",
			content: verdict.nudge,
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: hostName,
			deleted: 0,
			metadata: JSON.stringify({ [metadataKey]: tombstoneUuid }),
		},
		siteId,
	);

	enqueueMessage(db, messageId, threadId);
}
