import type { Database } from "bun:sqlite";
import { insertRow, updateRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export const DISPATCHER_TASK_ID = deterministicUUID(BOUND_NAMESPACE, "platform-dispatcher");

/**
 * Seeds the platform dispatcher task. Idempotent — safe to call on every startup.
 * The dispatcher wakes on "connector:list_changed" events and periodic cron fallback.
 */
export function seedDispatcher(db: Database, siteId: string): void {
	const existing = db
		.query("SELECT id, status FROM tasks WHERE id = ?")
		.get(DISPATCHER_TASK_ID) as {
		id: string;
		status: string;
	} | null;
	if (existing) {
		if (existing.status === "failed" || existing.status === "cancelled") {
			updateRow(
				db,
				"tasks",
				DISPATCHER_TASK_ID,
				{
					status: "pending",
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					error: null,
					next_run_at: null,
				},
				siteId,
			);
		}
		// Migrate existing dispatcher tasks: stateless + clear stale requires affinity.
		db.prepare(
			"UPDATE tasks SET no_history = 1, requires = NULL WHERE id = ? AND (no_history = 0 OR requires IS NOT NULL)", // outbox-exempt: legacy migration
		).run(DISPATCHER_TASK_ID);
		return;
	}

	const now = new Date().toISOString();
	insertRow(
		db,
		"tasks",
		{
			id: DISPATCHER_TASK_ID,
			type: "event",
			status: "pending",
			trigger_spec: "connector:list_changed",
			payload: null,
			created_at: now,
			created_by: "system",
			thread_id: null, // thread created on first execution
			origin_thread_id: null,
			claimed_by: null,
			claimed_at: null,
			lease_id: null,
			next_run_at: now, // immediately available for first cron fallback
			last_run_at: null,
			run_count: 0,
			max_runs: null,
			requires: null,
			model_hint: null,
			no_history: 1, // stateless: tools + orientation are sufficient context each wake
			inject_mode: "results",
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
		},
		siteId,
	);
}
