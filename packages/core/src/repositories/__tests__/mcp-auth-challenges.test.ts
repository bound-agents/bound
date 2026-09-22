import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import {
	type ChallengeDemand,
	challengeId,
	findChallengeById,
	findChallengeByServer,
	findPendingChallenges,
	markFailed,
	markResolved,
	raiseChallenge,
	reRaise,
} from "../mcp-auth-challenges";

const OWNER = "site-owner-1";
const SERVER = "web";

function demand(overrides: Partial<ChallengeDemand> = {}): ChallengeDemand {
	return {
		serverName: overrides.serverName ?? SERVER,
		owningSiteId: overrides.owningSiteId ?? OWNER,
		serverUrl: overrides.serverUrl ?? "https://mcp.example.com",
		scopeDemand: overrides.scopeDemand ?? "read",
		grantedScopes: overrides.grantedScopes ?? "",
		resourceMetadataHint: overrides.resourceMetadataHint,
		clientId: overrides.clientId,
	};
}

let db: Database;

beforeEach(() => {
	db = createCoreTestDb({ metrics: true });
});

afterEach(() => {
	db.close();
});

describe("mcp-auth-challenges repository", () => {
	describe("challengeId (R-MO6 deterministic identity)", () => {
		it("is stable for the same (site_id, server name)", () => {
			expect(challengeId(OWNER, SERVER)).toBe(challengeId(OWNER, SERVER));
		});

		it("differs by owning site_id", () => {
			expect(challengeId(OWNER, SERVER)).not.toBe(challengeId("site-owner-2", SERVER));
		});

		it("differs by server name", () => {
			expect(challengeId(OWNER, SERVER)).not.toBe(challengeId(OWNER, "other"));
		});
	});

	describe("raiseChallenge (first raise)", () => {
		it("inserts a pending row carrying the demand fields", () => {
			const id = raiseChallenge(
				db,
				demand({ scopeDemand: "read write", grantedScopes: "read", clientId: "c-1" }),
				OWNER,
			);
			const row = findChallengeById(db, id);
			expect(row).not.toBeNull();
			expect(row?.status).toBe("pending");
			expect(row?.server_name).toBe(SERVER);
			expect(row?.owning_site_id).toBe(OWNER);
			expect(row?.scope_demand).toBe("read write");
			expect(row?.granted_scopes).toBe("read");
			expect(row?.client_id).toBe("c-1");
			expect(row?.failure_reason).toBeNull();
			expect(row?.id).toBe(challengeId(OWNER, SERVER));
		});

		it("carries no secret columns (R-MO7 — schema has none to write)", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			const row = findChallengeById(db, id) as unknown as Record<string, unknown>;
			expect(row).not.toHaveProperty("client_secret");
			expect(row).not.toHaveProperty("code_verifier");
			expect(row).not.toHaveProperty("token");
		});
	});

	describe("markResolved (pending → resolved, R-MO8a/R-MO20)", () => {
		it("resolves a pending row", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			const res = markResolved(db, id, OWNER);
			expect(res.ok).toBe(true);
			expect(findChallengeById(db, id)?.status).toBe("resolved");
		});

		it("optionally records the granted scope union", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			markResolved(db, id, OWNER, { grantedScopes: "read write" });
			expect(findChallengeById(db, id)?.granted_scopes).toBe("read write");
		});

		it("is idempotent on an already-resolved row", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			markResolved(db, id, OWNER);
			const res = markResolved(db, id, OWNER);
			expect(res.ok).toBe(true);
			expect(findChallengeById(db, id)?.status).toBe("resolved");
		});

		it("returns not_found for an unknown id", () => {
			const res = markResolved(db, challengeId(OWNER, "ghost"), OWNER);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error.kind).toBe("not_found");
		});
	});

	describe("markFailed (pending → failed, terminal-wins R-MO8a)", () => {
		it("fails a pending row with the reason", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			const res = markFailed(db, id, "access_denied", OWNER);
			expect(res.ok).toBe(true);
			const row = findChallengeById(db, id);
			expect(row?.status).toBe("failed");
			expect(row?.failure_reason).toBe("access_denied");
		});

		it("is DROPPED WITHOUT EFFECT against an already-resolved row (terminal-wins)", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			markResolved(db, id, OWNER);
			const res = markFailed(db, id, "access_denied", OWNER);
			// The guard returns ok (deliberate no-op), but the row is NOT mutated.
			expect(res.ok).toBe(true);
			const row = findChallengeById(db, id);
			expect(row?.status).toBe("resolved");
			expect(row?.failure_reason).toBeNull();
		});

		it("refreshes the reason on an already-failed row", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			markFailed(db, id, "invalid_scope", OWNER);
			markFailed(db, id, "access_denied", OWNER);
			expect(findChallengeById(db, id)?.failure_reason).toBe("access_denied");
		});
	});

	describe("reRaise (failed/resolved → pending, R-MO8a/R-MO12/R-MO21)", () => {
		it("re-raises a failed row back to pending and refreshes demand fields (R-MO6)", () => {
			const id = raiseChallenge(db, demand({ scopeDemand: "read" }), OWNER);
			markFailed(db, id, "access_denied", OWNER);
			const res = reRaise(db, demand({ scopeDemand: "read write", grantedScopes: "read" }), OWNER);
			expect(res.ok).toBe(true);
			const row = findChallengeById(db, id);
			expect(row?.status).toBe("pending");
			expect(row?.scope_demand).toBe("read write");
			expect(row?.granted_scopes).toBe("read");
			// failure_reason cleared on the failed → pending edge.
			expect(row?.failure_reason).toBeNull();
		});

		it("re-raises a resolved row back to pending (owner grant-death, R-MO12)", () => {
			const id = raiseChallenge(db, demand(), OWNER);
			markResolved(db, id, OWNER);
			const res = reRaise(db, demand(), OWNER);
			expect(res.ok).toBe(true);
			expect(findChallengeById(db, id)?.status).toBe("pending");
		});

		it("refuses to re-raise a row that does not exist", () => {
			const res = reRaise(db, demand({ serverName: "ghost" }), OWNER);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error.kind).toBe("illegal_transition");
		});
	});

	describe("raiseChallenge on an existing row (in-place demand refresh, R-MO6)", () => {
		it("refreshes demand fields on an already-pending row without inserting a second row", () => {
			raiseChallenge(db, demand({ scopeDemand: "read", grantedScopes: "" }), OWNER);
			raiseChallenge(db, demand({ scopeDemand: "read write", grantedScopes: "read" }), OWNER);
			// Still exactly one row for the identity.
			expect(findPendingChallenges(db)).toHaveLength(1);
			const row = findChallengeByServer(db, OWNER, SERVER);
			expect(row?.scope_demand).toBe("read write");
			expect(row?.granted_scopes).toBe("read");
		});
	});

	describe("finders", () => {
		it("findChallengeByServer resolves the deterministic id", () => {
			raiseChallenge(db, demand(), OWNER);
			expect(findChallengeByServer(db, OWNER, SERVER)?.id).toBe(challengeId(OWNER, SERVER));
		});

		it("findPendingChallenges returns only pending live rows", () => {
			raiseChallenge(db, demand({ serverName: "a" }), OWNER);
			const bId = raiseChallenge(db, demand({ serverName: "b" }), OWNER);
			markResolved(db, bId, OWNER);
			const pending = findPendingChallenges(db);
			expect(pending).toHaveLength(1);
			expect(pending[0]?.server_name).toBe("a");
		});
	});
});
