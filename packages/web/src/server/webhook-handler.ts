import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { findClusterConfigValueByKey, findWebhookByName, insertInbox } from "@bound/core";
import { WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY } from "@bound/shared";
import type { TypedEventEmitter, Webhook } from "@bound/shared";
import { validateWebhookSignature } from "./webhook-hmac.js";

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export interface WebhookHandlerDeps {
	db: Database;
	siteId: string;
	eventBus?: TypedEventEmitter;
}

/**
 * Extract delivery ID from platform-specific headers for deduplication.
 * Checks for known delivery headers (GitHub, Stripe, generic).
 * Returns null if no delivery header is found.
 */
function extractDeliveryId(headers: Headers): string | null {
	// Check GitHub delivery header
	const githubDelivery = headers.get("x-github-delivery");
	if (githubDelivery) return `github-${githubDelivery}`;

	// Check Stripe idempotency key
	const stripeIdempotency = headers.get("stripe-idempotency-key");
	if (stripeIdempotency) return `stripe-${stripeIdempotency}`;

	// Check generic idempotency key header
	const genericId = headers.get("x-idempotency-key");
	if (genericId) return `generic-${genericId}`;

	// No delivery header found
	return null;
}

async function readRequestBodyLimited(request: Request): Promise<
	| {
			ok: true;
			body: Buffer;
	  }
	| {
			ok: false;
			status: 400 | 413;
	  }
> {
	const contentLength = request.headers.get("content-length");
	if (contentLength && /^\d+$/.test(contentLength)) {
		const declaredLength = Number.parseInt(contentLength, 10);
		if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
			return { ok: false, status: 413 };
		}
	}

	if (!request.body) {
		return { ok: true, body: Buffer.alloc(0) };
	}

	const reader = request.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_WEBHOOK_BODY_BYTES) {
				await reader.cancel();
				return { ok: false, status: 413 };
			}
			chunks.push(Buffer.from(value));
		}
	} catch {
		return { ok: false, status: 400 };
	}

	return { ok: true, body: Buffer.concat(chunks, total) };
}

/**
 * Handles incoming webhook POST requests.
 * Validates signature, writes relay_inbox entry, emits events for scheduler triggering,
 * and returns appropriate HTTP response.
 */
export async function handleWebhookRequest(
	request: Request,
	name: string,
	deps: WebhookHandlerDeps,
): Promise<Response> {
	// Only allow POST
	if (request.method !== "POST") {
		return new Response("Not found", { status: 404 });
	}

	// Look up webhook in database
	const webhook = findWebhookByName(deps.db, name) as Webhook | null;

	if (!webhook) {
		return new Response("", { status: 404 });
	}

	// Read raw body bytes after webhook lookup so unknown names cannot force
	// memory work, and cap streaming reads before HMAC validation.
	//
	// Every rejection observable without the webhook secret returns 404 so the
	// response cannot be used to distinguish a real webhook name from an unknown
	// one (empty/oversized/unreadable body and bad signature all look identical
	// to a non-existent name). Only a valid signature produces a non-404
	// response. The body read still happens after the name lookup so unknown
	// names short-circuit before any streaming work.
	const readResult = await readRequestBodyLimited(request);
	if (!readResult.ok) {
		return new Response("", { status: 404 });
	}
	const rawBody = readResult.body;

	// Reject empty body
	if (rawBody.length === 0) {
		return new Response("", { status: 404 });
	}

	// "none" format webhooks skip HMAC entirely and are gated behind the
	// cluster-wide kill switch (#195). Re-check live on every delivery (not
	// just at creation time) so flipping the switch off immediately stops
	// delivery to a "none" webhook that was created while it was on, with no
	// restart required. Every other rejection in this handler returns an
	// identical 404 to avoid a name-enumeration oracle; mirror that here.
	if (webhook.signature_format === "none") {
		const allowUnauthenticated = findClusterConfigValueByKey(
			deps.db,
			WEBHOOKS_ALLOW_UNAUTHENTICATED_KEY,
		);
		if (allowUnauthenticated?.value !== "true") {
			return new Response("", { status: 404 });
		}
	} else {
		// Validate signature
		const validationResult = validateWebhookSignature(
			webhook.signature_format,
			webhook.secret,
			request.headers,
			rawBody,
		);

		if (!validationResult.valid) {
			return new Response("", { status: 404 });
		}
	}

	// Build envelope with filtered headers
	const envelope = JSON.stringify({
		method: "POST",
		path: `/webhook/${name}`,
		headers: filterHeaders(request.headers),
		content_type: request.headers.get("content-type") || "application/octet-stream",
		body: rawBody.toString("utf-8"),
	});

	// Extract delivery ID for deduplication, or generate unique ID
	const deliveryId = extractDeliveryId(request.headers);
	const idempotencyKey = deliveryId ?? `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`;

	// Write relay_inbox entry. `webhook_intake` is a passive relay kind — the
	// row is a durable mailbox entry owned by the scheduler's event-task
	// wakeup path (buildEventWakeupContent), NOT the relay-processor's
	// dispatcher. Using a discriminated kind prevents the relay-processor
	// from picking up the row, failing to parse the HTTP envelope as the
	// MCP-platform `intakePayloadSchema`, and silently markProcessed-ing it
	// before the scheduler ever sees it. See RELAY_KIND_REGISTRY in
	// @bound/shared types.ts for the full dispatch-mode contract.
	const inboxEntry = {
		id: randomUUID(),
		source_site_id: deps.siteId,
		kind: "webhook_intake" as const,
		ref_id: webhook.thread_id,
		idempotency_key: idempotencyKey,
		stream_id: null,
		payload: envelope,
		expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
		received_at: new Date().toISOString(),
		processed: 0,
		trace_context: null,
	};

	const inserted = insertInbox(deps.db, inboxEntry);
	if (!inserted) {
		return new Response("", { status: 202 });
	}

	// Emit connector:event to trigger scheduler
	if (deps.eventBus) {
		deps.eventBus.emit("connector:event", {
			trigger_key: `webhook:${name}`,
			handle_id: webhook.id,
			task_id: webhook.task_id,
			batch_size: 1,
		});
	}

	return new Response("", { status: 202 });
}

/**
 * Filter headers for webhook envelope.
 * Includes: event-type headers, content-type, delivery IDs.
 * Excludes: signature headers, host, connection, content-length, accept-encoding.
 */
function filterHeaders(headers: Headers): Record<string, string> {
	const filtered: Record<string, string> = {};

	// Event-type headers to include
	const eventTypePatterns = [/^x-github-/, /^x-stripe-event/, /^x-slack-request-timestamp$/];

	// Headers to exclude (signature, transport, cache)
	const excludePatterns = [
		/^x-hub-signature/,
		/^x-webhook-signature$/,
		/^stripe-signature$/,
		/^x-slack-signature$/,
		/^host$/,
		/^connection$/,
		/^content-length$/,
		/^accept-encoding$/,
	];

	for (const [key, value] of headers) {
		const lowerKey = key.toLowerCase();

		// Check if should be excluded
		if (excludePatterns.some((pattern) => pattern.test(lowerKey))) {
			continue;
		}

		// Check if matches event-type pattern or is content-type
		if (
			lowerKey === "content-type" ||
			eventTypePatterns.some((pattern) => pattern.test(lowerKey))
		) {
			filtered[lowerKey] = value;
		}
	}

	return filtered;
}
