import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClusterConfigEntry, Host } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { getLeaderHostLiveness } from "../leader-host-liveness";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/** Minimal Host row with a caller-supplied site_id and heartbeat. */
function makeHost(siteId: string, modifiedAt: string): Host {
	return {
		site_id: siteId,
		host_name: `host-${siteId}`,
		version: null,
		sync_url: null,
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		online_at: null,
		modified_at: modifiedAt,
		platforms: null,
	};
}

function makeConfig(key: string, value: string): ClusterConfigEntry {
	return { key, value, modified_at: TS };
}

describe("getLeaderHostLiveness", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("resolves the host referenced by the cluster_config key to its heartbeat", () => {
		// hosts side: a live host whose site_id is what the config value points at.
		insertRow(db, "hosts", makeHost("leader-host-A", "2026-02-15T12:00:00.000Z"), SITE_ID);
		// cluster_config side: key -> value (the host's site_id).
		insertRow(db, "cluster_config", makeConfig("leader:discord", "leader-host-A"), SITE_ID);

		const row = getLeaderHostLiveness(db, "leader:discord");

		// Oracle: hand-written expected projection.
		expect(row).not.toBeNull();
		expect(row).toEqual({ modified_at: "2026-02-15T12:00:00.000Z" });
	});

	it("projects EXACTLY the declared column (modified_at) and nothing else", () => {
		insertRow(db, "hosts", makeHost("leader-host-B", "2026-03-01T08:30:00.000Z"), SITE_ID);
		insertRow(db, "cluster_config", makeConfig("leader:web", "leader-host-B"), SITE_ID);

		const row = getLeaderHostLiveness(db, "leader:web");

		expect(row).not.toBeNull();
		// The projection interface declares only modified_at — assert the exact key set.
		expect(Object.keys(row as object)).toEqual(["modified_at"]);
		expect((row as { modified_at: string }).modified_at).toBe("2026-03-01T08:30:00.000Z");
	});

	it("returns null when the cluster_config key is unset (no left-side row)", () => {
		insertRow(db, "hosts", makeHost("leader-host-C", "2026-01-02T00:00:00.000Z"), SITE_ID);
		// No cluster_config row for this key.

		const row = getLeaderHostLiveness(db, "leader:absent");

		expect(row).toBeNull();
	});

	it("returns null when the key exists but the referenced host is absent (JOIN miss)", () => {
		// cluster_config points at a host that was never inserted.
		insertRow(db, "cluster_config", makeConfig("leader:dangling", "ghost-host"), SITE_ID);

		const row = getLeaderHostLiveness(db, "leader:dangling");

		// INNER JOIN with no matching host yields no rows -> null.
		expect(row).toBeNull();
	});

	it("excludes a soft-deleted host (deleted=0 filter on the joined side)", () => {
		insertRow(db, "hosts", makeHost("leader-host-D", "2026-04-01T00:00:00.000Z"), SITE_ID);
		insertRow(db, "cluster_config", makeConfig("leader:dead", "leader-host-D"), SITE_ID);

		// Tombstone the host the config still points at.
		softDelete(db, "hosts", "leader-host-D", SITE_ID);

		const row = getLeaderHostLiveness(db, "leader:dead");

		// The host row still exists physically (soft delete) but deleted=1 -> filtered out.
		expect(row).toBeNull();
	});

	it("returns the live sibling, not the tombstone, when both a live and deleted host exist", () => {
		// Live host the key actually points at.
		insertRow(db, "hosts", makeHost("live-host", "2026-05-01T00:00:00.000Z"), SITE_ID);
		// A separate, soft-deleted host that the key does NOT point at.
		insertRow(db, "hosts", makeHost("dead-host", "2026-05-02T00:00:00.000Z"), SITE_ID);
		softDelete(db, "hosts", "dead-host", SITE_ID);

		insertRow(db, "cluster_config", makeConfig("leader:live", "live-host"), SITE_ID);

		const row = getLeaderHostLiveness(db, "leader:live");

		expect(row).toEqual({ modified_at: "2026-05-01T00:00:00.000Z" });
	});

	it("reflects an updated heartbeat after the host's modified_at changes", () => {
		insertRow(db, "hosts", makeHost("beat-host", "2026-01-01T00:00:00.000Z"), SITE_ID);
		insertRow(db, "cluster_config", makeConfig("leader:beat", "beat-host"), SITE_ID);

		// updateRow stamps modified_at with wall-clock; verify the projection tracks the
		// live row rather than caching the seed value by asserting it changed away from the seed.
		const before = getLeaderHostLiveness(db, "leader:beat");
		expect(before).toEqual({ modified_at: "2026-01-01T00:00:00.000Z" });

		updateRow(db, "hosts", "beat-host", { host_name: "renamed" }, SITE_ID);

		const after = getLeaderHostLiveness(db, "leader:beat");
		expect(after).not.toBeNull();
		expect((after as { modified_at: string }).modified_at).not.toBe("2026-01-01T00:00:00.000Z");
	});

	it("matches on the exact key only (no prefix / substring match)", () => {
		insertRow(db, "hosts", makeHost("exact-host", "2026-06-01T00:00:00.000Z"), SITE_ID);
		insertRow(db, "cluster_config", makeConfig("leader:exact", "exact-host"), SITE_ID);

		// A near-miss key must not match.
		expect(getLeaderHostLiveness(db, "leader:exac")).toBeNull();
		expect(getLeaderHostLiveness(db, "leader:exactt")).toBeNull();
		// The exact key matches.
		expect(getLeaderHostLiveness(db, "leader:exact")).toEqual({
			modified_at: "2026-06-01T00:00:00.000Z",
		});
	});
});
