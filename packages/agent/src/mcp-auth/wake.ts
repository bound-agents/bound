import type { Database } from "bun:sqlite";
import { type McpAuthChallenge, findChallengeById } from "@bound/core";
import type { TypedEventEmitter } from "@bound/shared";
import type { TopologyRole } from "../topology";
import { routeNotificationWakeup } from "../wakeup-routing";
import { consumeWaiter, findAllUnconsumedWaiters, findUnconsumedWaiters } from "./waiters";

/**
 * Settle-and-wake for MCP OAuth challenges — the requester-side wake path.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §7,
 * R-MO16 / R-MO16b.
 *
 * When a synced challenge row reaches a TERMINAL status (`resolved` or
 * `failed`), the requester consumes its local waiter records for that challenge
 * and wakes each waiting thread. The wake rides `routeNotificationWakeup` (NOT a
 * bare local enqueue) so a thread whose live session is on another host wakes
 * there — a local-only enqueue on the wrong host mints the #91 detached loop.
 * The wake is idempotent per `(challenge_id, thread_id)` via the notification
 * fence (key `challenge-wake:<challenge_id>:<thread_id>`), and each waiter record
 * is consumed exactly once. The wake is a `developer`-role INVITATION (not a
 * directive): the model judges in the woken turn whether re-issuing the call
 * still serves the thread.
 */

/** The developer-role wake payload the woken turn receives. */
export interface McpAuthWakePayload {
	notification_id: string;
	role: "developer";
	event_type: "mcp_auth_resolution";
	text: string;
}

/**
 * Format the wake message (R-MO16). On `resolved`, invite re-issuing the call.
 * On `failed`, name the challenge and its `failure_reason` and DISTINGUISH a
 * step-up denial (a prior narrower grant is intact and still serving calls, so
 * the failure_reason travels against a non-empty `granted_scopes`) from a
 * no-grant-at-all failure (`granted_scopes` empty — the server stays
 * unauthenticated). Invitation phrasing, never a directive.
 */
export function formatWakeText(challenge: McpAuthChallenge): string {
	const server = `"${challenge.server_name}"`;
	if (challenge.status === "resolved") {
		return [
			`Authorization for MCP server ${server} resolved (challenge ${challenge.id}).`,
			"If the call that raised this challenge still serves this thread, you may re-issue it now — it will run authenticated.",
			"If the conversation has moved on, no action is needed.",
		].join("\n");
	}
	// failed
	const reason = challenge.failure_reason ?? "unknown error";
	const stepUpDenial = challenge.granted_scopes.trim().length > 0;
	const distinction = stepUpDenial
		? `A narrower grant obtained earlier remains intact and is still serving calls; only the requested scope step-up was refused (scopes held: ${challenge.granted_scopes}).`
		: "The server remains unauthenticated — no grant was obtained.";
	return [
		`Authorization for MCP server ${server} failed (challenge ${challenge.id}): ${reason}.`,
		distinction,
		"The demand cannot be met as raised. This is an answer, not a pending state — the thread need not keep waiting on this challenge. Consider whether the work can proceed without the authenticated call, or whether a different demand is worth raising.",
	].join("\n");
}

/**
 * Wake every thread waiting on one challenge that has reached a terminal status
 * (R-MO16). Consumes each waiter exactly once and routes an idempotent wake. A
 * no-op for a non-terminal challenge or one with no waiters. Returns the count
 * of threads woken.
 */
export function wakeWaitersForChallenge(
	db: Database,
	eventBus: TypedEventEmitter,
	localSiteId: string,
	challengeId: string,
	topologyRole?: TopologyRole,
): number {
	const challenge = findChallengeById(db, challengeId);
	if (challenge === null || challenge.status === "pending") return 0;

	const waiters = findUnconsumedWaiters(db, challengeId);
	let woken = 0;
	for (const waiter of waiters) {
		// Exactly-once consume: only the winner enqueues (the notification fence is
		// the second line of defence for a cross-host waiter collapse, R-MO16).
		if (!consumeWaiter(db, challengeId, waiter.thread_id)) continue;
		const idempotencyKey = `challenge-wake:${challengeId}:${waiter.thread_id}`;
		const payload: Record<string, unknown> = {
			notification_id: idempotencyKey,
			role: "developer",
			event_type: "mcp_auth_resolution",
			text: formatWakeText(challenge),
			idempotency_key: idempotencyKey,
		};
		routeNotificationWakeup(db, eventBus, localSiteId, waiter.thread_id, payload, topologyRole);
		woken += 1;
	}
	return woken;
}

/**
 * Boot-time reconciliation sweep (R-MO16b): read every unconsumed waiter, and
 * for any whose challenge is ALREADY terminal, enqueue the same wake — so a
 * requester restart during the consent window loses no wake. Each record is
 * consumed exactly once; the notification fence collapses a re-driven record to
 * one delivered wake. Returns the count of threads woken.
 */
export function reconcileWaitersOnBoot(
	db: Database,
	eventBus: TypedEventEmitter,
	localSiteId: string,
	topologyRole?: TopologyRole,
): number {
	const waiters = findAllUnconsumedWaiters(db);
	// Group by challenge so we look each row up once.
	const byChallenge = new Set(waiters.map((w) => w.challenge_id));
	let woken = 0;
	for (const challengeId of byChallenge) {
		woken += wakeWaitersForChallenge(db, eventBus, localSiteId, challengeId, topologyRole);
	}
	return woken;
}
