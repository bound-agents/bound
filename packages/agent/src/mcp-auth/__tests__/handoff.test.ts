import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LOCAL_WORK_TARGET, applySchema } from "@bound/core";
import { handoffIdempotencyKey, writeHandoff } from "../handoff";
import type { ResolverAttempt } from "../resolver";

/**
 * Handoff-writer tests (R-MO19/R-MO29/R-MO30). Idempotency per attempt,
 * self-owned → LOCAL_WORK_TARGET, and secret containment (no token, no secret).
 */

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
});

afterEach(() => {
	db.close();
});

function attempt(overrides: Partial<ResolverAttempt> = {}): ResolverAttempt {
	return {
		challengeId: "chal-1",
		serverName: "srv",
		state: "state-abc",
		codeVerifier: "verifier-xyz",
		redirectUri: "http://localhost:3001/oauth/mcp/callback",
		resource: "https://mcp.example.com",
		issuer: "https://as.example.com",
		clientId: "client-1",
		authorizationUrl: "https://as.example.com/authorize",
		...overrides,
	};
}

function handoffRow(): { payload: string; target_site_id: string; idempotency_key: string } {
	const row = db
		.query(
			"SELECT payload, target_site_id, idempotency_key FROM durable_work WHERE kind = 'mcp_auth_handoff'",
		)
		.get() as { payload: string; target_site_id: string; idempotency_key: string } | null;
	if (!row) throw new Error("expected an mcp_auth_handoff row");
	return row;
}

describe("writeHandoff (R-MO19)", () => {
	it("self-owned challenge targets LOCAL_WORK_TARGET", () => {
		const r = writeHandoff(db, {
			attempt: attempt(),
			outcome: { kind: "code", code: "the-code" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		if (!r) throw new Error("expected a handoff row");
		expect(r.targetSiteId).toBe(LOCAL_WORK_TARGET);
		const row = handoffRow();
		expect(row?.target_site_id).toBe(LOCAL_WORK_TARGET);
	});

	it("peer-owned challenge targets the owner site", () => {
		const r = writeHandoff(db, {
			attempt: attempt(),
			outcome: { kind: "code", code: "the-code" },
			ownerSiteId: "site-owner",
			localSiteId: "site-resolver",
		});
		if (!r) throw new Error("expected a handoff row");
		expect(r.targetSiteId).toBe("site-owner");
	});

	it("carries code + verifier + redirect_uri + resource + issuer + client_id, NEVER a secret/token", () => {
		writeHandoff(db, {
			attempt: attempt(),
			outcome: { kind: "code", code: "the-code" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		const hr = handoffRow();
		if (!hr) throw new Error("expected a handoff row");
		const payload = JSON.parse(hr.payload) as Record<string, unknown>;
		expect(payload.code).toBe("the-code");
		expect(payload.code_verifier).toBe("verifier-xyz");
		expect(payload.redirect_uri).toBe("http://localhost:3001/oauth/mcp/callback");
		expect(payload.resource).toBe("https://mcp.example.com");
		expect(payload.issuer).toBe("https://as.example.com");
		expect(payload.client_id).toBe("client-1");
		// R-MO29/R-MO30: no token, no secret anywhere in the payload.
		const raw = JSON.stringify(payload);
		expect(raw).not.toContain("client_secret");
		expect(raw).not.toContain("access_token");
		expect(raw).not.toContain("refresh_token");
	});

	it("error outcome carries the error code, no code/verifier", () => {
		writeHandoff(db, {
			attempt: attempt(),
			outcome: { kind: "error", error: "access_denied", errorDescription: "declined" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		const hr = handoffRow();
		if (!hr) throw new Error("expected a handoff row");
		const payload = JSON.parse(hr.payload) as Record<string, unknown>;
		expect(payload.error).toBe("access_denied");
		expect(payload.error_description).toBe("declined");
		expect(payload.code).toBeUndefined();
		expect(payload.code_verifier).toBeUndefined();
	});

	it("is idempotent per attempt (same challenge + state dedupes)", () => {
		const a = attempt();
		const first = writeHandoff(db, {
			attempt: a,
			outcome: { kind: "code", code: "c1" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		expect(first).not.toBeNull();
		const second = writeHandoff(db, {
			attempt: a,
			outcome: { kind: "code", code: "c1" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		// Second ship dedupes at the durable_work fence.
		expect(second).toBeNull();
		const count = (
			db.query("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'mcp_auth_handoff'").get() as {
				c: number;
			}
		).c;
		expect(count).toBe(1);
	});

	it("a fresh attempt (new state) is a distinct handoff row", () => {
		writeHandoff(db, {
			attempt: attempt({ state: "state-1" }),
			outcome: { kind: "code", code: "c1" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		writeHandoff(db, {
			attempt: attempt({ state: "state-2" }),
			outcome: { kind: "code", code: "c2" },
			ownerSiteId: "site-a",
			localSiteId: "site-a",
		});
		const count = (
			db.query("SELECT COUNT(*) AS c FROM durable_work WHERE kind = 'mcp_auth_handoff'").get() as {
				c: number;
			}
		).c;
		expect(count).toBe(2);
	});

	it("idempotency key format is mcp-oauth-handoff:<challenge>:<state>", () => {
		expect(handoffIdempotencyKey("chal-1", "state-abc")).toBe("mcp-oauth-handoff:chal-1:state-abc");
	});
});
