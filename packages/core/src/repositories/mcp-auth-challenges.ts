import type { Database } from "bun:sqlite";
import { BOUND_NAMESPACE, type Result, deterministicUUID, err, ok } from "@bound/shared";
import { insertRow, updateRow } from "../change-log";

/**
 * Repository for the synced `mcp_auth_challenges` table — an unmet OAuth
 * authorization demand for an http MCP server.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §5 (challenge
 * table), R-MO6/R-MO7/R-MO8/R-MO8a/R-MO9.
 *
 * Challenge identity is one deterministic row per `(owning site_id, MCP server
 * name)` (R-MO6): {@link challengeId} derives the row id, so a re-raise for the
 * same server flips the one existing row's `status` back to `pending` rather
 * than inserting a second row. The row carries the DEMAND, never a secret
 * (R-MO7): no `client_secret`, PKCE verifier, authorization code, or token.
 *
 * Every `status` transition is written BY THE OWNING HOST ALONE (R-MO8a);
 * resolvers never write `status`. The legal transitions and their guards live
 * in {@link markResolved} / {@link markFailed} / {@link reRaise} — `resolved` is
 * terminal-wins against every writer except the owner's own grant-death
 * re-raise. See docs/design/sync-protocol.md for the non-obvious semantics.
 */

export type ChallengeStatus = "pending" | "resolved" | "failed";

export interface McpAuthChallenge {
	id: string;
	server_name: string;
	owning_site_id: string;
	server_url: string;
	/** Space-delimited scope demand parsed from the 401/403. */
	scope_demand: string;
	/** Space-delimited scope set currently granted at raise time (empty for a first-use 401). */
	granted_scopes: string;
	/** RFC 9728 `resource_metadata` hint if the challenge advertised one, else null. */
	resource_metadata_hint: string | null;
	/** Config-declared `client_id` if any (R-MO3, non-secret), else null. */
	client_id: string | null;
	status: ChallengeStatus;
	/** Terminal OAuth error code when `status` is `failed`, else null. */
	failure_reason: string | null;
	deleted: number;
	modified_at: string;
}

/**
 * The owner-written demand fields (R-MO6). Passed to {@link raiseChallenge} and
 * {@link reRaise}; both write these from the owner's current config and its own
 * observation of the 401/403. Never carries a secret (R-MO7).
 */
export interface ChallengeDemand {
	serverName: string;
	owningSiteId: string;
	serverUrl: string;
	scopeDemand: string;
	grantedScopes: string;
	resourceMetadataHint?: string | null;
	clientId?: string | null;
}

/**
 * Deterministic challenge id for a `(owning site_id, MCP server name)` pair
 * (R-MO6). Stable across hosts and restarts, so a raise from the owner and a
 * lookup from a resolver address the same row.
 */
export function challengeId(owningSiteId: string, serverName: string): string {
	return deterministicUUID(BOUND_NAMESPACE, `mcp-auth-challenge:${owningSiteId}:${serverName}`);
}

// --- Finders -------------------------------------------------------------

/** Fetch a challenge row by its deterministic id (live rows only). */
export function findChallengeById(db: Database, id: string): McpAuthChallenge | null {
	return db
		.query("SELECT * FROM mcp_auth_challenges WHERE id = ? AND deleted = 0")
		.get(id) as McpAuthChallenge | null;
}

/**
 * Fetch a challenge row by its `(owning site_id, MCP server name)` identity.
 * Convenience over {@link challengeId} + {@link findChallengeById}.
 */
export function findChallengeByServer(
	db: Database,
	owningSiteId: string,
	serverName: string,
): McpAuthChallenge | null {
	return findChallengeById(db, challengeId(owningSiteId, serverName));
}

/** All `pending` challenges (live rows), for surfaces enumerating unmet demands. */
export function findPendingChallenges(db: Database): McpAuthChallenge[] {
	return db
		.query("SELECT * FROM mcp_auth_challenges WHERE status = 'pending' AND deleted = 0")
		.all() as McpAuthChallenge[];
}

/**
 * Like {@link findChallengeById} but INCLUDES soft-deleted rows — used by the
 * deterministic-id raise path, which must see a tombstoned row to restore it.
 */
export function findChallengeByIdIncludingDeleted(
	db: Database,
	id: string,
): McpAuthChallenge | null {
	return db
		.query("SELECT * FROM mcp_auth_challenges WHERE id = ?")
		.get(id) as McpAuthChallenge | null;
}

// --- Guarded status-transition writers (owner-only, R-MO8a) --------------

export type TransitionError =
	| { kind: "not_found" }
	| { kind: "illegal_transition"; from: ChallengeStatus; to: ChallengeStatus };

/**
 * Raise a fresh demand: insert a new `pending` challenge, or refresh an
 * existing row's demand fields and flip it back to `pending` (R-MO6, R-MO8a).
 *
 * This is the owner-only entry point for both first raise and re-raise. It
 * handles every legal path into `pending`:
 *  - no row yet → insert `pending`;
 *  - `failed → pending` (a later use raises a fresh demand, R-MO21);
 *  - `resolved → pending` (grant-death re-raise the owner itself observes, R-MO12);
 *  - already `pending` → refresh demand fields in place (R-MO6: no stale snapshot).
 *
 * A re-raise refreshes ALL demand fields (server URL, scope demand,
 * currently-granted scopes, resource_metadata hint, client_id) so a resolver
 * reads the demand as the owner sees it now, and clears `failure_reason` only
 * on the `failed → pending` edge (the prior reason is retained on the row until
 * this fresh raise per R-MO17c's "retained until the next terminal outcome" —
 * a raise IS a fresh attempt, so it clears). Returns the row's id.
 *
 * NOTE (slice 1): the R-MO10b debounce against a row already `failed` is a
 * raise-path decision that lives in the raise caller (slice 2+), not here —
 * this writer performs the transition it is asked to perform.
 */
export function raiseChallenge(db: Database, demand: ChallengeDemand, siteId: string): string {
	const id = challengeId(demand.owningSiteId, demand.serverName);
	const now = new Date().toISOString();
	const existing = findChallengeByIdIncludingDeleted(db, id);

	const fields = {
		server_name: demand.serverName,
		owning_site_id: demand.owningSiteId,
		server_url: demand.serverUrl,
		scope_demand: demand.scopeDemand,
		granted_scopes: demand.grantedScopes,
		resource_metadata_hint: demand.resourceMetadataHint ?? null,
		client_id: demand.clientId ?? null,
	};

	if (existing === null) {
		insertRow(
			db,
			"mcp_auth_challenges",
			{
				id,
				...fields,
				status: "pending",
				failure_reason: null,
				deleted: 0,
				modified_at: now,
			},
			siteId,
		);
		return id;
	}

	// Refresh demand fields, flip to pending, clear the prior failure reason,
	// and un-tombstone if the row had been soft-deleted. updateRow stamps
	// modified_at itself (LWW).
	updateRow(
		db,
		"mcp_auth_challenges",
		id,
		{
			...fields,
			status: "pending",
			failure_reason: null,
			deleted: 0,
		},
		siteId,
	);
	return id;
}

/**
 * `pending → resolved` (owner, R-MO8a). Applies on a successful code-for-token
 * exchange (R-MO20). Terminal-wins: idempotent on an already-`resolved` row,
 * refused on a `failed` row (a resolution must re-raise before it can resolve).
 */
export function markResolved(
	db: Database,
	id: string,
	siteId: string,
	opts?: { grantedScopes?: string },
): Result<void, TransitionError> {
	const row = findChallengeById(db, id);
	if (row === null) return err({ kind: "not_found" });
	if (row.status === "resolved") return ok(undefined); // idempotent (R-MO20)
	if (row.status !== "pending") {
		return err({ kind: "illegal_transition", from: row.status, to: "resolved" });
	}
	const updates: Record<string, unknown> = { status: "resolved", failure_reason: null };
	if (opts?.grantedScopes !== undefined) updates.granted_scopes = opts.grantedScopes;
	updateRow(db, "mcp_auth_challenges", id, updates, siteId);
	return ok(undefined);
}

/**
 * `pending → failed` (owner, R-MO8a). Applies only while the row is `pending`;
 * a `failed` write against a row already `resolved` is DROPPED WITHOUT EFFECT
 * (terminal-wins — a stale or concurrent attempt's failure cannot un-resolve a
 * grant). Idempotent on an already-`failed` row (refreshes `failure_reason`).
 *
 * The drop against a `resolved` row returns `ok` — it is a deliberate no-op the
 * caller need not treat as an error, exactly as the guard intends.
 */
export function markFailed(
	db: Database,
	id: string,
	failureReason: string,
	siteId: string,
): Result<void, TransitionError> {
	const row = findChallengeById(db, id);
	if (row === null) return err({ kind: "not_found" });
	if (row.status === "resolved") return ok(undefined); // terminal-wins: dropped without effect
	// pending → failed, or failed → failed (refresh reason). Both legal.
	updateRow(
		db,
		"mcp_auth_challenges",
		id,
		{ status: "failed", failure_reason: failureReason },
		siteId,
	);
	return ok(undefined);
}

/**
 * `failed → pending` or `resolved → pending` (owner, R-MO8a), refreshing the
 * demand fields (R-MO6). Thin wrapper over {@link raiseChallenge} for callers
 * that hold a demand and want the re-raise semantics named explicitly:
 *  - `failed → pending`: a later use of the server raises a fresh demand (R-MO21).
 *  - `resolved → pending`: grant-death re-raise the owner observes (R-MO12).
 *
 * Refuses (returns `illegal_transition`) if there is no existing row to
 * re-raise — a first raise must go through {@link raiseChallenge} directly, so
 * a re-raise cannot silently create a row it believes already existed.
 */
export function reRaise(
	db: Database,
	demand: ChallengeDemand,
	siteId: string,
): Result<string, TransitionError> {
	const id = challengeId(demand.owningSiteId, demand.serverName);
	const existing = findChallengeByIdIncludingDeleted(db, id);
	if (existing === null) {
		return err({ kind: "illegal_transition", from: "pending", to: "pending" });
	}
	raiseChallenge(db, demand, siteId);
	return ok(id);
}
