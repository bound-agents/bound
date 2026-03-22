import type { Database } from "bun:sqlite";
import type { Task } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

// Cron expression parser - supports basic 5-field cron: minute hour day month weekday
// Returns the next execution time
function parseCron(cronExpr: string, from: Date = new Date()): Date {
	const fields = cronExpr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
	}

	const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = fields;

	// Parse each field into a set of valid values
	const minute = parseCronField(minuteStr, 0, 59);
	const hour = parseCronField(hourStr, 0, 23);
	const day = parseCronField(dayStr, 1, 31);
	const month = parseCronField(monthStr, 1, 12);
	const weekday = parseCronField(weekdayStr, 0, 6);

	// Find the next matching time
	const next = new Date(from);
	next.setSeconds(0);
	next.setMilliseconds(0);
	next.setMinutes(next.getMinutes() + 1);

	// Try up to 4 years in the future to avoid infinite loops
	const maxDate = new Date(from);
	maxDate.setFullYear(maxDate.getFullYear() + 4);

	while (next <= maxDate) {
		const m = next.getMinutes();
		const h = next.getHours();
		const d = next.getDate();
		const mon = next.getMonth() + 1;
		const dow = next.getDay();

		const minuteMatch = minute.has(m);
		const hourMatch = hour.has(h);
		const dayMatch = day.has(d);
		const monthMatch = month.has(mon);
		const weekdayMatch = weekday.has(dow);

		// Both day and weekday must match (OR condition per cron spec)
		const dateMatch = (dayMatch || weekdayMatch) && monthMatch;

		if (minuteMatch && hourMatch && dateMatch) {
			return next;
		}

		next.setMinutes(next.getMinutes() + 1);
	}

	throw new Error("Could not find next cron execution time");
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const result = new Set<number>();

	if (field === "*") {
		for (let i = min; i <= max; i++) {
			result.add(i);
		}
		return result;
	}

	if (field.includes(",")) {
		for (const part of field.split(",")) {
			const values = parseCronField(part, min, max);
			for (const v of values) {
				result.add(v);
			}
		}
		return result;
	}

	if (field.includes("/")) {
		const [range, step] = field.split("/");
		const stepNum = Number.parseInt(step, 10);
		if (Number.isNaN(stepNum)) {
			throw new Error(`Invalid step value: ${step}`);
		}

		let start = min;
		let end = max;

		if (range !== "*") {
			const rangeParts = range.split("-");
			start = Number.parseInt(rangeParts[0], 10);
			end = rangeParts[1] ? Number.parseInt(rangeParts[1], 10) : end;
			if (Number.isNaN(start) || Number.isNaN(end)) {
				throw new Error(`Invalid range: ${range}`);
			}
		}

		for (let i = start; i <= end; i += stepNum) {
			if (i >= min && i <= max) {
				result.add(i);
			}
		}
		return result;
	}

	if (field.includes("-")) {
		const [start, end] = field.split("-").map((s) => Number.parseInt(s, 10));
		if (Number.isNaN(start) || Number.isNaN(end)) {
			throw new Error(`Invalid range: ${field}`);
		}
		for (let i = start; i <= end; i++) {
			if (i >= min && i <= max) {
				result.add(i);
			}
		}
		return result;
	}

	const num = Number.parseInt(field, 10);
	if (Number.isNaN(num) || num < min || num > max) {
		throw new Error(`Invalid cron field: ${field} (must be ${min}-${max})`);
	}
	result.add(num);
	return result;
}

export function computeNextRunAt(cronExpr: string, from: Date = new Date()): Date {
	try {
		return parseCron(cronExpr, from);
	} catch (error) {
		throw new Error(
			`Failed to parse cron expression "${cronExpr}": ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function isDependencySatisfied(db: Database, task: Task): boolean {
	// If no dependencies, always satisfied
	if (!task.depends_on) {
		return true;
	}

	// Parse depends_on as JSON array of task IDs
	let dependencyIds: string[];
	try {
		dependencyIds = JSON.parse(task.depends_on);
	} catch {
		// If it's not valid JSON, assume it's a single task ID
		dependencyIds = [task.depends_on];
	}

	if (!Array.isArray(dependencyIds)) {
		return false;
	}

	for (const depId of dependencyIds) {
		const depTask = db.query("SELECT id, status FROM tasks WHERE id = ?").get(depId) as
			| { id: string; status: string }
			| undefined;

		if (!depTask) {
			// Dependency not found - consider it failed
			return false;
		}

		if (depTask.status !== "completed") {
			// Dependency not yet complete
			return false;
		}

		// If require_success is set and dependency failed, auto-fail this task
		if (task.require_success && depTask.status === "failed") {
			return false;
		}
	}

	return true;
}

export function canRunHere(db: Database, task: Task, hostName: string, siteId: string): boolean {
	// Check dependency satisfaction
	if (!isDependencySatisfied(db, task)) {
		return false;
	}

	// Check node affinity (requires field)
	if (task.requires) {
		try {
			const requires = JSON.parse(task.requires);
			if (typeof requires === "object" && requires !== null) {
				// Check if this host matches the requirements
				// For Phase 4, we do a simple string match on host_name
				if (typeof requires.host === "string" && requires.host !== hostName) {
					return false;
				}
			}
		} catch {
			// If requires is not valid JSON, skip the check
		}
	}

	return true;
}

export function seedCronTasks(
	db: Database,
	cronConfigs: Array<{ name: string; cron: string; payload?: string }>,
	siteId: string,
): void {
	const insert = db.prepare(`
		INSERT OR IGNORE INTO tasks (
			id, type, status, trigger_spec, payload, thread_id,
			claimed_by, claimed_at, lease_id, next_run_at, last_run_at,
			run_count, max_runs, requires, model_hint, no_history,
			inject_mode, depends_on, require_success, alert_threshold,
			consecutive_failures, event_depth, no_quiescence,
			heartbeat_at, result, error, created_at, created_by, modified_at, deleted
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	for (const config of cronConfigs) {
		const taskId = deterministicUUID(BOUND_NAMESPACE, `cron-${config.name}`);
		const now = new Date().toISOString();
		const nextRunAt = computeNextRunAt(config.cron).toISOString();

		insert.run(
			taskId, // id
			"cron", // type
			"pending", // status
			config.cron, // trigger_spec
			config.payload || null, // payload
			null, // thread_id
			null, // claimed_by
			null, // claimed_at
			null, // lease_id
			nextRunAt, // next_run_at
			null, // last_run_at
			0, // run_count
			null, // max_runs
			null, // requires
			null, // model_hint
			0, // no_history
			"status", // inject_mode
			null, // depends_on
			0, // require_success
			5, // alert_threshold (default)
			0, // consecutive_failures
			0, // event_depth
			0, // no_quiescence
			null, // heartbeat_at
			null, // result
			null, // error
			now, // created_at
			"system", // created_by
			now, // modified_at
			0, // deleted
		);
	}
}
