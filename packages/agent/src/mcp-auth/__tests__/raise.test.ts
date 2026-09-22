import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	type ChallengeDemand,
	applySchema,
	challengeId,
	findChallengeById,
	markFailed,
} from "@bound/core";
import {
	RaiseDebouncer,
	formatAuthChallengeRaised,
	parseWwwAuthenticate,
	raiseAuthChallenge,
} from "../raise";

const SITE = "site-owner";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

function demand(over: Partial<ChallengeDemand> = {}): ChallengeDemand {
	return {
		serverName: "srv",
		owningSiteId: SITE,
		serverUrl: "https://mcp.example/mcp",
		scopeDemand: "read write",
		grantedScopes: "",
		resourceMetadataHint: null,
		clientId: null,
		...over,
	};
}

describe("parseWwwAuthenticate", () => {
	it("parses scope, resource_metadata, and error from a Bearer challenge", () => {
		const p = parseWwwAuthenticate(
			'Bearer error="insufficient_scope", scope="read write admin", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"',
		);
		expect(p.scope).toBe("read write admin");
		expect(p.error).toBe("insufficient_scope");
		expect(p.resourceMetadata).toBe("https://mcp.example/.well-known/oauth-protected-resource");
	});

	it("handles a bare 401 with no params as a first-use demand", () => {
		const p = parseWwwAuthenticate("Bearer");
		expect(p.scope).toBe("");
		expect(p.error).toBeNull();
		expect(p.resourceMetadata).toBeNull();
	});

	it("returns empty fields for a missing header", () => {
		const p = parseWwwAuthenticate(null);
		expect(p.scope).toBe("");
	});

	it("parses bare (unquoted) token values", () => {
		const p = parseWwwAuthenticate("Bearer error=invalid_token scope=read");
		expect(p.error).toBe("invalid_token");
		expect(p.scope).toBe("read");
	});
});

describe("raiseAuthChallenge (R-MO10)", () => {
	it("raises a fresh pending challenge and returns actionable text", () => {
		const db = freshDb();
		const out = raiseAuthChallenge(db, demand(), SITE, new RaiseDebouncer());
		expect(out.suppressed).toBe(false);
		const row = findChallengeById(db, out.challengeId);
		expect(row?.status).toBe("pending");
		expect(out.text).toContain(out.challengeId);
		expect(out.text).toContain("bound login --challenge");
		expect(out.text).toContain("read write");
	});

	it("re-raises a failed row back to pending when the demand differs", () => {
		const db = freshDb();
		const debouncer = new RaiseDebouncer();
		const id = challengeId(SITE, "srv");
		raiseAuthChallenge(db, demand(), SITE, debouncer);
		markFailed(db, id, "access_denied", SITE);
		debouncer.recordFailed(demand());
		// A materially different demand (widened scope) raises normally.
		const out = raiseAuthChallenge(
			db,
			demand({ scopeDemand: "read write admin" }),
			SITE,
			debouncer,
		);
		expect(out.suppressed).toBe(false);
		expect(findChallengeById(db, id)?.status).toBe("pending");
	});
});

describe("R-MO10b debounce", () => {
	it("suppresses a content-identical demand against a failed row inside the interval", () => {
		const db = freshDb();
		let clock = 1_000_000;
		const debouncer = new RaiseDebouncer(60_000, () => clock);
		const id = challengeId(SITE, "srv");

		raiseAuthChallenge(db, demand(), SITE, debouncer);
		markFailed(db, id, "access_denied", SITE);
		debouncer.recordFailed(demand());

		clock += 30_000; // inside 60s
		const out = raiseAuthChallenge(db, demand(), SITE, debouncer);
		expect(out.suppressed).toBe(true);
		// Row stays failed; the outcome carries the retained reason.
		expect(findChallengeById(db, id)?.status).toBe("failed");
		expect(out.text).toContain("access_denied");
	});

	it("raises normally once the debounce interval has elapsed", () => {
		const db = freshDb();
		let clock = 1_000_000;
		const debouncer = new RaiseDebouncer(60_000, () => clock);
		const id = challengeId(SITE, "srv");

		raiseAuthChallenge(db, demand(), SITE, debouncer);
		markFailed(db, id, "access_denied", SITE);
		debouncer.recordFailed(demand());

		clock += 90_000; // past 60s
		const out = raiseAuthChallenge(db, demand(), SITE, debouncer);
		expect(out.suppressed).toBe(false);
		expect(findChallengeById(db, id)?.status).toBe("pending");
	});

	it("does not suppress when the row is pending (not failed)", () => {
		const db = freshDb();
		const debouncer = new RaiseDebouncer();
		raiseAuthChallenge(db, demand(), SITE, debouncer);
		debouncer.recordFailed(demand()); // stale record, but row is pending
		const out = raiseAuthChallenge(db, demand(), SITE, debouncer);
		expect(out.suppressed).toBe(false);
	});
});

describe("formatAuthChallengeRaised (R-MO11)", () => {
	it("names the challenge, scopes, and affordances", () => {
		const text = formatAuthChallengeRaised({
			id: "chal-1",
			server_name: "srv",
			scope_demand: "read",
			status: "pending",
			failure_reason: null,
		});
		expect(text).toContain("chal-1");
		expect(text).toContain("srv");
		expect(text).toContain("read");
		expect(text).toContain("woken");
	});

	it("surfaces the prior failure reason on a failed row", () => {
		const text = formatAuthChallengeRaised({
			id: "chal-1",
			server_name: "srv",
			scope_demand: "read",
			status: "failed",
			failure_reason: "access_denied",
		});
		expect(text).toContain("access_denied");
	});
});
