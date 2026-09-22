import type { Database } from "bun:sqlite";

/**
 * Requester-local durable waiter store for MCP OAuth settle-and-wake.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §7,
 * R-MO15 / R-MO16 / R-MO16b.
 *
 * When the requester host persists an `auth_challenge_raised` tool result
 * (R-MO14), it also writes a waiter record keyed `(challenge_id, thread_id)` so
 * the terminal-status wake (R-MO16) and boot-time reconciliation sweep
 * (R-MO16b) have a durable table to read. The store is requester-LOCAL — the
 * requester consumes its own record — so it never syncs (invariant #3 lane);
 * the synced challenge row is the only replicated artifact. A second settle for
 * the same pair UPSERTs (never appends), so a re-driven settle leaves exactly
 * one record. `consumed_at` fences each record to exactly-once consumption.
 *
 * These are raw reads/writes of a NON-synced table, so they are correctly
 * outside the change-log outbox (invariant #3) and the read-centralization gate.
 */

export interface McpAuthWaiter {
	challenge_id: string;
	thread_id: string;
	created_at: string;
	consumed_at: string | null;
}

/**
 * Upsert a waiter for `(challenge_id, thread_id)` (R-MO15). A re-driven settle
 * for the same pair replaces the prior record rather than appending, and RESETS
 * `consumed_at` to null — a fresh settle means the thread is waiting again (e.g.
 * a `failed → pending` re-raise re-arms the same thread on the same challenge).
 */
export function upsertWaiter(db: Database, challengeId: string, threadId: string): void {
	db.run(
		`INSERT INTO mcp_auth_waiters (challenge_id, thread_id, created_at, consumed_at)
		 VALUES (?, ?, ?, NULL)
		 ON CONFLICT (challenge_id, thread_id)
		 DO UPDATE SET created_at = excluded.created_at, consumed_at = NULL`,
		[challengeId, threadId, new Date().toISOString()],
	);
}

/** All UNCONSUMED waiters for one challenge (the wake path reads these, R-MO16). */
export function findUnconsumedWaiters(db: Database, challengeId: string): McpAuthWaiter[] {
	return db
		.query("SELECT * FROM mcp_auth_waiters WHERE challenge_id = ? AND consumed_at IS NULL")
		.all(challengeId) as McpAuthWaiter[];
}

/** Every unconsumed waiter across all challenges (the boot sweep reads these, R-MO16b). */
export function findAllUnconsumedWaiters(db: Database): McpAuthWaiter[] {
	return db
		.query("SELECT * FROM mcp_auth_waiters WHERE consumed_at IS NULL")
		.all() as McpAuthWaiter[];
}

/**
 * Mark a waiter consumed (R-MO16 exactly-once). Returns true when this call is
 * the one that flipped it from unconsumed → consumed — the caller enqueues the
 * wake only on a true return, so a concurrent or re-driven sweep that lost the
 * race does not double-enqueue (the notification idempotency fence is the
 * second line of defence, R-MO16).
 */
export function consumeWaiter(db: Database, challengeId: string, threadId: string): boolean {
	const changes = db.run(
		"UPDATE mcp_auth_waiters SET consumed_at = ? WHERE challenge_id = ? AND thread_id = ? AND consumed_at IS NULL",
		[new Date().toISOString(), challengeId, threadId],
	).changes;
	return changes === 1;
}
