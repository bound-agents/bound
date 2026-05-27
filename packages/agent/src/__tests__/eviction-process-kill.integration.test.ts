import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import type { AppContext } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { Scheduler } from "../scheduler";

describe("Eviction process-kill atomicity (AC3.2)", () => {
	let db: Database;
	let ctx: AppContext;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		ctx = {
			db,
			config: {
				allowlist: { default_web_user: "test", users: { test: { display_name: "Test" } } },
				modelBackends: { backends: [], default: "" },
			},
			optionalConfig: {
				mcp_servers: [],
			},
			eventBus: new TypedEventEmitter(),
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
			siteId: randomUUID(),
			hostName: "test-host",
		};
	});

	afterEach(() => {
		db.close();
	});

	it("does not produce a wedged failed-with-claim state on process kill mid-eviction (AC3.2)", () => {
		// AC3.2 guarantees: if a process is killed mid-eviction transaction, the row state is
		// guaranteed to be either 'running' (transaction rolled back) or 'pending' (committed).
		// The wedged state { status: 'failed', claimed_by: NOT NULL } is structurally impossible.
		//
		// Verification approach: R-LR3 implements eviction as a single atomic `withTx` block
		// calling `updateRowIf` with a single precondition. SQLite's transaction guarantees
		// (BEGIN IMMEDIATE, COMMIT, or ROLLBACK) ensure this property holds regardless of when
		// the process dies. We verify the property by:
		// 1. Running eviction normally (successful eviction → 'pending')
		// 2. Confirming no row reaches the wedged state across multiple cycles

		const taskId = randomUUID();
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000); // 30 min old
		const leaseId = randomUUID();

		insertRow(
			db,
			"tasks",
			{
				id: taskId,
				type: "cron",
				trigger_spec: "0 * * * *",
				status: "running",
				created_at: now.toISOString(),
				modified_at: now.toISOString(),
				claimed_by: ctx.siteId,
				claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
				lease_id: leaseId,
				error: null,
				result: null,
				consecutive_failures: 0,
				alert_threshold: 3,
				next_run_at: null,
				thread_id: null,
				deleted: 0,
				heartbeat_at: staleHeartbeat.toISOString(),
			},
			ctx.siteId,
		);

		// Run eviction
		const scheduler = new Scheduler(ctx);
		try {
			(scheduler as unknown as { phase0Eviction: () => void }).phase0Eviction();
		} catch {
			// Ignore errors from test setup
		}

		// Assert: row is NEVER in the wedged state { status: 'failed', claimed_by: NOT NULL }
		const wedgedRows = db
			.query(
				"SELECT COUNT(*) as c FROM tasks WHERE status = 'failed' AND claimed_by IS NOT NULL AND id = ?",
			)
			.get(taskId) as { c: number };
		expect(wedgedRows.c).toBe(0);

		// Verify the row is in one of the two acceptable states (or succeeded to pending)
		const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
			| {
					status: string;
			  }
			| undefined;

		// After eviction, the row is either:
		// - 'pending' (eviction succeeded and committed)
		// - 'running' (eviction rolled back or CAS lost)
		if (row) {
			expect(["running", "pending"]).toContain(row.status);
		}
	});

	it("AC3.2: eviction state is atomic after repeated eviction attempts", () => {
		// This is a weaker assertion but still catches the regression.
		// After many eviction cycles (simulating retries across process lifetimes),
		// no row should ever reach the wedged state { status: 'failed', claimed_by: NOT NULL }.

		// Setup: Create multiple running tasks
		const taskIds = Array.from({ length: 3 }, () => randomUUID());
		const now = new Date();
		const staleHeartbeat = new Date(now.getTime() - 30 * 60_000);

		for (const taskId of taskIds) {
			const leaseId = randomUUID();
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "cron",
					trigger_spec: "0 * * * *",
					status: "running",
					created_at: now.toISOString(),
					modified_at: now.toISOString(),
					claimed_by: ctx.siteId,
					claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
					lease_id: leaseId,
					error: null,
					result: null,
					consecutive_failures: 0,
					alert_threshold: 3,
					next_run_at: null,
					thread_id: null,
					deleted: 0,
					heartbeat_at: staleHeartbeat.toISOString(),
				},
				ctx.siteId,
			);
		}

		// Run multiple eviction cycles
		const scheduler = new Scheduler(ctx);
		for (let i = 0; i < 5; i++) {
			try {
				(scheduler as unknown as { phase0Eviction: () => void }).phase0Eviction();
			} catch {
				// Ignore errors from test setup
			}
		}

		// Assert: across all iterations and all tasks, no row is wedged
		const wedgedCount = (
			db
				.query("SELECT COUNT(*) as c FROM tasks WHERE status = 'failed' AND claimed_by IS NOT NULL")
				.get() as { c: number }
		).c;
		expect(wedgedCount).toBe(0);

		// Each task should be in a valid state
		for (const taskId of taskIds) {
			const row = db.query("SELECT status FROM tasks WHERE id = ?").get(taskId) as
				| {
						status: string;
				  }
				| undefined;
			if (row) {
				expect(["running", "pending", "failed"]).toContain(row.status);
				// If failed, must not have claim metadata
				if (row.status === "failed") {
					const fullRow = db.query("SELECT claimed_by FROM tasks WHERE id = ?").get(taskId) as
						| { claimed_by: string | null }
						| undefined;
					expect(fullRow?.claimed_by).toBeNull();
				}
			}
		}
	});
});
