import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase, insertRow, updateRowIf } from "@bound/core";
import { setChangelogEventBus } from "@bound/core";
import type { ChangeLogEntry } from "@bound/shared";
import { applyLWWReducer } from "@bound/sync";

describe("heartbeat-at multi-host LWW propagation", () => {
	let dbA: Database;
	let dbB: Database;
	let siteIdA: string;

	beforeEach(() => {
		// Create two in-memory databases with full schema
		dbA = createDatabase(":memory:");
		dbB = createDatabase(":memory:");

		applySchema(dbA);
		applySchema(dbB);

		// Disable event bus for tests to avoid side effects
		setChangelogEventBus(null);

		// Create unique site IDs for each host simulation
		siteIdA = randomUUID();
	});

	afterEach(() => {
		dbA.close();
		dbB.close();
		// Restore event bus in case other tests need it
		setChangelogEventBus(null);
	});

	it("AC1.1: Single heartbeat refresh propagates to host B via LWW", () => {
		const taskId = randomUUID();
		const leaseId = randomUUID();
		const now = new Date().toISOString();

		// Insert a running task on host A using insertRow (which creates change_log entry)
		insertRow(
			dbA,
			"tasks",
			{
				id: taskId,
				type: "heartbeat",
				status: "running",
				trigger_spec: "*/30 * * * *",
				payload: null,
				created_at: now,
				created_by: siteIdA,
				thread_id: null,
				claimed_by: siteIdA,
				claimed_at: now,
				lease_id: leaseId,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Get the initial insert changelog entries and replay them to dbB
		const insertEntries = dbA
			.prepare("SELECT * FROM change_log WHERE table_name = ? ORDER BY hlc ASC")
			.all("tasks") as ChangeLogEntry[];

		expect(insertEntries.length).toBeGreaterThan(0);

		for (const entry of insertEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Verify dbB has the row initially with no heartbeat_at
		let rowB = dbB.prepare("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId) as {
			heartbeat_at: string | null;
		} | null;
		expect(rowB).not.toBeNull();
		expect(rowB?.heartbeat_at).toBeNull();

		// Trigger a heartbeat refresh on host A using updateRowIf
		const t1 = new Date().toISOString();
		const refreshSuccess = updateRowIf(
			dbA,
			"tasks",
			taskId,
			{ lease_id: leaseId },
			{ heartbeat_at: t1 },
			siteIdA,
		);
		expect(refreshSuccess).toBe(true);

		// Get NEW changelog entries since the insert and replay to dbB
		const refreshEntries = dbA
			.prepare(
				`SELECT * FROM change_log WHERE table_name = ? AND hlc > ?
				ORDER BY hlc ASC`,
			)
			.all("tasks", insertEntries[insertEntries.length - 1]?.hlc ?? "0") as ChangeLogEntry[];

		expect(refreshEntries.length).toBe(1);

		for (const entry of refreshEntries) {
			applyLWWReducer(dbB, entry);
		}

		// AC1.1: Assert dbB's heartbeat_at matches t1
		rowB = dbB.prepare("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId) as {
			heartbeat_at: string | null;
		} | null;
		expect(rowB).not.toBeNull();
		expect(rowB?.heartbeat_at).toBe(t1);
	});

	it("AC1.2: Two close-in-time refreshes resolve LWW (order-independent)", async () => {
		const taskId = randomUUID();
		const leaseId = randomUUID();
		const now = new Date().toISOString();

		// Insert a running task on host A
		insertRow(
			dbA,
			"tasks",
			{
				id: taskId,
				type: "heartbeat",
				status: "running",
				trigger_spec: "*/30 * * * *",
				payload: null,
				created_at: now,
				created_by: siteIdA,
				thread_id: null,
				claimed_by: siteIdA,
				claimed_at: now,
				lease_id: leaseId,
				next_run_at: null,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: null,
				no_history: 0,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now,
				deleted: 0,
			} as any,
			siteIdA,
		);

		// Get the initial insert changelog entries and replay them to dbB
		const insertEntries = dbA
			.prepare("SELECT * FROM change_log WHERE table_name = ? ORDER BY hlc ASC")
			.all("tasks") as ChangeLogEntry[];

		for (const entry of insertEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Trigger TWO close-in-time refreshes on host A
		// First refresh
		const t2 = new Date().toISOString();
		let refreshSuccess = updateRowIf(
			dbA,
			"tasks",
			taskId,
			{ lease_id: leaseId },
			{ heartbeat_at: t2 },
			siteIdA,
		);
		expect(refreshSuccess).toBe(true);

		// Sleep to ensure different modified_at timestamp
		await new Promise((r) => setTimeout(r, 2));

		// Second refresh (with later timestamp)
		const t3 = new Date(Date.parse(t2) + 1).toISOString();
		refreshSuccess = updateRowIf(
			dbA,
			"tasks",
			taskId,
			{ lease_id: leaseId },
			{ heartbeat_at: t3 },
			siteIdA,
		);
		expect(refreshSuccess).toBe(true);

		// Get NEW changelog entries and replay to dbB IN ORDER
		const finalEntries = dbA
			.prepare(
				`SELECT * FROM change_log WHERE table_name = ? AND hlc > ?
				ORDER BY hlc ASC`,
			)
			.all("tasks", insertEntries[insertEntries.length - 1]?.hlc ?? "0") as ChangeLogEntry[];

		expect(finalEntries.length).toBe(2);

		// Replay in order
		for (const entry of finalEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Assert dbB's heartbeat_at === t3 (later timestamp wins)
		let finalB = dbB.prepare("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId) as {
			heartbeat_at: string | null;
		} | null;
		expect(finalB).not.toBeNull();
		expect(finalB?.heartbeat_at).toBe(t3);

		// Now test LWW convergence: reset dbB and replay in REVERSE order
		dbB.close();
		dbB = createDatabase(":memory:");
		applySchema(dbB);

		// Re-insert the original row to dbB
		for (const entry of insertEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Replay final entries IN REVERSE order
		const reversedEntries = [...finalEntries].reverse();
		for (const entry of reversedEntries) {
			applyLWWReducer(dbB, entry);
		}

		// Assert dbB's heartbeat_at === t3 STILL (LWW must converge regardless of replay order)
		finalB = dbB.prepare("SELECT heartbeat_at FROM tasks WHERE id = ?").get(taskId) as {
			heartbeat_at: string | null;
		} | null;
		expect(finalB).not.toBeNull();
		expect(finalB?.heartbeat_at).toBe(t3);
	});
});
