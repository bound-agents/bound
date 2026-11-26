import type { Database } from "bun:sqlite";
import { claimDurableWorkByIds, listPendingIntakeDurableWorkForRef } from "@bound/core";
import { escapeXmlAttr } from "@bound/shared";
import type { Task } from "@bound/shared";

interface DurableWakeupClaim {
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
	 * durable_work rows claimed (pending -> processing) for this wakeup, each
	 * with its own fence token. The caller acknowledges these (-> consumed)
	 * once the wakeup messages have been durably persisted, so a mid-write
	 * failure leaves the rows unconsumed: a redundant event on a later run is
	 * strictly better than silently losing the payload. Empty when the spool
	 * held no pending intake rows for the thread.
	 */
	durableClaims: DurableWakeupClaim[];
}

interface IntakeEntry {
	received_at: string;
	kind: string;
	source_site_id: string;
	payload: string;
	durableId: string;
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
 * Builds wakeup content for an event task, folding in the pending passive-intake
 * durable_work rows for the task's thread. Producers (the webhook handler and
 * the connector/RSS pollers) write intake rows keyed by `ref_id = thread_id`
 * and emit a `connector:event`.
 *
 * Non-event task types (cron, deferred, heartbeat) do not consume intake: they
 * have their own wakeup paths and must not be hijacked by stray intake rows that
 * happen to share a thread_id.
 *
 * The read is scoped to the passive intake kinds (webhook_intake,
 * connector_intake, rss_intake) owned by this consumer. Rows of other
 * intake-shaped kinds sharing a `ref_id` have non-interchangeable payload
 * schemas and must not be folded in as event envelopes.
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
		return { content: fallback, durableClaims: [] };
	}
	const threadId = task.thread_id;

	const durableRows = listPendingIntakeDurableWorkForRef(db, threadId);

	const merged: IntakeEntry[] = [];
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
		return { content: fallback, durableClaims: [] };
	}

	// Oldest-first by received time.
	merged.sort((a, b) =>
		a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0,
	);

	// Claim the durable rows we're about to fold (pending -> processing) under a
	// fresh per-row token. Ordering is preserved: we already have the rows; the
	// claim only stamps ownership. A row that lost its pending state between the
	// list and the claim is dropped from the fold so we never present an event
	// we can't acknowledge.
	const claimedRows = claimDurableWorkByIds(
		db,
		merged.map((entry) => entry.durableId),
		targetSiteId,
	);
	const claimTokenById = new Map(claimedRows.map((row) => [row.id, row.claim_token as string]));
	const folded = merged.filter((entry) => claimTokenById.has(entry.durableId));

	if (folded.length === 0) {
		return { content: fallback, durableClaims: [] };
	}

	const triggerSpec = task.trigger_spec || "(unspecified)";

	// Wrap the folded envelopes in a dedicated connector-specific XML envelope:
	// a `<connector-events>` parent carrying the shared trigger + event count,
	// with each intake entry as its own `<event>` node. Per-event attributes are
	// drawn straight from the immutable intake row (received time, kind,
	// originating site), so the agent can reason over provenance without
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

	const durableClaims: DurableWakeupClaim[] = folded.map((entry) => ({
		id: entry.durableId,
		token: claimTokenById.get(entry.durableId) as string,
	}));

	return {
		content: `${envelope}${standing}`,
		durableClaims,
	};
}
