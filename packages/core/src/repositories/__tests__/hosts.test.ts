import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Host } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import {
	findHostSiteIdAndNameById,
	findHostSiteIdById,
	listAllHostModels,
	listHostMcpInfo,
	listHostSiteIdAndName,
	listHostSiteIdNameAndModels,
	listHostSyncTargets,
	listHostsOrderedByName,
	listHostsWithLiveness,
	listRemoteHostModelLiveness,
} from "../hosts";

const SITE = "site-local";

/**
 * Build a fully-populated Host row. Every column is explicit so the seed is
 * deterministic; callers override only the fields a given test cares about.
 */
function makeHost(overrides: Partial<Host> & { site_id: string }): Host {
	return {
		site_id: overrides.site_id,
		host_name: "host-default",
		version: "1.0.0",
		sync_url: "https://example.test",
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		online_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		platforms: null,
		...overrides,
	};
}

describe("repositories/hosts finders", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb({ metrics: true });
	});

	afterEach(() => {
		db.close();
	});

	// ---- deleted-omission ----

	describe("findHostSiteIdById (ignores deleted)", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "live" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "dead" }), SITE);
			softDelete(db, "hosts", "dead", SITE);
		});

		it("findHostSiteIdById (NO deleted filter) returns the tombstone", () => {
			expect(findHostSiteIdById(db, "dead")).toEqual({ site_id: "dead" });
			expect(findHostSiteIdById(db, "live")).toEqual({ site_id: "live" });
		});

		it("findHostSiteIdAndNameById (WITH deleted filter) also hides the tombstone", () => {
			expect(findHostSiteIdAndNameById(db, "dead")).toBeNull();
			expect(findHostSiteIdAndNameById(db, "live")?.site_id).toBe("live");
		});
	});

	// ---- list finders with deleted=0 filter --------------------------------

	describe("listHostSiteIdAndName (deleted=0)", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "alpha" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h2", host_name: "beta" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h3", host_name: "gamma" }), SITE);
			softDelete(db, "hosts", "h3", SITE);
		});

		it("listHostSiteIdAndName excludes soft-deleted rows", () => {
			const rows = listHostSiteIdAndName(db).sort((a, b) => a.site_id.localeCompare(b.site_id));
			expect(rows).toEqual([
				{ site_id: "h1", host_name: "alpha" },
				{ site_id: "h2", host_name: "beta" },
			]);
		});
	});

	// ---- ORDER BY host_name -------------------------------------------------

	describe("listHostsOrderedByName / listHostMcpInfo (ORDER BY host_name)", () => {
		beforeEach(() => {
			// Insert out of alphabetical order to prove the SQL ORDER BY, not insertion order.
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "gamma" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h2", host_name: "alpha" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h3", host_name: "beta" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h4", host_name: "zeta" }), SITE);
			softDelete(db, "hosts", "h4", SITE);
		});

		it("listHostsOrderedByName sorts ascending by host_name and excludes deleted", () => {
			const names = listHostsOrderedByName(db).map((h) => h.host_name);
			expect(names).toEqual(["alpha", "beta", "gamma"]);
		});

		it("listHostMcpInfo sorts ascending by host_name and excludes deleted", () => {
			const names = listHostMcpInfo(db).map((h) => h.host_name);
			expect(names).toEqual(["alpha", "beta", "gamma"]);
		});
	});

	describe("models IS NOT NULL filters", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "m1", models: '["opus"]' }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "m2", models: null }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "m3", models: '["sonnet"]' }), SITE);
			softDelete(db, "hosts", "m3", SITE);
		});

		it("listAllHostModels keeps null-model rows (no IS NOT NULL filter)", () => {
			const models = listAllHostModels(db)
				.map((r) => r.models)
				.sort((a, b) => String(a).localeCompare(String(b)));
			// m1 and m2 live (m3 deleted); m2 has null models which is still included.
			expect(models).toEqual(['["opus"]', null]);
		});
	});

	// ---- site_id != ? self-exclusion finders --------------------------------

	describe("site_id != ? (remote-only) finders", () => {
		beforeEach(() => {
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: SITE, host_name: "local", models: '["local"]' }),
				SITE,
			);
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: "r1", host_name: "remote1", models: '["opus"]' }),
				SITE,
			);
			insertRow(db, "hosts", makeHost({ site_id: "r2", host_name: "remote2", models: null }), SITE);
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: "r3", host_name: "remote3", models: '["sonnet"]' }),
				SITE,
			);
			softDelete(db, "hosts", "r3", SITE);
		});

		it("listRemoteHostModelLiveness excludes local, deleted, AND null models", () => {
			const rows = listRemoteHostModelLiveness(db, SITE);
			expect(rows.map((r) => r.host_name)).toEqual(["remote1"]);
			expect(rows[0]?.models).toBe('["opus"]');
		});
	});

	// ---- remaining list shapes (representatives) ----------------------------

	describe("misc projection list finders", () => {
		beforeEach(() => {
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "h1",
					host_name: "alpha",
					models: '["opus"]',
					mcp_tools: '["t"]',
					platforms: '["discord"]',
					mcp_servers: '["s"]',
				}),
				SITE,
			);
			insertRow(db, "hosts", makeHost({ site_id: "h2", host_name: "beta" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h3", host_name: "gamma" }), SITE);
			softDelete(db, "hosts", "h3", SITE);
		});

		it("listHostsWithLiveness excludes deleted and projects liveness columns", () => {
			const ids = listHostsWithLiveness(db)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["h1", "h2"]);
		});

		it("listHostSyncTargets excludes deleted rows", () => {
			const ids = listHostSyncTargets(db)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["h1", "h2"]);
		});

		it("listHostSiteIdNameAndModels keeps null models, excludes deleted", () => {
			const rows = listHostSiteIdNameAndModels(db).sort((a, b) =>
				a.site_id.localeCompare(b.site_id),
			);
			expect(rows).toEqual([
				{ site_id: "h1", host_name: "alpha", models: '["opus"]' },
				{ site_id: "h2", host_name: "beta", models: null },
			]);
		});

		it("listHostMcpInfo projects mcp metadata, excludes deleted (zero-extra case)", () => {
			const rows = listHostMcpInfo(db).map((r) => r.site_id);
			expect(rows).toEqual(["h1", "h2"]);
		});
	});
});
