import type { Database } from "bun:sqlite";
import { isClientToolInterface } from "@bound/shared";

/**
 * Host-liveness window for client-session routing. Mirrors relay-router's
 * STALE_THRESHOLD_MS: a host is considered live if its heartbeat-maintained
 * `modified_at` (falling back to `online_at`) is within this window.
 */
const CLIENT_SESSION_HOST_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * True when the thread has at least one live (non-deleted) client session on
 * ANY host whose heartbeat is fresh within the staleness window — i.e. the
 * thread's client tools can run *somewhere* in the cluster right now.
 *
 * This is the host-agnostic liveness predicate that {@link
 * getClientSessionDelegationTarget} and {@link hasLocalClientSession} answer
 * partial, routing-specific slices of. Used by the notify/introspect warning
 * (issue #96): a session-less or only-stale-session boundless thread cannot
 * run its client tools until it reconnects.
 */
export function isClientSessionLive(
	db: Database,
	threadId: string,
	staleMs = CLIENT_SESSION_HOST_STALE_MS,
): boolean {
	const rows = db
		.query("SELECT site_id FROM client_sessions WHERE thread_id = ? AND deleted = 0")
		.all(threadId) as Array<{ site_id: string }>;
	if (rows.length === 0) return false;

	const cutoff = Date.now() - staleMs;
	const seen = new Set<string>();
	for (const { site_id } of rows) {
		if (seen.has(site_id)) continue;
		seen.add(site_id);
		const host = db
			.query("SELECT modified_at, online_at FROM hosts WHERE site_id = ? AND deleted = 0")
			.get(site_id) as { modified_at: string | null; online_at: string | null } | null;
		const ts = host?.modified_at ?? host?.online_at;
		if (ts && new Date(ts).getTime() >= cutoff) return true;
	}
	return false;
}

/** A client (WS) session row joined to its holding host and live-ness verdict. */
export interface ClientSessionInfo {
	threadId: string;
	siteId: string;
	hostName: string;
	threadInterface: string | null;
	live: boolean;
}

/**
 * Returns one entry per distinct (thread_id, site_id) client session, joined to
 * its holding host and tagged with a `live` verdict (host heartbeat fresh
 * within the staleness window). Soft-deleted sessions are excluded. Powers the
 * `hostinfo` tool's client-session surface (issue #96), letting the agent see
 * which threads have a live boundless session before notify/introspect.
 */
export function getClientSessions(
	db: Database,
	staleMs = CLIENT_SESSION_HOST_STALE_MS,
): ClientSessionInfo[] {
	const rows = db
		.query(
			`SELECT cs.thread_id, cs.site_id, h.host_name, h.modified_at, h.online_at, t.interface
			 FROM client_sessions cs
			 LEFT JOIN hosts h ON h.site_id = cs.site_id AND h.deleted = 0
			 LEFT JOIN threads t ON t.id = cs.thread_id AND t.deleted = 0
			 WHERE cs.deleted = 0`,
		)
		.all() as Array<{
		thread_id: string;
		site_id: string;
		host_name: string | null;
		modified_at: string | null;
		online_at: string | null;
		interface: string | null;
	}>;

	const cutoff = Date.now() - staleMs;
	const seen = new Set<string>();
	const out: ClientSessionInfo[] = [];
	for (const r of rows) {
		const dedupKey = `${r.thread_id}::${r.site_id}`;
		if (seen.has(dedupKey)) continue;
		seen.add(dedupKey);
		const ts = r.modified_at ?? r.online_at;
		const live = ts !== null && new Date(ts).getTime() >= cutoff;
		out.push({
			threadId: r.thread_id,
			siteId: r.site_id,
			hostName: r.host_name ?? r.site_id,
			threadInterface: r.interface,
			live,
		});
	}
	return out;
}

/**
 * Shared non-fatal advisory for notify/introspect (issue #96).
 *
 * When the target thread is a client-tool surface (boundless) but has no live
 * client session anywhere, the wakeup still enqueues correctly and is delivered
 * when the client reconnects — but the woken loop cannot run client tools
 * (`boundless_*`) in the meantime. Returns a warning string to append to the
 * (non-fatal) tool result, or null when no warning applies: the target is not a
 * client-tool interface, or a live session already exists.
 *
 * Deliberately non-fatal: the enqueue is correct on its own terms (the message
 * is queued, not lost), and plenty of notifies to boundless threads are purely
 * informational and never touch client tools. The warning catches attention; it
 * does not gate the write.
 */
export function clientSessionWakeupWarning(
	db: Database,
	threadId: string,
	staleMs = CLIENT_SESSION_HOST_STALE_MS,
): string | null {
	const thread = db
		.query("SELECT interface FROM threads WHERE id = ? AND deleted = 0")
		.get(threadId) as { interface: string | null } | null;
	if (!thread || !isClientToolInterface(thread.interface)) return null;
	if (isClientSessionLive(db, threadId, staleMs)) return null;
	return (
		"⚠ Target thread has no live boundless session — the message was enqueued and will be " +
		"processed when the client reconnects, but the woken loop cannot run client tools (boundless_*) " +
		"until then."
	);
}
