import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Agent } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findActiveAgentByName,
	findAgentById,
	findAgentByNameIncludingRetired,
	findAgentIdById,
	listActiveAgents,
	listAgentsForToolView,
} from "../agents";

const SITE_ID = "site-test";

function makeAgent(overrides: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
	return {
		persona: "who it IS",
		tools: null,
		model_hint: null,
		retired_at: null,
		created_by_thread: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		...overrides,
	};
}

describe("agents repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	// ---- findActiveAgentByName: dispatch resolution (retired IS NULL + deleted=0) ----

	describe("findActiveAgentByName", () => {
		it("returns the active row for an existing identity (happy path)", () => {
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a1", name: "tama", persona: "curious, methodical" }),
				SITE_ID,
			);
			const row = findActiveAgentByName(db, "tama");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("a1");
			expect(row?.persona).toBe("curious, methodical");
		});

		it("returns null for an absent name (miss path)", () => {
			expect(findActiveAgentByName(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted identity (deleted=0 filter)", () => {
			insertRow(db, "agents", makeAgent({ id: "a1", name: "tama" }), SITE_ID);
			softDelete(db, "agents", "a1", SITE_ID);
			expect(findActiveAgentByName(db, "tama")).toBeNull();
		});

		it("returns null for a retired identity (retired_at IS NULL filter)", () => {
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a1", name: "tama", retired_at: "2026-02-02T00:00:00.000Z" }),
				SITE_ID,
			);
			expect(findActiveAgentByName(db, "tama")).toBeNull();
		});

		it("resolves duplicate names to the newest by modified_at DESC (deterministic tiebreak)", () => {
			// name has no UNIQUE index: two hosts may define "tama" offline. Dispatch
			// must pick the most recently written one deterministically.
			insertRow(
				db,
				"agents",
				makeAgent({
					id: "old",
					name: "tama",
					persona: "OLD persona",
					modified_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"agents",
				makeAgent({
					id: "new",
					name: "tama",
					persona: "NEW persona",
					modified_at: "2026-03-03T00:00:00.000Z",
				}),
				SITE_ID,
			);
			const row = findActiveAgentByName(db, "tama");
			expect(row?.id).toBe("new");
			expect(row?.persona).toBe("NEW persona");
		});
	});

	// ---- findAgentByNameIncludingRetired: retire/update path (sees retired, not deleted) ----

	describe("findAgentByNameIncludingRetired", () => {
		it("returns a retired identity that findActiveAgentByName hides", () => {
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a1", name: "tama", retired_at: "2026-02-02T00:00:00.000Z" }),
				SITE_ID,
			);
			// The active finder hides it...
			expect(findActiveAgentByName(db, "tama")).toBeNull();
			// ...but the retire/update path sees it.
			const row = findAgentByNameIncludingRetired(db, "tama");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("a1");
			expect(row?.retired_at).toBe("2026-02-02T00:00:00.000Z");
		});

		it("still excludes a soft-deleted identity (deleted=0 filter holds)", () => {
			insertRow(db, "agents", makeAgent({ id: "a1", name: "tama" }), SITE_ID);
			softDelete(db, "agents", "a1", SITE_ID);
			expect(findAgentByNameIncludingRetired(db, "tama")).toBeNull();
		});

		it("resolves to the newest by modified_at DESC across a live+retired pair", () => {
			insertRow(
				db,
				"agents",
				makeAgent({
					id: "live",
					name: "tama",
					modified_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE_ID,
			);
			insertRow(
				db,
				"agents",
				makeAgent({
					id: "retired-newer",
					name: "tama",
					retired_at: "2026-05-05T00:00:00.000Z",
					modified_at: "2026-05-05T00:00:00.000Z",
				}),
				SITE_ID,
			);
			expect(findAgentByNameIncludingRetired(db, "tama")?.id).toBe("retired-newer");
		});
	});

	// ---- findAgentById / findAgentIdById ----

	describe("findAgentById", () => {
		it("returns the row by id including a retired one (deleted=0 only)", () => {
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a1", name: "tama", retired_at: "2026-02-02T00:00:00.000Z" }),
				SITE_ID,
			);
			const row = findAgentById(db, "a1");
			expect(row?.id).toBe("a1");
			expect(row?.retired_at).toBe("2026-02-02T00:00:00.000Z");
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findAgentById(db, "ghost")).toBeNull();
		});

		it("returns null for a soft-deleted id", () => {
			insertRow(db, "agents", makeAgent({ id: "a1", name: "tama" }), SITE_ID);
			softDelete(db, "agents", "a1", SITE_ID);
			expect(findAgentById(db, "a1")).toBeNull();
		});
	});

	describe("findAgentIdById (existence check, deleted-omission variant)", () => {
		it("returns {id} for a soft-deleted row that findAgentById hides", () => {
			insertRow(db, "agents", makeAgent({ id: "dead", name: "tombstone" }), SITE_ID);
			softDelete(db, "agents", "dead", SITE_ID);
			expect(findAgentById(db, "dead")).toBeNull();
			expect(findAgentIdById(db, "dead")).toEqual({ id: "dead" });
		});

		it("returns null for an absent id (miss path)", () => {
			expect(findAgentIdById(db, "never")).toBeNull();
		});
	});

	// ---- listActiveAgents (ORDER BY name ASC, retired IS NULL, deleted=0) ----

	describe("listActiveAgents", () => {
		it("returns active identities ordered by name, excluding retired and deleted", () => {
			insertRow(db, "agents", makeAgent({ id: "a1", name: "gamma" }), SITE_ID);
			insertRow(db, "agents", makeAgent({ id: "a2", name: "alpha" }), SITE_ID);
			insertRow(db, "agents", makeAgent({ id: "a3", name: "beta" }), SITE_ID);
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a4", name: "retired-one", retired_at: "2026-02-02T00:00:00.000Z" }),
				SITE_ID,
			);
			insertRow(db, "agents", makeAgent({ id: "a5", name: "deleted-one" }), SITE_ID);
			softDelete(db, "agents", "a5", SITE_ID);

			const names = listActiveAgents(db).map((a) => a.name);
			expect(names).toEqual(["alpha", "beta", "gamma"]);
		});

		it("returns [] when empty", () => {
			expect(listActiveAgents(db)).toEqual([]);
		});
	});

	// ---- listAgentsForToolView (name + persona + model_hint, active only) ----

	describe("listAgentsForToolView", () => {
		it("projects name, persona, model_hint for active identities ordered by name", () => {
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a1", name: "zeta", persona: "Z persona", model_hint: "haiku" }),
				SITE_ID,
			);
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a2", name: "alpha", persona: "A persona", model_hint: null }),
				SITE_ID,
			);
			insertRow(
				db,
				"agents",
				makeAgent({ id: "a3", name: "gone", retired_at: "2026-02-02T00:00:00.000Z" }),
				SITE_ID,
			);

			expect(listAgentsForToolView(db)).toEqual([
				{ name: "alpha", persona: "A persona", model_hint: null },
				{ name: "zeta", persona: "Z persona", model_hint: "haiku" },
			]);
		});

		it("does NOT project persona-adjacent columns like tools or id", () => {
			insertRow(db, "agents", makeAgent({ id: "a1", name: "tama", tools: '["read"]' }), SITE_ID);
			const row = listAgentsForToolView(db)[0];
			expect("tools" in row).toBe(false);
			expect("id" in row).toBe(false);
		});

		it("returns [] over an empty table", () => {
			expect(listAgentsForToolView(db)).toEqual([]);
		});
	});
});
