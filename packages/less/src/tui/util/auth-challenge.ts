// Detect and parse a settled `auth_challenge_raised` MCP-OAuth tool result so
// the TUI can render it as a consent NOTICE (R-MO27a) instead of a plain wall
// of result text.
//
// MCP OAuth RFC: docs/design/specs/2026-09-21-mcp-oauth.md, §11 R-MO27(a). The
// notice is VISUALLY shaped like a client-tool confirmation but mechanically it
// is just a rendered tool result — nothing blocks, the call already settled
// (R-MO14). We key off the text shape the agent-side formatter emits
// (`formatAuthChallengeRaised` in packages/agent/src/mcp-auth/raise.ts): the
// first line names the server, and a `Challenge id: <id>` line carries the id.
// Matching the shape keeps the renderer decoupled from a machine marker the
// producer would otherwise have to stamp into every result.

/** A parsed MCP-OAuth consent notice extracted from a settled tool result. */
export interface AuthChallengeNotice {
	/** The MCP server the demand is for. */
	serverName: string;
	/** The deterministic challenge id, for `bound login --challenge <id>`. */
	challengeId: string;
	/** The scope-demand line as the formatter rendered it (may be the no-scopes phrasing). */
	scopeLine: string;
	/** The prior-failure line if the challenge is re-raised after a failed attempt, else null. */
	failureLine: string | null;
}

// The formatter's first line: `Authorization required for MCP server "<name>".`
const HEADER_RE = /^Authorization required for MCP server "([^"]+)"\.$/;
// The id line: `Challenge id: <uuid>` (uuid is opaque; capture the rest of the line).
const CHALLENGE_ID_RE = /^Challenge id:\s*(.+)$/;
// The scope line: either the demanded scopes or the no-specific-scopes phrasing.
const SCOPE_RE =
	/^(Scopes demanded:.*|The server requires authorization \(no specific scopes named\)\.)$/;
// The re-raise failure line the formatter prepends on a `failed` row.
const FAILURE_RE = /^The previous authorization attempt failed:.*$/;

/**
 * Parse a settled tool-result text into an {@link AuthChallengeNotice}, or
 * return null when the text is not an `auth_challenge_raised` outcome. Pure and
 * cheap: a first-line regex gate short-circuits every ordinary tool result
 * before any line scan.
 */
export function parseAuthChallengeNotice(text: string): AuthChallengeNotice | null {
	const lines = text.split("\n");
	const header = lines[0]?.match(HEADER_RE);
	if (!header) return null;
	const serverName = header[1];

	let challengeId: string | null = null;
	let scopeLine: string | null = null;
	let failureLine: string | null = null;
	for (const line of lines) {
		const idMatch = line.match(CHALLENGE_ID_RE);
		if (idMatch && challengeId === null) {
			challengeId = idMatch[1].trim();
			continue;
		}
		if (SCOPE_RE.test(line) && scopeLine === null) {
			scopeLine = line;
			continue;
		}
		if (FAILURE_RE.test(line) && failureLine === null) {
			failureLine = line;
		}
	}

	// A well-formed notice always carries the id line; without it we cannot
	// name the resolution affordance, so decline and let the plain renderer run.
	if (challengeId === null) return null;

	return {
		serverName,
		challengeId,
		scopeLine: scopeLine ?? "The server requires authorization.",
		failureLine,
	};
}
