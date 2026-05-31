import type { Database } from "bun:sqlite";
import type { ModelRouter } from "@bound/llm";
import { isClientToolInterface } from "@bound/shared";
import { resolveModel } from "./model-resolution.js";
import type { EligibleHost } from "./relay-router.js";

/**
 * Returns the counts of recent tool calls in a thread.
 * Tool names are stored in messages.tool_name (e.g., "server-toolName").
 */
export function getRecentToolCalls(
	db: Database,
	threadId: string,
	limit = 20,
): { toolName: string; count: number }[] {
	const rows = db
		.query(
			`SELECT tool_name, COUNT(*) as count
			 FROM messages
			 WHERE thread_id = ? AND tool_name IS NOT NULL
			 GROUP BY tool_name
			 ORDER BY MAX(created_at) DESC
			 LIMIT ?`,
		)
		.all(threadId, limit) as Array<{ tool_name: string; count: number }>;

	return rows.map((r) => ({ toolName: r.tool_name, count: r.count }));
}

/**
 * Determines whether to delegate the agent loop to a remote host.
 *
 * Returns the target EligibleHost if all AC6.1 conditions hold:
 * 1. Model resolves to a single remote host
 * 2. That host has ≥50% of the thread's recent tool calls in its mcp_tools
 *
 * Returns null to run locally (AC6.5).
 */
export function getDelegationTarget(
	db: Database,
	threadId: string,
	modelId: string | undefined,
	modelRouter: ModelRouter,
	localSiteId: string,
): EligibleHost | null {
	const resolution = resolveModel(modelId, modelRouter, db, localSiteId);

	// Condition 1: model must be remote
	if (resolution.kind !== "remote") return null;

	// Condition 1b: exactly one host has the model
	if (resolution.hosts.length !== 1) return null;

	const targetHost = resolution.hosts[0];

	// Condition 2: ≥50% of recent tools on that host
	const recentTools = getRecentToolCalls(db, threadId, 20);
	const totalToolCalls = recentTools.reduce((sum, t) => sum + t.count, 0);

	// AC6.7: vacuous match — no tool call history → delegate
	if (totalToolCalls === 0) return targetHost;

	// Look up target host's mcp_tools
	const hostRow = db
		.query("SELECT mcp_tools FROM hosts WHERE site_id = ? AND deleted = 0")
		.get(targetHost.site_id) as { mcp_tools: string | null } | null;

	if (!hostRow?.mcp_tools) return null; // Host has no tools — can't match 50%

	let targetMcpTools: string[];
	try {
		targetMcpTools = JSON.parse(hostRow.mcp_tools);
	} catch {
		return null;
	}

	const targetToolCalls = recentTools
		.filter((t) => targetMcpTools.includes(t.toolName))
		.reduce((sum, t) => sum + t.count, 0);

	if (targetToolCalls / totalToolCalls < 0.5) return null; // AC6.5: condition unmet

	return targetHost;
}

/**
 * Host-liveness window for client-session routing. Mirrors relay-router's
 * STALE_THRESHOLD_MS: a host is considered live if its heartbeat-maintained
 * `modified_at` (falling back to `online_at`) is within this window.
 */
const CLIENT_SESSION_HOST_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the remote host holding a live client (WS) session for this thread,
 * when a notify/introspect wakeup should be delegated there so the woken loop
 * can supply the thread's client tools (issue #91, invariant #21).
 *
 * The loop MUST run on the host that holds the WS connection — client tool
 * calls defer over that host's local event bus + dispatch queue, which cannot
 * be reached cross-host. So when a session lives on another live host, the
 * wakeup is delegated there (the receiving `runDelegatedLoop` resolves client
 * tools from its own `wsRegistry`).
 *
 * Returns null — meaning "do not session-delegate; run locally or fall through
 * to model-based delegation" — when:
 * - no client session exists for the thread, OR
 * - a session exists on the LOCAL host (the tools resolve here already), OR
 * - the only sessions are on remote hosts that look stale/offline (avoids
 *   delegating into a black hole; falls back to current tool-less local
 *   behavior, which is strictly no worse than the pre-fix state).
 */
export function getClientSessionDelegationTarget(
	db: Database,
	threadId: string,
	localSiteId: string,
	staleMs = CLIENT_SESSION_HOST_STALE_MS,
): EligibleHost | null {
	const rows = db
		.query("SELECT site_id FROM client_sessions WHERE thread_id = ? AND deleted = 0")
		.all(threadId) as Array<{ site_id: string }>;
	if (rows.length === 0) return null;

	// A session on this host means client tools resolve locally — run here.
	if (rows.some((r) => r.site_id === localSiteId)) return null;

	// Prefer a remote host whose heartbeat is fresh. Dedup site_ids so a thread
	// with several connections on the same host is checked once.
	const cutoff = Date.now() - staleMs;
	const seen = new Set<string>();
	for (const { site_id } of rows) {
		if (seen.has(site_id)) continue;
		seen.add(site_id);
		const host = db
			.query(
				"SELECT host_name, sync_url, modified_at, online_at FROM hosts WHERE site_id = ? AND deleted = 0",
			)
			.get(site_id) as {
			host_name: string | null;
			sync_url: string | null;
			modified_at: string | null;
			online_at: string | null;
		} | null;
		const ts = host?.modified_at ?? host?.online_at;
		if (ts && new Date(ts).getTime() >= cutoff) {
			return {
				site_id,
				host_name: host?.host_name ?? site_id,
				sync_url: host?.sync_url ?? null,
				online_at: host?.online_at ?? null,
				modified_at: host?.modified_at ?? null,
			};
		}
	}
	return null;
}

/**
 * True when a live (non-deleted) client session for this thread exists on the
 * local host. When this holds, the loop MUST run locally — client tools defer
 * over this host's event bus — so model-based delegation must be suppressed,
 * even if the thread's model resolves to a remote host (issue #91). Pairs with
 * {@link getClientSessionDelegationTarget}, which only answers "delegate
 * elsewhere?" and returns null for both the local-session and no-session cases.
 */
export function hasLocalClientSession(
	db: Database,
	threadId: string,
	localSiteId: string,
): boolean {
	const row = db
		.query(
			"SELECT 1 FROM client_sessions WHERE thread_id = ? AND site_id = ? AND deleted = 0 LIMIT 1",
		)
		.get(threadId, localSiteId) as { 1: number } | null;
	return row !== null;
}

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
