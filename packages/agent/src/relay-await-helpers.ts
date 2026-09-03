import type { Database } from "bun:sqlite";
import {
	acknowledgeDurableWork,
	claimDurableWorkByIds,
	readDurableResponseByRefId,
} from "@bound/core";
import { parseJsonSafe, resultPayloadSchema } from "@bound/shared";

/**
 * The winning scalar response for one awaiting request, adapted to a common
 * `{ id, kind, payload, settle }` shape. `settle()` retires the row: a durable
 * response row was claimed under a fresh token here, so `settle()` acks it to
 * `consumed`. The token-fenced lifecycle makes delivery exactly-once even if a
 * redelivered transfer produced a second (fenced-away) copy.
 */
export interface UnionResponseEntry {
	id: string;
	kind: string;
	payload: string;
	settle: () => void;
}

/**
 * Union read for one awaiting request's scalar response. Returns the winning
 * durable_work response row targeted at self (or LOCAL_WORK_TARGET) for `refId`,
 * or null when none has landed yet.
 *
 * CRITICAL ORDER (claim → deliver → ack): a durable row is CLAIMED under a
 * fresh token here, but its ack is DEFERRED to `settle()` — the caller must
 * invoke `settle()` only AFTER it has taken delivery of the value. A crash
 * between delivery and ack boot-resets the durable row to pending; the later
 * duplicate ages out via its TTL → dead_letter → prune (at-least-once with
 * bounded residue, never silent loss). A lost claim race (another reader took
 * the row) returns null: that reader delivers it.
 *
 * This is the shared primitive behind {@link createRelayWait$}'s
 * `readUnionResponse` and the two CLI remotePlatformRequest awaiters — the same
 * exactly-once lifecycle, so no call site hand-rolls its own poll loop.
 */
export function readUnionResponseEntry(
	db: Database,
	refId: string,
	ownSiteId: string,
): UnionResponseEntry | null {
	const durable = readDurableResponseByRefId(db, refId, ownSiteId);
	if (!durable) return null;
	const claimed = claimDurableWorkByIds(db, [durable.id], ownSiteId);
	const row = claimed[0];
	// Lost the claim race (another reader took it) — treat as not-yet-available;
	// the winning reader delivers it.
	if (!row || !row.claim_token) return null;
	const token = row.claim_token;
	return {
		id: row.id,
		kind: row.kind,
		payload: row.payload,
		// Deferred token-fenced ack: fires only after the awaiter receives the value.
		settle: () => acknowledgeDurableWork(db, row.id, token),
	};
}

export interface PlatformResponseAwaitDeps {
	db: Database;
	siteId: string;
}

/**
 * Await a scalar `platform_request` response, polling the union of legacy
 * relay_inbox and durable_work response rows until `deadline`. Resolves with
 * the parsed `stdout` (the platform tool's JSON result), rejects with the
 * remote error on a `kind === "error"` row, or throws a timeout when neither
 * store produces a response before `deadline`.
 *
 * This replaces the two hand-rolled legacy-only poll loops in scheduler.ts and
 * server.ts (`createRemotePlatformRequest`) that never migrated when 4D-D
 * landed: they polled ONLY relay_inbox behind a `!hasDroppedLegacyRelayTables`
 * guard, so once slice 4E dropped the legacy tables the loop body never ran and
 * every request hung the full timeout. The exactly-once consume lifecycle
 * (claim → parse → ack) mirrors {@link readUnionResponseEntry}.
 */
export async function awaitPlatformRequestResponse(
	deps: PlatformResponseAwaitDeps,
	refId: string,
	options: { deadline: number; targetSiteId: string; pollIntervalMs?: number },
): Promise<unknown> {
	const pollIntervalMs = options.pollIntervalMs ?? 200;
	while (Date.now() < options.deadline) {
		const entry = readUnionResponseEntry(deps.db, refId, deps.siteId);
		if (entry) {
			// Deliver BEFORE ack: extract the resolution/rejection, then settle().
			// A throw path still settles first so the consumed row is retired
			// exactly once regardless of how we exit.
			if (entry.kind === "error") {
				entry.settle();
				const errPayload = JSON.parse(entry.payload) as { error?: string };
				throw new Error(errPayload.error ?? entry.payload);
			}
			const parsed = parseJsonSafe(resultPayloadSchema, entry.payload, "platform_request result");
			if (!parsed.ok) {
				entry.settle();
				throw new Error(`Invalid platform_request response: ${parsed.error}`);
			}
			entry.settle();
			return JSON.parse(parsed.value.stdout);
		}
		await new Promise((r) => setTimeout(r, pollIntervalMs));
	}
	throw new Error(`Timeout waiting for platform_request response from ${options.targetSiteId}`);
}
