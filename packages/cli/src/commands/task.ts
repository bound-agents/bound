import type { Database } from "bun:sqlite";
import { updateRow } from "@bound/core";

// ---------------------------------------------------------------------------
// arg helpers (mirrors the local helpers in webhook.ts)
// ---------------------------------------------------------------------------

function getArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

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
export function taskUpdate(db: Database, siteId: string, args: string[]): void {
	const id = getArgValue(args, "--id") ?? args[0];
	if (!id || id.startsWith("--")) {
		throw new Error("--id is required");
	}

	// Three-state no_history (mirroring `webhook update`):
	//   neither flag   → leave alone
	//   --no-history   → set to 1 (disable history)
	//   --history      → set to 0 (re-enable history)
	const wantsNoHistory = hasFlag(args, "--no-history");
	const wantsHistory = hasFlag(args, "--history");
	if (wantsNoHistory && wantsHistory) {
		throw new Error("--no-history and --history are mutually exclusive");
	}

	// Three-state model_hint:
	//   flag absent  → leave alone
	//   --model ""   → clear back to system default (null)
	//   --model <id> → set
	const modelIdx = args.indexOf("--model");
	const modelProvided = modelIdx !== -1;
	const modelValue = modelProvided ? (args[modelIdx + 1] ?? "") : undefined;

	const alertRaw = getArgValue(args, "--alert-threshold");

	const task = db.prepare("SELECT id, deleted FROM tasks WHERE id = ?").get(id) as {
		id: string;
		deleted: number;
	} | null;
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
		const n = Number.parseInt(alertRaw, 10);
		if (!Number.isFinite(n) || n <= 0) {
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
