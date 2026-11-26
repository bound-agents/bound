import type { Database } from "bun:sqlite";
import { findTaskExistenceById, updateRow } from "@bound/core";

// ---------------------------------------------------------------------------
// taskUpdate
// ---------------------------------------------------------------------------

/**
 * Update mutable config on an existing task in place — the original motivation
 * (#100) was toggling `no_history` without forcing the agent to recreate the
 * task. Mirrors the agent `task` tool's update action and the `webhook update`
 * three-state flag conventions.
 *
 * Updatable fields:
 *   --no-history / --history   three-state no_history (1 / 0; neither = leave)
 *   --model <id> | --model ""  set / clear model_hint (absent = leave)
 *   --alert-threshold <n>      consecutive failures before advisory (> 0)
 *
 * Lifecycle/scheduling fields are not mutable here — use a cancel path to stop
 * a task.
 */
export interface TaskUpdateOptions {
	readonly id?: string;
	readonly noHistory?: boolean;
	readonly history?: boolean;
	readonly model?: string;
	readonly alertThreshold?: string;
}

export function taskUpdate(db: Database, siteId: string, options: TaskUpdateOptions): void {
	const { id } = options;
	if (!id) {
		throw new Error("--id is required");
	}

	// Three-state no_history (mirroring `webhook update`):
	//   neither flag   → leave alone
	//   --no-history   → set to 1 (disable history)
	//   --history      → set to 0 (re-enable history)
	const wantsNoHistory = options.noHistory === true;
	const wantsHistory = options.history === true;
	if (wantsNoHistory && wantsHistory) {
		throw new Error("--no-history and --history are mutually exclusive");
	}

	// Three-state model_hint:
	//   flag absent  → leave alone
	//   --model ""   → clear back to system default (null)
	//   --model <id> → set
	const modelProvided = options.model !== undefined;
	const modelValue = options.model;

	const alertRaw = options.alertThreshold;

	const task = findTaskExistenceById(db, id);
	if (!task || task.deleted === 1) {
		throw new Error(`Task '${id}' not found.`);
	}

	const updates: Record<string, unknown> = {};

	if (wantsNoHistory || wantsHistory) {
		updates.no_history = wantsNoHistory ? 1 : 0;
	}

	if (modelProvided) {
		updates.model_hint = modelValue && modelValue.length > 0 ? modelValue : null;
	}

	if (alertRaw !== undefined) {
		const n = Number(alertRaw);
		if (!Number.isInteger(n) || n <= 0) {
			throw new Error("--alert-threshold must be an integer greater than 0");
		}
		updates.alert_threshold = n;
	}

	if (Object.keys(updates).length === 0) {
		throw new Error(
			"Provide at least one of: --no-history/--history, --model <id>, --alert-threshold <n>",
		);
	}

	updateRow(db, "tasks", id, updates, siteId);

	console.log(`Task '${id}' updated (${Object.keys(updates).join(", ")}).`);
}
