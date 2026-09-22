import { describe, expect, it } from "bun:test";
import { parseAuthChallengeNotice } from "../auth-challenge";

// The exact text the agent-side formatter (`formatAuthChallengeRaised` in
// packages/agent/src/mcp-auth/raise.ts) emits for a first-use 401. Kept
// verbatim here so a producer-side wording drift trips this test rather than
// silently degrading the TUI notice (R-MO27a).
const FIRST_USE = [
	'Authorization required for MCP server "linear".',
	"Scopes demanded: read write",
	"Challenge id: 5f2a9c31-0000-1111-2222-333344445555",
	"This call did not run. It settled without an authenticated result and your thread stays usable.",
	"",
	"Resolve the challenge, then re-issue the call:",
	"  • CLI:   bound login --challenge 5f2a9c31-0000-1111-2222-333344445555",
	"  • Web UI: open the consent card for this challenge.",
	"You will be woken on this thread when the challenge resolves.",
]
	.filter((l) => l !== "")
	.join("\n");

// A re-raise after a failed attempt: the formatter prepends the prior-failure
// line and names no scopes.
const RERAISE_FAILED = [
	'Authorization required for MCP server "github".',
	"The server requires authorization (no specific scopes named).",
	"Challenge id: aaaa1111-bbbb-2222-cccc-333344445555",
	"The previous authorization attempt failed: access_denied.",
	"Resolve the challenge, then re-issue the call:",
	"  • CLI:   bound login --challenge aaaa1111-bbbb-2222-cccc-333344445555",
	"  • Web UI: open the consent card for this challenge.",
	"You will be woken on this thread when the challenge resolves.",
]
	.filter((l) => l !== "")
	.join("\n");

describe("parseAuthChallengeNotice", () => {
	it("parses a first-use challenge into server, scopes, and challenge id", () => {
		const notice = parseAuthChallengeNotice(FIRST_USE);
		expect(notice).not.toBeNull();
		expect(notice?.serverName).toBe("linear");
		expect(notice?.scopeLine).toBe("Scopes demanded: read write");
		expect(notice?.challengeId).toBe("5f2a9c31-0000-1111-2222-333344445555");
		expect(notice?.failureLine).toBeNull();
	});

	it("captures the prior-failure line on a re-raised challenge", () => {
		const notice = parseAuthChallengeNotice(RERAISE_FAILED);
		expect(notice).not.toBeNull();
		expect(notice?.serverName).toBe("github");
		expect(notice?.scopeLine).toBe("The server requires authorization (no specific scopes named).");
		expect(notice?.failureLine).toBe("The previous authorization attempt failed: access_denied.");
		expect(notice?.challengeId).toBe("aaaa1111-bbbb-2222-cccc-333344445555");
	});

	it("returns null for an ordinary tool result (no false positives)", () => {
		expect(parseAuthChallengeNotice("Read 42 lines from foo.ts")).toBeNull();
		expect(parseAuthChallengeNotice("")).toBeNull();
		expect(parseAuthChallengeNotice('{"ok":true}')).toBeNull();
	});

	it("declines a header-only match that carries no challenge id", () => {
		// The header line alone is not enough to name a resolution affordance;
		// without the id line we must fall through to the plain renderer.
		const text = 'Authorization required for MCP server "x".\nScopes demanded: read';
		expect(parseAuthChallengeNotice(text)).toBeNull();
	});
});
