import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { insertInbox } from "@bound/core";
import type { Webhook } from "@bound/shared";
import { validateWebhookSignature } from "./webhook-hmac.js";

export interface WebhookHandlerDeps {
	db: Database;
	siteId: string;
}

/**
 * Handles incoming webhook POST requests.
 * Validates signature, writes relay_inbox entry, and returns appropriate HTTP response.
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

	// Read raw body bytes (must happen before any other processing)
	let rawBody: Buffer;
	try {
		const arrayBuffer = await request.arrayBuffer();
		rawBody = Buffer.from(arrayBuffer);
	} catch {
		return new Response("", { status: 400 });
	}

	// Reject empty body
	if (rawBody.length === 0) {
		return new Response("", { status: 400 });
	}

	// Look up webhook in database
	const webhook = deps.db
		.prepare("SELECT * FROM webhooks WHERE name = ? AND deleted = 0")
		.get(name) as Webhook | undefined;

	if (!webhook) {
		return new Response("", { status: 404 });
	}

	// Validate signature
	const validationResult = validateWebhookSignature(
		webhook.signature_format,
		webhook.secret,
		request.headers,
		rawBody,
	);

	if (!validationResult.valid) {
		return new Response("", { status: 401 });
	}

	// Build envelope with filtered headers
	const envelope = JSON.stringify({
		method: "POST",
		path: `/webhook/${name}`,
		headers: filterHeaders(request.headers),
		content_type: request.headers.get("content-type") || "application/octet-stream",
		body: rawBody.toString("utf-8"),
	});

	// Write relay_inbox entry
	const inboxEntry = {
		id: randomUUID(),
		source_site_id: deps.siteId,
		kind: "intake" as const,
		ref_id: webhook.thread_id,
		idempotency_key: null,
		stream_id: null,
		payload: envelope,
		expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
		received_at: new Date().toISOString(),
		processed: 0,
	};

	insertInbox(deps.db, inboxEntry);

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
