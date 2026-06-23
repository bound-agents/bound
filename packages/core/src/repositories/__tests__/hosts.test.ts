import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Host } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findHostBySiteId,
	findHostLivenessById,
	findHostMcpToolAnnotationsById,
	findHostMcpToolsById,
	findHostNameById,
	findHostSiteIdAndNameById,
	findHostSiteIdById,
	findHostSyncTargetById,
	findLiveHostSiteIdById,
	listAllHostModels,
	listHostCapabilityProfiles,
	listHostMcpCapabilities,
	listHostMcpInfo,
	listHostPlatformLivenessExcludingLocal,
	listHostPlatformLivenessOrderedByRecency,
	listHostPlatforms,
	listHostSiteIdAndMcpTools,
	listHostSiteIdAndModels,
	listHostSiteIdAndName,
	listHostSiteIdAndPlatforms,
	listHostSiteIdNameAndModels,
	listHostSyncTargets,
	listHosts,
	listHostsOrderedByName,
	listHostsWithLiveness,
	listRemoteHostMcpTools,
	listRemoteHostModelLiveness,
	listRemoteHostModels,
	listRemoteHostsWithMcpTools,
	listRemoteHostsWithModels,
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
		overlay_root: null,
		online_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		platforms: null,
		...overrides,
	};
}

describe("repositories/hosts finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	// ---- simple by-id finders: happy + miss --------------------------------

	describe("findHostBySiteId", () => {
		it("returns the full row on hit", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "alpha" }), SITE);
			const row = findHostBySiteId(db, "h1");
			expect(row).not.toBeNull();
			expect(row?.site_id).toBe("h1");
			expect(row?.host_name).toBe("alpha");
		});

		it("returns null on miss", () => {
			expect(findHostBySiteId(db, "nope")).toBeNull();
		});

		it("still returns a soft-deleted row (no deleted filter)", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1" }), SITE);
			softDelete(db, "hosts", "h1", SITE);
			// findHostBySiteId has NO deleted=0 filter, so the tombstone is returned.
			const row = findHostBySiteId(db, "h1");
			expect(row).not.toBeNull();
			expect(row?.site_id).toBe("h1");
			expect((row as unknown as { deleted: number }).deleted).toBe(1);
		});
	});

	describe("findHostNameById (deleted=0 filter)", () => {
		it("returns host_name on a live hit", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "alpha" }), SITE);
			expect(findHostNameById(db, "h1")).toEqual({ host_name: "alpha" });
		});

		it("returns null on miss", () => {
			expect(findHostNameById(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted host", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "alpha" }), SITE);
			softDelete(db, "hosts", "h1", SITE);
			expect(findHostNameById(db, "h1")).toBeNull();
		});
	});

	describe("findHostLivenessById", () => {
		it("returns liveness columns on hit", () => {
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "h1",
					online_at: "2026-02-02T00:00:00.000Z",
					modified_at: "2026-02-03T00:00:00.000Z",
				}),
				SITE,
			);
			expect(findHostLivenessById(db, "h1")).toEqual({
				modified_at: "2026-02-03T00:00:00.000Z",
				online_at: "2026-02-02T00:00:00.000Z",
			});
		});

		it("returns null on miss", () => {
			expect(findHostLivenessById(db, "nope")).toBeNull();
		});
	});

	describe("findHostSyncTargetById", () => {
		it("returns sync-target columns on hit", () => {
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "h1",
					host_name: "alpha",
					sync_url: "https://alpha.test",
					online_at: "2026-02-02T00:00:00.000Z",
					modified_at: "2026-02-03T00:00:00.000Z",
				}),
				SITE,
			);
			expect(findHostSyncTargetById(db, "h1")).toEqual({
				host_name: "alpha",
				sync_url: "https://alpha.test",
				modified_at: "2026-02-03T00:00:00.000Z",
				online_at: "2026-02-02T00:00:00.000Z",
			});
		});

		it("returns null for a soft-deleted host", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1" }), SITE);
			softDelete(db, "hosts", "h1", SITE);
			expect(findHostSyncTargetById(db, "h1")).toBeNull();
		});
	});

	describe("findHostMcpToolsById", () => {
		it("returns mcp_tools (and preserves null) on a live hit", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", mcp_tools: '["a"]' }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h2", mcp_tools: null }), SITE);
			expect(findHostMcpToolsById(db, "h1")).toEqual({ mcp_tools: '["a"]' });
			expect(findHostMcpToolsById(db, "h2")).toEqual({ mcp_tools: null });
		});

		it("returns null on miss and for soft-deleted hosts", () => {
			expect(findHostMcpToolsById(db, "nope")).toBeNull();
			insertRow(db, "hosts", makeHost({ site_id: "h1", mcp_tools: '["a"]' }), SITE);
			softDelete(db, "hosts", "h1", SITE);
			expect(findHostMcpToolsById(db, "h1")).toBeNull();
		});
	});

	describe("findHostMcpToolAnnotationsById", () => {
		it("returns annotations on a live hit", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", mcp_tool_annotations: "{}" }), SITE);
			expect(findHostMcpToolAnnotationsById(db, "h1")).toEqual({ mcp_tool_annotations: "{}" });
		});

		it("returns null for a soft-deleted host", () => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", mcp_tool_annotations: "{}" }), SITE);
			softDelete(db, "hosts", "h1", SITE);
			expect(findHostMcpToolAnnotationsById(db, "h1")).toBeNull();
		});
	});

	// ---- deleted-omission pair: the whole reason they are two finders -------

	describe("findHostSiteIdById vs findLiveHostSiteIdById (deleted-omission pair)", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "live" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "dead" }), SITE);
			softDelete(db, "hosts", "dead", SITE);
		});

		it("findHostSiteIdById (NO deleted filter) returns the tombstone", () => {
			expect(findHostSiteIdById(db, "dead")).toEqual({ site_id: "dead" });
			expect(findHostSiteIdById(db, "live")).toEqual({ site_id: "live" });
		});

		it("findLiveHostSiteIdById (WITH deleted filter) hides the tombstone", () => {
			expect(findLiveHostSiteIdById(db, "dead")).toBeNull();
			expect(findLiveHostSiteIdById(db, "live")).toEqual({ site_id: "live" });
		});

		it("findHostSiteIdAndNameById (WITH deleted filter) also hides the tombstone", () => {
			expect(findHostSiteIdAndNameById(db, "dead")).toBeNull();
			expect(findHostSiteIdAndNameById(db, "live")?.site_id).toBe("live");
		});

		it("both return null for a never-seen id", () => {
			expect(findHostSiteIdById(db, "ghost")).toBeNull();
			expect(findLiveHostSiteIdById(db, "ghost")).toBeNull();
		});
	});

	// ---- list finders with deleted=0 filter --------------------------------

	describe("listHosts / listHostSiteIdAndName (deleted=0)", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "h1", host_name: "alpha" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h2", host_name: "beta" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "h3", host_name: "gamma" }), SITE);
			softDelete(db, "hosts", "h3", SITE);
		});

		it("listHosts excludes soft-deleted rows", () => {
			const ids = listHosts(db)
				.map((h) => h.site_id)
				.sort();
			expect(ids).toEqual(["h1", "h2"]);
		});

		it("listHostSiteIdAndName excludes soft-deleted rows", () => {
			const rows = listHostSiteIdAndName(db).sort((a, b) => a.site_id.localeCompare(b.site_id));
			expect(rows).toEqual([
				{ site_id: "h1", host_name: "alpha" },
				{ site_id: "h2", host_name: "beta" },
			]);
		});

		it("returns [] when all rows are soft-deleted", () => {
			softDelete(db, "hosts", "h1", SITE);
			softDelete(db, "hosts", "h2", SITE);
			expect(listHosts(db)).toEqual([]);
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

	// ---- IS NOT NULL filters ------------------------------------------------

	describe("platforms IS NOT NULL filters", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "p1", platforms: '["discord"]' }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "p2", platforms: null }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "p3", platforms: '["slack"]' }), SITE);
			softDelete(db, "hosts", "p3", SITE);
		});

		it("listHostPlatforms returns only non-null, non-deleted platforms", () => {
			const rows = listHostPlatforms(db);
			expect(rows).toEqual([{ platforms: '["discord"]' }]);
		});

		it("listHostSiteIdAndPlatforms returns only non-null, non-deleted rows", () => {
			const rows = listHostSiteIdAndPlatforms(db);
			expect(rows).toEqual([{ site_id: "p1", platforms: '["discord"]' }]);
		});
	});

	describe("models IS NOT NULL filters", () => {
		beforeEach(() => {
			insertRow(db, "hosts", makeHost({ site_id: "m1", models: '["opus"]' }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "m2", models: null }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "m3", models: '["sonnet"]' }), SITE);
			softDelete(db, "hosts", "m3", SITE);
		});

		it("listHostSiteIdAndModels returns only non-null, non-deleted rows", () => {
			expect(listHostSiteIdAndModels(db)).toEqual([{ site_id: "m1", models: '["opus"]' }]);
		});

		it("listAllHostModels keeps null-model rows (no IS NOT NULL filter)", () => {
			const models = listAllHostModels(db)
				.map((r) => r.models)
				.sort((a, b) => String(a).localeCompare(String(b)));
			// m1 and m2 live (m3 deleted); m2 has null models which is still included.
			expect(models).toEqual(['["opus"]', null]);
		});
	});

	describe("mcp_capabilities IS NOT NULL filter", () => {
		it("listHostMcpCapabilities returns only non-null, non-deleted rows", () => {
			insertRow(db, "hosts", makeHost({ site_id: "c1", mcp_capabilities: "{}" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "c2", mcp_capabilities: null }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "c3", mcp_capabilities: "[]" }), SITE);
			softDelete(db, "hosts", "c3", SITE);
			expect(listHostMcpCapabilities(db)).toEqual([{ mcp_capabilities: "{}" }]);
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

		it("listRemoteHostModels excludes local and deleted, keeps null models", () => {
			const models = listRemoteHostModels(db, SITE)
				.map((r) => r.models)
				.sort((a, b) => String(a).localeCompare(String(b)));
			// r1 (opus) + r2 (null); local excluded by site_id != ?, r3 excluded as deleted.
			expect(models).toEqual(['["opus"]', null]);
		});

		it("listRemoteHostModelLiveness excludes local, deleted, AND null models", () => {
			const rows = listRemoteHostModelLiveness(db, SITE);
			expect(rows.map((r) => r.host_name)).toEqual(["remote1"]);
			expect(rows[0]?.models).toBe('["opus"]');
		});

		it("listRemoteHostsWithModels excludes local and deleted but keeps null models", () => {
			const ids = listRemoteHostsWithModels(db, SITE)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["r1", "r2"]);
		});

		it("excluding a non-existent local id returns ALL live rows", () => {
			const ids = listRemoteHostsWithModels(db, "no-such-local")
				.map((r) => r.site_id)
				.sort();
			// site_id != 'no-such-local' matches everything live (local + r1 + r2).
			expect(ids).toEqual(["r1", "r2", SITE]);
		});
	});

	describe("listRemoteHostMcpTools / listRemoteHostsWithMcpTools (remote + mcp_tools)", () => {
		beforeEach(() => {
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: SITE, host_name: "local", mcp_tools: '["lt"]' }),
				SITE,
			);
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: "r1", host_name: "remote1", mcp_tools: '["rt"]' }),
				SITE,
			);
			insertRow(
				db,
				"hosts",
				makeHost({ site_id: "r2", host_name: "remote2", mcp_tools: null }),
				SITE,
			);
		});

		it("listRemoteHostMcpTools excludes local AND null mcp_tools", () => {
			const rows = listRemoteHostMcpTools(db, SITE);
			expect(rows).toEqual([{ site_id: "r1", host_name: "remote1", mcp_tools: '["rt"]' }]);
		});

		it("listRemoteHostsWithMcpTools excludes only local (keeps null mcp_tools)", () => {
			const ids = listRemoteHostsWithMcpTools(db, SITE)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["r1", "r2"]);
		});
	});

	// ---- ORDER BY COALESCE(modified_at, online_at) DESC ---------------------

	describe("listHostPlatformLivenessOrderedByRecency (ORDER BY COALESCE DESC)", () => {
		it("orders by modified_at desc, falling back to online_at, excluding local/null/deleted", () => {
			// r1: modified_at present and newest.
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "r1",
					platforms: "[1]",
					modified_at: "2026-03-03T00:00:00.000Z",
					online_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE,
			);
			// r2: modified_at older than r1 but newer than r3.
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "r2",
					platforms: "[2]",
					modified_at: "2026-02-02T00:00:00.000Z",
					online_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE,
			);
			// r3: oldest modified_at.
			insertRow(
				db,
				"hosts",
				makeHost({
					site_id: "r3",
					platforms: "[3]",
					modified_at: "2026-01-05T00:00:00.000Z",
					online_at: "2026-01-01T00:00:00.000Z",
				}),
				SITE,
			);
			// local: excluded by site_id != ?.
			insertRow(db, "hosts", makeHost({ site_id: SITE, platforms: "[0]" }), SITE);
			// null platforms: excluded by IS NOT NULL.
			insertRow(db, "hosts", makeHost({ site_id: "rnull", platforms: null }), SITE);

			const ids = listHostPlatformLivenessOrderedByRecency(db, SITE).map((r) => r.site_id);
			expect(ids).toEqual(["r1", "r2", "r3"]);
		});

		it("listHostPlatformLivenessExcludingLocal returns the same set, unordered", () => {
			insertRow(db, "hosts", makeHost({ site_id: "r1", platforms: "[1]" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: SITE, platforms: "[0]" }), SITE);
			insertRow(db, "hosts", makeHost({ site_id: "rnull", platforms: null }), SITE);
			const ids = listHostPlatformLivenessExcludingLocal(db, SITE)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["r1"]);
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

		it("listHostSiteIdAndMcpTools includes null mcp_tools but excludes deleted", () => {
			const rows = listHostSiteIdAndMcpTools(db).sort((a, b) => a.site_id.localeCompare(b.site_id));
			expect(rows).toEqual([
				{ site_id: "h1", mcp_tools: '["t"]' },
				{ site_id: "h2", mcp_tools: null },
			]);
		});

		it("listHostSyncTargets excludes deleted rows", () => {
			const ids = listHostSyncTargets(db)
				.map((r) => r.site_id)
				.sort();
			expect(ids).toEqual(["h1", "h2"]);
		});

		it("listHostCapabilityProfiles projects capability columns, excludes deleted", () => {
			const rows = listHostCapabilityProfiles(db).sort((a, b) =>
				a.site_id.localeCompare(b.site_id),
			);
			expect(rows).toEqual([
				{
					site_id: "h1",
					models: '["opus"]',
					mcp_servers: '["s"]',
					platforms: '["discord"]',
				},
				{ site_id: "h2", models: null, mcp_servers: null, platforms: null },
			]);
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

	// ---- empty-DB / zero-row behavior --------------------------------------

	describe("zero-row behavior", () => {
		it("list finders return [] on an empty table", () => {
			expect(listHosts(db)).toEqual([]);
			expect(listHostsOrderedByName(db)).toEqual([]);
			expect(listHostPlatforms(db)).toEqual([]);
			expect(listRemoteHostModels(db, SITE)).toEqual([]);
			expect(listHostMcpInfo(db)).toEqual([]);
		});
	});
});
