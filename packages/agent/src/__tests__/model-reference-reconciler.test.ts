import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyMetricsSchema,
	applySchema,
	insertRow,
	listActiveAdvisories,
	softDelete,
	updateRow,
} from "@bound/core";
import { ROUTING_MODEL_ROLES_KEY } from "@bound/shared";
import { createAdvisory } from "../advisories";
import { reconcileModelReferenceAdvisories } from "../model-reference-reconciler";

const SITE_A = "site-aaaaaa";
const SITE_B = "site-bbbbbb";

/** Every non-deleted-aware `model_reference_dangling` row (incl. terminal and deleted). */
function allDanglingRows(
	db: Database,
): Array<{ id: string; status: string; created_by: string | null; deleted: number }> {
	return db
		.query(
			"SELECT id, status, created_by, deleted FROM advisories WHERE type = 'model_reference_dangling' AND deleted = 0",
		)
		.all() as Array<{ id: string; status: string; created_by: string | null; deleted: number }>;
}

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

function insertTask(db: Database, id: string, modelHint: string, status = "pending"): void {
	insertRow(
		db,
		"tasks",
		{
			id,
			type: "heartbeat",
			status,
			trigger_spec: "{}",
			payload: null,
			created_at: "2026-01-01T00:00:00.000Z",
			created_by: SITE_A,
			thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: null,
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: modelHint,
			no_history: null,
			inject_mode: null,
			depends_on: null,
			require_success: null,
			alert_threshold: null,
			consecutive_failures: 0,
			event_depth: null,
			no_quiescence: null,
			heartbeat_at: null,
			result: null,
			error: null,
			origin_thread_id: null,
			system_prompt_addition: null,
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

	it("raises and auto-resolves a dangling advisory for an operator-named alias", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		// Alias `reviewer` points at a model advertised nowhere.
		setRoles(db, { default: "opus", reviewer: "sonnet-gone" });

		const raised = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(raised.raised).toBe(1);
		const active = listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling");
		expect(active).toHaveLength(1);
		expect(active[0].title).toContain("reviewer");
		expect(active[0].title).toContain("sonnet-gone");

		// The alias target comes back on another host → the advisory auto-resolves.
		advertiseHost(db, SITE_B, ["sonnet-gone"]);
		const back = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(back.resolved).toBe(1);
		expect(back.raised).toBe(0);
		expect(
			listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling"),
		).toHaveLength(0);
	});

	it("does not dangle an aux agent or task targeting a live alias", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { reviewer: "opus" });
		// Agent and task name the alias, not the model; the alias resolves, so neither
		// is dangling on its own.
		insertAgent(db, "scout", "reviewer");
		insertTask(db, "hb-reviewer", "reviewer");

		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.raised).toBe(0);
		expect(
			listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling"),
		).toHaveLength(0);
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

	it("raises a dangling advisory for a scheduled task naming a decommissioned model", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus" });
		insertTask(db, "hb-1", "sonnet-gone");

		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.raised).toBe(1);
		const active = listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling");
		expect(active).toHaveLength(1);
		expect(active[0].title).toContain("hb-1");
		expect(active[0].title).toContain("sonnet-gone");
	});

	it("auto-resolves a task advisory when the task's model is re-advertised", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus" });
		insertTask(db, "hb-1", "sonnet-gone");
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		advertiseHost(db, SITE_B, ["sonnet-gone"]);
		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.resolved).toBe(1);
		expect(
			listActiveAdvisories(db).filter((a) => a.type === "model_reference_dangling"),
		).toHaveLength(0);
	});

	// Churn defect A (req 4): an operator-acted (dismissed/applied) advisory for a
	// reference that is STILL dangling must NOT be re-raised every pass. Dedup has to
	// count terminal rows, not just the active (non-terminal) set.
	it("does not re-raise a dismissed advisory while the reference is still dangling", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		// Operator dismisses it (terminal). The model is still gone.
		const raised = listActiveAdvisories(db).find((a) => a.type === "model_reference_dangling");
		if (!raised) throw new Error("expected an advisory");
		updateRow(db, "advisories", raised.id, { status: "dismissed" }, SITE_A);

		// A later reconcile must neither re-raise a fresh proposed row nor touch the
		// dismissed one: the operator has spoken, the reference is unchanged.
		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.raised).toBe(0);
		expect(result.resolved).toBe(0);
		const rows = allDanglingRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("dismissed");
	});

	// Churn defect A, resolve path: once the model returns, even a dismissed/applied
	// advisory this site raised should auto-resolve (soft-delete) so a future
	// recurrence gets a fresh row.
	it("auto-resolves a dismissed advisory when the reference comes back", () => {
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);
		const raised = listActiveAdvisories(db).find((a) => a.type === "model_reference_dangling");
		if (!raised) throw new Error("expected an advisory");
		updateRow(db, "advisories", raised.id, { status: "dismissed" }, SITE_A);

		advertiseHost(db, SITE_B, ["sonnet-gone"]);
		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.resolved).toBe(1);
		expect(allDanglingRows(db)).toHaveLength(0);
	});

	// Churn defect B (req 4): two sites with divergent `hosts` replicas must not
	// soft-delete and re-raise each other's advisories in a sync ping-pong. A host
	// only auto-resolves advisories IT created.
	it("does not auto-resolve another site's advisory (no cross-site ping-pong)", () => {
		// SITE_A sees the model as dangling and raises. SITE_B's row for the same
		// dangling ref is simulated: a proposed advisory created_by SITE_B.
		advertiseHost(db, SITE_A, ["opus"]);
		setRoles(db, { default: "opus", heavy: "sonnet-gone" });
		expect(reconcileModelReferenceAdvisories(db, SITE_A).raised).toBe(1);

		// A second host (SITE_B) independently raised its own row for the same title.
		const titleRow = listActiveAdvisories(db).find((a) => a.type === "model_reference_dangling");
		if (!titleRow) throw new Error("expected an advisory");
		createAdvisory(
			db,
			{
				type: "model_reference_dangling",
				status: "proposed",
				title: titleRow.title,
				detail: "raised by site B",
				action: null,
				impact: null,
				evidence: null,
			},
			SITE_B,
		);

		// SITE_A reconciles again. The reference is STILL dangling, so nothing
		// resolves — and critically SITE_A must not soft-delete SITE_B's row.
		const result = reconcileModelReferenceAdvisories(db, SITE_A);
		expect(result.resolved).toBe(0);
		expect(result.raised).toBe(0);
		const rows = allDanglingRows(db);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.deleted === 0)).toBe(true);
	});
});
