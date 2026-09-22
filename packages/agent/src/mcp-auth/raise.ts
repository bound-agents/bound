import type { Database } from "bun:sqlite";
import {
	type ChallengeDemand,
	type McpAuthChallenge,
	challengeId,
	findChallengeById,
	raiseChallenge,
} from "@bound/core";

/**
 * Owner-side raise path for MCP OAuth challenges.
 *
 * MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §6 (raise path),
 * R-MO10 / R-MO10b / R-MO11 / R-MO12b. On a 401 `UnauthorizedError` or a
 * 403 `insufficient_scope` from an oauth-configured server's call, the owner
 * parses the demand, raises (or re-raises) the one deterministic challenge row,
 * and settles the failing call with an actionable `auth_challenge_raised`
 * outcome. The waiter/wake machinery is slice 3; this slice makes the tool
 * result actionable and immediate — it persists via the normal tool-result path
 * so nothing dangles (R-MO14 lives on the requester; the owner just produces
 * the outcome text here).
 */

/** The parsed WWW-Authenticate demand (RFC 6750 / RFC 9728 / SEP-2350). */
export interface ParsedAuthChallenge {
	/** Space-delimited scope demand, empty for a first-use 401 with no scope param. */
	scope: string;
	/** The RFC 9728 `resource_metadata` URL hint if advertised, else null. */
	resourceMetadata: string | null;
	/** The RFC 6749 `error` code if present (`insufficient_scope` on a 403 step-up). */
	error: string | null;
}

/**
 * Parse a `WWW-Authenticate: Bearer ...` header's auth-params. Handles quoted
 * and bare param values, comma or whitespace separated, tolerating the
 * `Bearer` scheme token prefix. Returns empty/null fields when a param is
 * absent — a bare `401` with no params is a valid first-use demand.
 */
export function parseWwwAuthenticate(header: string | null | undefined): ParsedAuthChallenge {
	const out: ParsedAuthChallenge = { scope: "", resourceMetadata: null, error: null };
	if (!header) return out;
	// Strip a leading scheme token (`Bearer`, `DPoP`, ...) if present.
	const body = header.replace(/^\s*[A-Za-z]+\s+/, "");
	// Match key=value where value is either "quoted" or a bare token.
	const re = /([A-Za-z_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
	let m: RegExpExecArray | null = re.exec(body);
	while (m !== null) {
		const key = m[1].toLowerCase();
		const value = m[2] ?? m[3] ?? "";
		if (key === "scope") out.scope = value;
		else if (key === "resource_metadata") out.resourceMetadata = value;
		else if (key === "error") out.error = value;
		m = re.exec(body);
	}
	return out;
}

/**
 * R-MO10b debounce state: owner-local, in-memory, per-process. Keyed by the
 * challenge id plus a content hash of the demand so a content-IDENTICAL demand
 * against a row currently `failed` within the interval is suppressed, while any
 * material change raises normally. This is a debounce on RE-RAISES only — it
 * never expires a `pending` or `resolved` row (the §3.2 no-timer non-goal holds).
 */
export const RAISE_DEBOUNCE_MS = 60_000;

function demandContentHash(demand: ChallengeDemand): string {
	// Content identity per R-MO10b: same server, same scope demand, same
	// currently-granted scope set. Server url + resource hint round out the
	// demand's observable content.
	return [
		demand.serverName,
		demand.serverUrl,
		demand.scopeDemand,
		demand.grantedScopes,
		demand.resourceMetadataHint ?? "",
	].join("\u0000");
}

/** Records the wall-clock of the last observed `failed` outcome per debounce key. */
export class RaiseDebouncer {
	private readonly lastFailed = new Map<string, number>();

	constructor(
		private readonly intervalMs: number = RAISE_DEBOUNCE_MS,
		private readonly now: () => number = Date.now,
	) {}

	/** Record that a challenge reached `failed` with this demand, for later suppression. */
	recordFailed(demand: ChallengeDemand): void {
		this.lastFailed.set(this.key(demand), this.now());
	}

	/**
	 * True when a content-identical demand should be SUPPRESSED because the row
	 * is currently `failed` and the last `failed` outcome for this exact demand
	 * is within the debounce interval.
	 */
	shouldSuppress(demand: ChallengeDemand, currentStatus: McpAuthChallenge["status"]): boolean {
		if (currentStatus !== "failed") return false;
		const last = this.lastFailed.get(this.key(demand));
		if (last === undefined) return false;
		return this.now() - last < this.intervalMs;
	}

	private key(demand: ChallengeDemand): string {
		return `${challengeId(demand.owningSiteId, demand.serverName)}\u0001${demandContentHash(demand)}`;
	}
}

/** The outcome a raise produces: the challenge id and the actionable result text. */
export interface RaiseOutcome {
	challengeId: string;
	/** True when the raise was suppressed by the R-MO10b debounce (row stays failed). */
	suppressed: boolean;
	/** The `auth_challenge_raised` tool-result text (R-MO11). */
	text: string;
}

/**
 * Format the `auth_challenge_raised` outcome text (R-MO11): actionable text
 * naming the challenge id, the demand (server + scopes), the resolution
 * affordances, and that the thread will be woken on resolution. Exported so
 * slice 3's surface renderers reuse the exact shape.
 */
export function formatAuthChallengeRaised(
	challenge: Pick<
		McpAuthChallenge,
		"id" | "server_name" | "scope_demand" | "status" | "failure_reason"
	>,
): string {
	const scopeLine =
		challenge.scope_demand.length > 0
			? `Scopes demanded: ${challenge.scope_demand}`
			: "The server requires authorization (no specific scopes named).";
	const failedLine =
		challenge.status === "failed" && challenge.failure_reason
			? `\nThe previous authorization attempt failed: ${challenge.failure_reason}.`
			: "";
	return [
		`Authorization required for MCP server "${challenge.server_name}".`,
		scopeLine,
		`Challenge id: ${challenge.id}`,
		failedLine ||
			"This call did not run. It settled without an authenticated result and your thread stays usable.",
		"",
		"Resolve the challenge, then re-issue the call:",
		`  • CLI:   bound login --challenge ${challenge.id}`,
		"  • Web UI: open the consent card for this challenge.",
		"You will be woken on this thread when the challenge resolves.",
	]
		.filter((l) => l !== "")
		.join("\n");
}

/**
 * Raise (or re-raise) a challenge for an oauth-configured server whose call hit
 * a 401/403, applying the R-MO10b debounce. Owner-only: writes the demand
 * fields from the owner's config + observed 401/403 (R-MO6). Returns the
 * challenge id and the actionable outcome text.
 *
 * When the debounce suppresses the raise (content-identical demand against a
 * `failed` row inside the interval), the row is LEFT `failed` and the outcome
 * carries the retained `failure_reason` — no flip to `pending`, no re-sync,
 * no re-wake (R-MO10b).
 */
export function raiseAuthChallenge(
	db: Database,
	demand: ChallengeDemand,
	siteId: string,
	debouncer: RaiseDebouncer,
): RaiseOutcome {
	const id = challengeId(demand.owningSiteId, demand.serverName);
	const existing = findChallengeById(db, id);

	if (existing !== null && debouncer.shouldSuppress(demand, existing.status)) {
		// Suppressed: leave the row failed, return the retained failure reason.
		return {
			challengeId: id,
			suppressed: true,
			text: formatAuthChallengeRaised(existing),
		};
	}

	raiseChallenge(db, demand, siteId);
	const row = findChallengeById(db, id);
	return {
		challengeId: id,
		suppressed: false,
		text: row
			? formatAuthChallengeRaised(row)
			: formatAuthChallengeRaised({
					...demand,
					id,
					server_name: demand.serverName,
					scope_demand: demand.scopeDemand,
					status: "pending",
					failure_reason: null,
				} as never),
	};
}
