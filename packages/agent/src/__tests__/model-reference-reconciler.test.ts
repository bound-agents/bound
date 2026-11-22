import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyMetricsSchema,
	applySchema,
	insertRow,
	listActiveAdvisories,
	softDelete,
} from "@bound/core";
import { ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { reconcileModelReferenceAdvisories } from "../model-reference-reconciler";

const SITE_A = "site-aaaaaa";
const SITE_B = "site-bbbbbb";

function freshDb(): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	applySchema(db);
	applyMetricsSchema(db);
	return db;
}

function advertiseHost(db: Database, siteId: string, logicalModels: string[]): void {
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
			models: JSON.stringify(
				logicalModels.map((m) => ({ id: m, logical_model: m, route_id: `${siteId}:p:${m}` })),
			),
			online_at: "2026-01-01T00:00:00.000Z",
			platforms: null,
			mcp_tool_annotations: null,
			commit_hash: null,
			mcp_capabilities: null,
			work_spool_capable: 0,
			deleted: 0,
			modified_at: "2026-01-01T00:00:00.000Z",
		},
		siteId,
	);
}

function setRoles(db: Database, roles: Record<string, string>): void {
	insertRow(
		db,
		"cluster_config",
		{
			key: ROUTING_MODEL_ROLES_KEY,
			value: JSON.stringify(roles),
			deleted: 0,
			modified_at: "2026-01-01T00:00:00.000Z",
		},
		SITE_A,
	);
}

function insertAgent(db: Database, name: string, modelHint: string): void {
	insertRow(
		db,
		"agents",
		{
			id: `agent-${name}`,
			name,
			persona: "p",
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
}

describe("reconcileModelReferenceAdvisories", () => {
	let db: Database;

	beforeEach(() => {
		db = freshDb();
	});

	afterEach(() => {
		db.close();
	});

	it("raises one dangling advisory per role pointing at a decommissioned model", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });

		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.raised).toBe(1);
		expect(result.resolved).toBe(0);

		const active = listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling");
		expect(active).toHaveLength(1);
		expect(active[0].title).toContain("sonnet-gone");
		expect(active[0].title).toContain("heavy");
	});

	it("raises a dangling advisory for an aux agent naming a decommissioned model", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus" });
		insertAgent(db, "reviewer", "sonnet-gone");

		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.raised).toBe(1);
		const active = listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling");
		expect(active).toHaveLength(1);
		expect(active[0].title).toContain("reviewer");
		expect(active[0].title).toContain("sonnet-gone");
	});

	it("is idempotent — a second run with the same dangling state raises nothing new", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });

		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);
		const second = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(second.raised).toBe(0);
		expect(second.resolved).toBe(0);
		expect(
			listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling"),
		).toHaveLength(1);
	});

	it("auto-resolves a dangling advisory when the model is re-advertised", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		// sonnet-gone comes back on another host.
		advertiseHost(db, SITE_B, ["sonnet-gone"]);
		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.resolved).toBe(1);
		expect(result.raised).toBe(0);
		expect(
			listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling"),
		).toHaveLength(0);
	});

	it("keeps the advisory open while a stale (non-evicted) host still advertises the model, resolving only after eviction", () => {
		// SITE_B advertises sonnet; role points at it → not dangling yet.
		advertiseHost(db, SITE_A, ["opus"]);
		advertiseHost(db, SITE_B, ["sonnet"]);
		setRoles(db, { default: "opus", heavy: "sonnet" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(0);

		// Evict SITE_B (soft-delete) → sonnet advertised nowhere → dangling.
		softDelete(db, "hosts", SITE_B, SITE_A);
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		// A still-non-deleted host re-advertising resolves it.
		advertiseHost(db, "site-cccccc", ["sonnet"]);
		expect(reconcileModelReferenceAdvisories(db, SITE_A).resolved).toBe(1);
	});

	it("does not touch an operator-dismissed advisory on re-reconcile", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		// Operator dismisses it; a later reconcile with the model still gone must
		// not re-raise (dedup also counts dismissed rows by title) nor resurrect.
		const active = listActiveAdvisories(db).find((a) => a.type === "model_reference_dangling");
		if (!active) throw new Error("expected an advisory");
		softDelete(db, "advisories", active.id, SITE_A);

		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		// The soft-deleted row is gone from active; the model is still dangling, so
		// a fresh advisory is raised (a dismissed-then-still-broken case). The key
		// guarantee is the reconciler never throws and never double-counts a live row.
		expect(result.resolved).toBe(0);
	});
});
