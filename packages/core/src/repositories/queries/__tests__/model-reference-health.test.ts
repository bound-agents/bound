import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ROUTING_DEFAULT_FALLBACK_MODELS_KEY, ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { insertRow, softDelete } from "../../../change-log";
import { applyMetricsSchema } from "../../../metrics-schema";
import { applySchema } from "../../../schema";
import { analyzeModelReferences } from "../model-reference-health";

const SITE_A = "site-aaaaaa";
const SITE_B = "site-bbbbbb";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

/** Insert a hosts row advertising the given model entries (route_id + logical_model). */
function advertiseHost(
	db: Database,
	siteId: string,
	entries: Array<{ route_id: string; logical_model: string }>,
	opts: { deleted?: 0 | 1 } = {},
): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: `host-${siteId}`,
			version: "test",
			sync_url: null,
			mcp_servers: null,
			mcp_tools: null,
			models: JSON.stringify(entries.map((e) => ({ id: e.logical_model, ...e }))),
			online_at: "2026-01-01T00:00:00.000Z",
			platforms: null,
			mcp_tool_annotations: null,
			commit_hash: null,
			mcp_capabilities: null,
			work_spool_capable: 0,
			deleted: opts.deleted ?? 0,
			modified_at: "2026-01-01T00:00:00.000Z",
		},
		siteId,
	);
}

describe("analyzeModelReferences", () => {
	let db: Database;

	beforeEach(() => {
		db = freshDb();
	});

	afterEach(() => {
		db.close();
	});

	it("classifies a route_order entry pointing at a live route as active", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				route_order: JSON.stringify(["site-a:bedrock:opus"]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		const stale = report.staleRouteOrderEntries.find((e) => e.routeId === "site-a:bedrock:opus");
		expect(stale).toBeUndefined();
		expect(report.staleRouteOrderEntries).toHaveLength(0);
	});

	it("marks a route_order entry whose RouteId is unadvertised as stale (dormant no-op)", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"model_routing_rules",
			{
				logical_model: "opus",
				// Second route no longer advertised anywhere → stale dormant entry.
				route_order: JSON.stringify(["site-a:bedrock:opus", "site-b:anthropic:opus"]),
				fallback_policy: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleRouteOrderEntries).toEqual([
			{ logicalModel: "opus", routeId: "site-b:anthropic:opus" },
		]);
	});

	it("marks a route_drains entry for an unadvertised RouteId as stale", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"route_drains",
			{
				route_id: "site-b:anthropic:opus",
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleRouteDrains).toEqual(["site-b:anthropic:opus"]);
	});

	it("does not mark a drain for a live route as stale", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"route_drains",
			{
				route_id: "site-a:bedrock:opus",
				drained_at: "2026-01-01T00:00:00.000Z",
				reason: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleRouteDrains).toHaveLength(0);
	});

	it("marks a model_aliases entry whose logical_model is advertised nowhere as stale", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"model_aliases",
			{
				provider_key: "anthropic:claude-decommissioned",
				logical_model: "sonnet-gone",
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleModelAliases).toEqual([
			{ providerKey: "anthropic:claude-decommissioned", logicalModel: "sonnet-gone" },
		]);
	});

	it("skips a model_aliases entry with a null logical_model (deliberately ungrouped)", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"model_aliases",
			{
				provider_key: "anthropic:claude-unknown",
				logical_model: null,
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleModelAliases).toHaveLength(0);
	});

	it("marks a default_fallback_models entry for a decommissioned model as stale", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
				value: JSON.stringify(["opus", "sonnet-gone"]),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.staleFallbackModels).toEqual(["sonnet-gone"]);
	});

	it("raises a dangling cluster role when a role points at a decommissioned model", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "opus", heavy: "sonnet-gone" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		const report = analyzeModelReferences(db);
		expect(report.danglingRoles).toEqual([{ role: "heavy", logicalModel: "sonnet-gone" }]);
	});

	it("raises a dangling aux-agent reference and skips role-targeting + pin + retired agents", () => {
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:opus", logical_model: "opus" }]);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "opus" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);
		// Dangling: literal decommissioned model.
		insertAgent(db, "reviewer", "sonnet-gone");
		// Not dangling: targets a cluster role.
		insertAgent(db, "scout", "default");
		// Not dangling: live model.
		insertAgent(db, "builder", "opus");
		// Not dangling: a hard pin resolves to its RouteId's own logical model at
		// run time; a pin whose logical-model prefix is gone is still surfaced.
		insertAgent(db, "pinned-live", "opus@site-a:bedrock:opus");
		// Retired agents are excluded.
		const retiredId = insertAgent(db, "old", "sonnet-gone");
		softDelete(db, "agents", retiredId, SITE_A);

		const report = analyzeModelReferences(db);
		expect(report.danglingAgents).toEqual([{ agentName: "reviewer", logicalModel: "sonnet-gone" }]);
	});

	it("keeps a model transient (not decommissioned) while a stale host still advertises it", () => {
		// SITE_A offline but NOT evicted (deleted = 0) still advertises sonnet.
		advertiseHost(db, SITE_A, [{ route_id: "site-a:bedrock:sonnet", logical_model: "sonnet" }]);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "sonnet" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);

		// sonnet is still advertised by a (stale) non-deleted host → not dangling.
		expect(analyzeModelReferences(db).danglingRoles).toHaveLength(0);

		// Evict the host (soft-delete the row) → model now advertised nowhere → dangling.
		softDelete(db, "hosts", SITE_A, SITE_A);
		expect(analyzeModelReferences(db).danglingRoles).toEqual([
			{ role: "default", logicalModel: "sonnet" },
		]);
	});

	it("treats a model as advertised when any non-deleted host lists it (re-introduction)", () => {
		// Decommissioned: role points at a model advertised nowhere.
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: JSON.stringify({ default: "sonnet" }),
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);
		expect(analyzeModelReferences(db).danglingRoles).toHaveLength(1);

		// Re-advertise from a different host → no longer dangling.
		advertiseHost(db, SITE_B, [{ route_id: "site-b:anthropic:sonnet", logical_model: "sonnet" }]);
		expect(analyzeModelReferences(db).danglingRoles).toHaveLength(0);
	});

	it("tolerates malformed JSON in config rows and advertisements", () => {
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_MODEL_ROLES_KEY,
				value: "{not json",
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);
		insertRow(
			db,
			"cluster_config",
			{
				key: ROUTING_DEFAULT_FALLBACK_MODELS_KEY,
				value: "[oops",
				deleted: 0,
				modified_at: "2026-01-01T00:00:00.000Z",
			},
			SITE_A,
		);
		const report = analyzeModelReferences(db);
		expect(report.danglingRoles).toHaveLength(0);
		expect(report.staleFallbackModels).toHaveLength(0);
	});
});

/** Insert an aux-agent row with a model_hint; returns the generated id. */
function insertAgent(db: Database, name: string, modelHint: string): string {
	const id = `agent-${name}`;
	insertRow(
		db,
		"agents",
		{
			id,
			name,
			persona: "test persona",
			tools: null,
			model_hint: modelHint,
			retired_at: null,
			created_by_thread: null,
			created_at: "2026-01-01T00:00:00.000Z",
			deleted: 0,
			modified_at: "2026-01-01T00:00:00.000Z",
		},
		SITE_A,
	);
	return id;
}
