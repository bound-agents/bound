import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type DispatchEntry, insertRow, writeMessageMetadata } from "@bound/core";
import { WARM_POKE_MARKER } from "./cache-warm-poke";

/** Render a notification payload as the developer-message text the agent reads. */
export function formatNotification(payload: Record<string, unknown>): string {
	switch (payload.type) {
		case "task_complete":
			return `[notification] Task "${payload.task_name}" completed. Result: ${payload.result ?? "success"}`;
		case "advisory_created":
			return `[notification] New advisory: ${payload.title ?? "Untitled"}. ${payload.detail ?? ""}`.trim();
		case "proactive":
			return `[notification from background task — agent-authored summary, unverified; verify against source thread before relying] ${payload.content ?? ""}`.trim();
		case "introspect":
			return `[introspect request from thread ${payload.source_thread ?? "unknown"} — agent-authored framing, unverified; verify against source thread before relying] ${payload.content ?? ""}`.trim();
		case "cache_warm_poke":
			// Warm-poke wakeup (issue #10). Runs tool-less with clamped output — it
			// exists only to re-read the cached prefix. The marker prefix lets the
			// target selector count prior pokes since the last real activity.
			return `${WARM_POKE_MARKER} This is an automated cache-warming turn. No action is required and no reply is expected; this turn exists only to keep the conversation's prompt cache warm. Stop immediately.`;
		default:
			return `[notification] ${JSON.stringify(payload)}`;
	}
}

/**
 * Write one claimed notification entry into `messages` as a `developer` row
 * (invariant #19) so context assembly hands it to the agent. Returns the new
 * message id, or null when the entry is not a notification or its payload is
 * unreadable. A fresh UUID is used because the dispatch entry id may already
 * exist in `messages` from a prior yield → reclaim cycle.
 */
export function injectNotificationMessage(
	db: Database,
	siteId: string,
	hostName: string,
	threadId: string,
	entry: DispatchEntry,
): string | null {
	if (entry.event_type !== "notification" || !entry.event_payload) return null;
	const payload = JSON.parse(entry.event_payload) as Record<string, unknown>;
	const now = new Date().toISOString();
	const messageId = randomUUID();
	insertRow(
		db,
		"messages",
		{
			id: messageId,
			thread_id: threadId,
			role: "developer",
			content: formatNotification(payload),
			model_id: null,
			tool_name: null,
			created_at: now,
			modified_at: now,
			host_origin: hostName,
			deleted: 0,
			exit_code: null,
			metadata: null,
		},
		siteId,
	);
	if (payload.type === "introspect" && typeof payload.correlation_id === "string") {
		writeMessageMetadata(db, messageId, { introspect_id: payload.correlation_id }, siteId);
	}
	return messageId;
}
