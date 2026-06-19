import type { Database } from "bun:sqlite";
import { readUnprocessedInboxByRefId } from "@bound/core";
import type { Task } from "@bound/shared";

export interface EventWakeupContent {
	/**
	 * The content string to use as the synthetic `retrieve_task` tool_result
	 * body for an event-task wakeup. When inbox entries are folded in, this
	 * carries the actual webhook envelope(s); otherwise it falls back to the
	 * task's static payload (or a generic default).
	 */
	content: string;
	/**
	 * Inbox entry IDs that were folded into `content`. Caller MUST pass these
	 * to `markProcessed(db, ids)` once the wakeup messages have been durably
	 * persisted, so the same envelopes don't reappear on the next wakeup.
	 * Marking is left to the caller (rather than done eagerly here) so a
	 * mid-write failure leaves the inbox unprocessed — redundant event on a
	 * later run is strictly better than silently losing the payload.
	 */
	processedIds: string[];
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
 * Builds wakeup content for an event task, folding in any pending
 * relay_inbox envelopes for the task's thread (the path used by the
 * webhook intake pipeline in packages/web/src/server/webhook-handler.ts,
 * which writes envelopes keyed by `ref_id = webhook.thread_id` and
 * emits a `connector:event` to nudge the scheduler).
 *
 * Without this helper, scheduler.ts falls back to
 * `task.payload ?? "Execute scheduled task."`, which for webhook-
 * triggered tasks is just the default — leaving the agent with no idea
 * what fired the webhook and forcing it to do context archaeology over
 * GitHub / MCP to reconstruct the event. Observed on 2026-05-18 in
 * thread d0372be6 when Kara's GitHub issue webhook fired and the agent
 * had to guess what triggered it.
 *
 * Non-event task types (cron, deferred, heartbeat) do NOT consume the
 * inbox — they have their own wakeup paths and shouldn't be hijacked
 * by stray intake entries that happen to share a thread_id.
 *
 * The inbox query filters on `kind="webhook_intake"` (a passive relay
 * kind owned by this consumer). Without the kind filter, stray rows
 * of other intake-shaped kinds sharing a `ref_id` could be opaquely
 * folded into the wakeup as if they were webhook envelopes — the
 * payload schemas are not interchangeable.
 */
export function buildEventWakeupContent(db: Database, task: Task): EventWakeupContent {
	const fallback = task.payload ?? DEFAULT_FALLBACK;

	if (task.type !== "event" || !task.thread_id) {
		return { content: fallback, processedIds: [] };
	}

	const entries = readUnprocessedInboxByRefId(db, task.thread_id, "webhook_intake");
	if (entries.length === 0) {
		return { content: fallback, processedIds: [] };
	}

	const triggerSpec = task.trigger_spec || "(unspecified)";
	const header =
		entries.length === 1
			? `[Event trigger fired] ${triggerSpec} — 1 envelope delivered:`
			: `[Event trigger fired] ${triggerSpec} — ${entries.length} envelopes delivered (oldest first):`;

	const body = entries
		.map((entry, i) => {
			const heading =
				entries.length === 1
					? `Envelope (received ${entry.received_at}):`
					: `Envelope ${i + 1} of ${entries.length} (received ${entry.received_at}):`;
			return `${heading}\n${inlineWebhookEnvelopeBody(entry.payload)}`;
		})
		.join("\n\n");

	const standing = task.payload ? `\n\nStanding task payload:\n${task.payload}` : "";

	return {
		content: `${header}\n\n${body}${standing}`,
		processedIds: entries.map((e) => e.id),
	};
}
