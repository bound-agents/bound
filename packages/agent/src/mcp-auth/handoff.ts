import type { Database } from "bun:sqlite";
import { LOCAL_WORK_TARGET, insertDurableWork } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import type { ResolverAttempt } from "./resolver";

/**
 * Resolver → owner code+outcome handoff over the durable_work spool.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §8, R-MO19.
 *
 * The resolver, having caught and state-correlated an authorize-leg outcome,
 * writes ONE peer-targeted `durable_work` row (kind `mcp_auth_handoff`) to the
 * owning host carrying the authorization code, the PKCE verifier, the exact
 * `redirect_uri`, the canonical RFC 8707 `resource`, the `issuer`, and the
 * registration `client_id` (NEVER a `client_secret`, R-MO30; NEVER a token,
 * R-MO29). A self-owned challenge targets `LOCAL_WORK_TARGET` and is consumed
 * in-process with no peer hop.
 *
 * The idempotency key is deterministic PER ATTEMPT (challenge + state), so a
 * re-driven handoff for the same attempt dedupes at the durable_work fence while
 * a fresh attempt (new state) is a distinct row (R-MO19 "deterministic
 * idempotency key per attempt").
 */

/** The outcome the resolver forwards: a caught code, or an authorize-leg error. */
export type HandoffOutcome =
	| { kind: "code"; code: string }
	| { kind: "error"; error: string; errorDescription?: string };

/**
 * The `durable_work` idempotency key for one resolution attempt's handoff. Keyed
 * by challenge id + per-attempt state so a re-driven ship dedupes and a fresh
 * attempt is distinct (R-MO19).
 */
export function handoffIdempotencyKey(challengeId: string, state: string): string {
	return `mcp-oauth-handoff:${challengeId}:${state}`;
}

/** Deterministic durable_work row id for a handoff, from its idempotency key. */
function handoffRowId(idempotencyKey: string): string {
	return deterministicUUID(BOUND_NAMESPACE, idempotencyKey);
}

/**
 * Write the resolver → owner handoff row (R-MO19). `ownerSiteId` is the
 * challenge's owning `site_id`; when it equals `localSiteId` the row is
 * self-targeted (`LOCAL_WORK_TARGET`) and consumed in-process. Returns the
 * durable_work row id on a fresh insert, or null if the idempotency fence
 * deduped an identical prior ship for this same attempt.
 */
export function writeHandoff(
	db: Database,
	params: {
		attempt: ResolverAttempt;
		outcome: HandoffOutcome;
		ownerSiteId: string;
		localSiteId: string;
		/** RPC-class TTL: the code is single-use and minutes-lived; give the row a bounded life. */
		expiresAtIso?: string;
	},
): { rowId: string; targetSiteId: string; idempotencyKey: string } | null {
	const { attempt, outcome, ownerSiteId, localSiteId } = params;
	const idempotencyKey = handoffIdempotencyKey(attempt.challengeId, attempt.state);
	const rowId = handoffRowId(idempotencyKey);
	const targetSiteId = ownerSiteId === localSiteId ? LOCAL_WORK_TARGET : ownerSiteId;

	const payload: Record<string, unknown> = {
		challenge_id: attempt.challengeId,
		server_name: attempt.serverName,
		state: attempt.state,
		redirect_uri: attempt.redirectUri,
		resource: attempt.resource,
		issuer: attempt.issuer,
		client_id: attempt.clientId,
	};
	if (outcome.kind === "code") {
		payload.code = outcome.code;
		payload.code_verifier = attempt.codeVerifier;
	} else {
		payload.error = outcome.error;
		if (outcome.errorDescription) payload.error_description = outcome.errorDescription;
	}

	const inserted = insertDurableWork(db, {
		id: rowId,
		target_site_id: targetSiteId,
		kind: "mcp_auth_handoff",
		payload: JSON.stringify(payload),
		idempotency_key: idempotencyKey,
		source_site: localSiteId,
		ref_id: attempt.challengeId,
		expires_at: params.expiresAtIso ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
	});
	if (!inserted) return null;
	return { rowId, targetSiteId, idempotencyKey };
}
