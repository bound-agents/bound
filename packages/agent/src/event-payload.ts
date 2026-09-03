import type { Database } from "bun:sqlite";
import { claimDurableWorkByIds, listPendingIntakeDurableWorkForRef } from "@bound/core";
import { escapeXmlAttr } from "@bound/shared";
import type { Task } from "@bound/shared";

export interface DurableWakeupClaim {
	/** The durable_work row id that was claimed for this wakeup. */
	id: string;
	/**
	 * The fresh claim token minted for this row. The caller MUST pass
	 * `(id, token)` to `acknowledgeDurableWork` after the wakeup messages are
	 * durably persisted, so the row transitions `processing -> consumed` under
	 * its own generation. On a persistence failure the caller does NOT ack; the
	 * row stays `processing` and boot recovery resets it to `pending`.
	 */
	token: string;
}

export interface EventWakeupContent {
	/**
	 * The content string to use as the synthetic `retrieve_task` tool_result
	 * body for an event-task wakeup. When intake entries are folded in, this
	 * carries the actual webhook/connector/feed envelope(s); otherwise it falls
	 * back to the task's static payload (or a generic default).
	 */
	content: string;
	/**
	 * Legacy relay_inbox entry IDs that were folded into `content` (including
	 * the relay-side id of any twin also present in durable_work). Caller MUST
	 * pass these to `markProcessed(db, ids)` once the wakeup messages have been
	 * durably persisted, so the same envelopes don't reappear on the next
	 * wakeup. Marking is left to the caller (rather than done eagerly here) so a
	 * mid-write failure leaves the inbox unprocessed — a redundant event on a
	 * later run is strictly better than silently losing the payload.
	 */
	processedIds: string[];
	/**
	 * durable_work rows CLAIMED (pending -> processing) for this wakeup, each
	 * with its own fence token. Caller acknowledges these (-> consumed) after
	 * the same persistence point that gates `processedIds`. Empty when the
	 * durable store held no pending intake rows for the thread.
	 */
	durableClaims: DurableWakeupClaim[];
}

/**
 * A merged intake entry drawn from either store, carrying the fields the
 * envelope renderer needs plus a discriminant so the caller can split the
 * folded set back into relay ids to mark and durable claims to acknowledge.
 */
interface MergedIntakeEntry {
	received_at: string;
	kind: string;
	source_site_id: string;
	payload: string;
	/** Durable row id, present only for a durable row. */
	durableId: string | null;
}

const DEFAULT_FALLBACK = "Execute scheduled task.";

/**
 * #177: webhook envelopes are stored as a JSON string whose `body` field holds
 * the raw request body verbatim (see `webhook-handler.ts`). For JSON webhooks
 * (GitHub, Stripe, …) that body is itself JSON, so it lands double-escaped
 * inside the envelope — every quote in the event becomes `\"` on the wire,
 * inflating the wakeup with escape noise the model has to mentally un-escape.
 *
 * Parse the envelope and, when its `body` is a JSON string, inline the parsed
 * value so the wakeup carries structured JSON rather than an escaped blob.
 * Provider-agnostic: keyed only on the envelope's own `body` field, with no
 * webhook-source-specific knowledge. Anything that doesn't fit the shape —
 * a payload that isn't JSON, an envelope without a string `body`, or a body
 * that isn't itself JSON (form-encoded, plain text) — is returned verbatim, so
 * this can only ever reduce bloat, never lose or corrupt a payload.
 */
function inlineWebhookEnvelopeBody(rawPayload: string): string {
	let envelope: unknown;
	try {
		envelope = JSON.parse(rawPayload);
	} catch {
		return rawPayload; // not JSON — leave verbatim
	}
	if (
		envelope === null ||
		typeof envelope !== "object" ||
		Array.isArray(envelope) ||
		typeof (envelope as Record<string, unknown>).body !== "string"
	) {
		return rawPayload; // not the envelope shape we fold
	}
	const env = envelope as Record<string, unknown>;
	let parsedBody: unknown;
	try {
		parsedBody = JSON.parse(env.body as string);
	} catch {
		return rawPayload; // body isn't JSON — nothing to un-nest
	}
	// A body that parses to a bare scalar ("ok", 42, true) gains nothing from
	// inlining and would lose its string-ness; only fold structured values.
	if (parsedBody === null || typeof parsedBody !== "object") {
		return rawPayload;
	}
	return JSON.stringify({ ...env, body: parsedBody });
}

/**
 * Builds wakeup content for an event task, folding in pending passive-intake
 * rows for the task's thread from BOTH durable stores: the legacy `relay_inbox`
 * (webhook intake pipeline in packages/web/src/server/webhook-handler.ts and
 * the connector/RSS pollers, which write envelopes keyed by
 * `ref_id = thread_id` and emit a `connector:event`) and the new `durable_work`
 * intake rows (4C-1). This is slice 4C-2: producers still write only to
 * relay_inbox today, but the fold reads the union so 4C-3 can flip producers to
 * durable_work without a scheduler change.
 *
 * Without this helper, scheduler.ts falls back to
 * `task.payload ?? "Execute scheduled task."`, which for webhook-
 * triggered tasks is just the default — leaving the agent with no idea
 * what fired the webhook and forcing it to do context archaeology over
 * GitHub / MCP to reconstruct the event. Observed in production: a
 * GitHub issue webhook fired and the agent had to guess what triggered it.
 *
 * Non-event task types (cron, deferred, heartbeat) do NOT consume the
 * inbox — they have their own wakeup paths and shouldn't be hijacked
 * by stray intake entries that happen to share a thread_id.
 *
 * Both reads scope to the passive intake kinds (webhook_intake,
 * connector_intake, rss_intake) owned by this consumer. Without the kind
 * filter, stray rows of other intake-shaped kinds sharing a `ref_id` could be
 * opaquely folded into the wakeup as if they were event envelopes — the
 * payload schemas are not interchangeable.
 *
 * TWIN DEDUPE: during the 4C-3 producer flip a single event can momentarily
 * exist in both stores under the same `(kind, idempotency_key)`. Such twins
 * fold ONCE, preferring the durable row; the relay twin's id still enters the
 * mark-processed set so it can never re-fold on a later wakeup.
 *
 * The claim is taken here (pending -> processing, one fresh token per row) so
 * that folding and ownership are a single decision. The caller acknowledges
 * (-> consumed) only after the wakeup messages persist; a mid-write failure
 * leaves the rows `processing` for boot recovery to reset.
 */
export function buildEventWakeupContent(
	db: Database,
	task: Task,
	targetSiteId: string,
): EventWakeupContent {
	const fallback = task.payload ?? DEFAULT_FALLBACK;

	if (task.type !== "event" || !task.thread_id) {
		return { content: fallback, processedIds: [], durableClaims: [] };
	}
	const threadId = task.thread_id;

	// Passive intake rows for this thread ride the durable_work spool (4C-1
	// reader; already scoped to the passive intake kinds and ordered by
	// received/created time). Legacy relay_inbox intake is retired (release N+1).

	// Pending durable_work intake rows for this thread (4C-1 reader; already
	// scoped to the passive intake kinds and ordered by received/created time).
	const durableRows = listPendingIntakeDurableWorkForRef(db, threadId);

	const merged: MergedIntakeEntry[] = [];
	for (const row of durableRows) {
		merged.push({
			// received_at is nullable on durable_work; fall back to created_at so
			// ordering stays total, matching the repository reader's COALESCE.
			received_at: row.received_at ?? row.created_at,
			kind: row.kind,
			source_site_id: row.source_site ?? "",
			payload: row.payload,
			durableId: row.id,
		});
	}

	if (merged.length === 0) {
		return { content: fallback, processedIds: [], durableClaims: [] };
	}

	// Order the union oldest-first by received time across both stores, so
	// multiple deliveries interleave chronologically regardless of which store
	// they landed in.
	merged.sort((a, b) =>
		a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0,
	);

	// Claim the durable rows we're about to fold (pending -> processing) under a
	// fresh per-row token. Ordering is preserved: we already have the rows; the
	// claim only stamps ownership. A row that lost its pending state between the
	// list and the claim is dropped from the fold so we never present an event
	// we can't acknowledge.
	const durableIdsToClaim = merged
		.map((entry) => entry.durableId)
		.filter((id): id is string => id !== null);
	const claimedRows = claimDurableWorkByIds(db, durableIdsToClaim, targetSiteId);
	const claimTokenById = new Map(claimedRows.map((row) => [row.id, row.claim_token as string]));
	const folded = merged.filter(
		(entry) => entry.durableId === null || claimTokenById.has(entry.durableId),
	);

	if (folded.length === 0) {
		// Every durable candidate slipped away between the list and the claim.
		return { content: fallback, processedIds: [], durableClaims: [] };
	}

	const triggerSpec = task.trigger_spec || "(unspecified)";

	// Wrap the folded envelopes in a dedicated connector-specific XML envelope:
	// a `<connector-events>` parent carrying the shared trigger + event count,
	// with each intake entry as its own `<event>` node. Per-event attributes are
	// drawn straight from the immutable intake row (received time, relay/durable
	// kind, originating site), so the agent can reason over provenance without
	// re-deriving it. This mirrors the structural shape of the per-user-message
	// `<user-message>` envelope and the volatile-context `<volatile-context>`
	// envelope (kebab-case tags, attribute-escaped via escapeXmlAttr).
	//
	// Attribute values route through escapeXmlAttr because the trigger spec is
	// task-defined and may contain quotes/`<`/`&`. The event BODY is left raw —
	// it's the #177-inlined webhook payload (typically JSON), meant to read
	// directly, and escaping it would resurrect the double-escape noise #177
	// removed. The body is a function of the row, so the wakeup stays stable.
	const eventNodes = folded
		.map((entry, i) => {
			const attrs = [
				`index="${i + 1}"`,
				`received="${escapeXmlAttr(entry.received_at)}"`,
				`kind="${escapeXmlAttr(entry.kind)}"`,
				`source-site="${escapeXmlAttr(entry.source_site_id)}"`,
			].join(" ");
			return `<event ${attrs}>\n${inlineWebhookEnvelopeBody(entry.payload)}\n</event>`;
		})
		.join("\n");

	const envelope = `<connector-events trigger="${escapeXmlAttr(triggerSpec)}" count="${folded.length}">\n${eventNodes}\n</connector-events>`;

	const standing = task.payload ? `\n\nStanding task payload:\n${task.payload}` : "";

	// No relay ids to mark processed after the release-N+1 demolition — the
	// durable claims below are the sole acknowledgment path.
	const processedIds: string[] = [];
	const durableClaims: DurableWakeupClaim[] = folded
		.filter((entry) => entry.durableId !== null)
		.map((entry) => ({
			id: entry.durableId as string,
			token: claimTokenById.get(entry.durableId as string) as string,
		}));

	return {
		content: `${envelope}${standing}`,
		processedIds,
		durableClaims,
	};
}
