import type { Database } from "bun:sqlite";
import { insertRow } from "@bound/core";
import type { HeartbeatConfig, Task } from "@bound/shared";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";

/**
 * Deterministic idempotency key for a single task firing, stable across hosts.
 *
 * Two hosts that race the same pending row both read the same `(id, next_run_at)`
 * snapshot — that pair IS the firing they collide on — so they compute the same
 * key and (via {@link deriveFiringWakeupIds}) the same synthetic-wakeup message
 * ids. The two wakeup triplets they each insert then LWW-collapse to one set on
 * sync, bounding the blast radius of a split-brain double-dispatch (#46) to wasted
 * inference rather than a doubled, interleaved wakeup structure in the thread.
 *
 * `scheduledRunAt` is the task's `next_run_at` at claim time — the due instant,
 * before `rescheduleHeartbeat` / `rescheduleCronTask` advances it at completion.
 * The claim CAS (`pending → claimed → running`) never touches `next_run_at`, so
 * the value in the `runTask` snapshot is still the scheduled instant.
 *
 * Returns `null` when there is no scheduled instant to key on (event tasks carry
 * `next_run_at = NULL`); callers fall back to random ids — i.e. current behavior —
 * for those firings.
 *
 * Note: this converges the persisted *effect* of a double-dispatch; it does not
 * prevent the second run. Leaderless exactly-once dispatch needs consensus over
 * claims, which is tracked separately (#46). Idempotent effects are the
 * topology-independent half of that fix.
 */
export function computeFiringKey(taskId: string, scheduledRunAt: string | null): string | null {
	if (!scheduledRunAt) {
		return null;
	}
	return `firing:${taskId}:${scheduledRunAt}`;
}

export interface FiringWakeupIds {
	wakeupMessageId: string;
	toolCallMessageId: string;
	toolResultMessageId: string;
	toolUseId: string;
}

/**
 * Derive the deterministic ids for the synthetic wakeup triplet
 * (developer notice → assistant `tool_call` → `tool_result`) from a firing key.
 *
 * `toolUseId` keeps the `tooluse_` prefix + 22-char body shape the random path
 * produced, within the `[a-zA-Z0-9_-]` charset (and ≤ 64-char length) every
 * supported provider accepts — see the cross-provider tool_use portability note
 * in CONTRIBUTING.md.
 */
export function deriveFiringWakeupIds(firingKey: string): FiringWakeupIds {
	return {
		wakeupMessageId: deterministicUUID(BOUND_NAMESPACE, `${firingKey}:wakeup`),
		toolCallMessageId: deterministicUUID(BOUND_NAMESPACE, `${firingKey}:toolcall`),
		toolResultMessageId: deterministicUUID(BOUND_NAMESPACE, `${firingKey}:toolresult`),
		toolUseId: `tooluse_${deterministicUUID(BOUND_NAMESPACE, `${firingKey}:tooluse`)
			.replace(/-/g, "")
			.slice(0, 22)}`,
	};
}

/**
 * Derive a deterministic message id for one *other* per-firing artifact (beyond
 * the wakeup triplet) from a firing key — the quiescence note the scheduler
 * appends at wakeup, the alert it persists on a hard failure, etc.
 *
 * Same convergence property as {@link deriveFiringWakeupIds}: two hosts racing
 * the same firing derive the same `(firing key, artifact)` id, so the rows they
 * each insert LWW-collapse to one on sync rather than doubling in the thread.
 * The `artifact` suffix keeps these distinct from the triplet ids and from each
 * other within a single firing. Callers fall back to a random id when the firing
 * has no scheduled instant to key on (event tasks).
 */
export function deriveFiringArtifactId(firingKey: string, artifact: string): string {
	return deterministicUUID(BOUND_NAMESPACE, `${firingKey}:${artifact}`);
}

/** A host eligible to dispatch a firing, identified by its synced `hosts` row. */
export interface FiringCandidateHost {
	siteId: string;
	hostName: string;
}

/**
 * Leaderless rendezvous (highest-random-weight) selection of the single host
 * that should dispatch a given firing.
 *
 * Each host scores every candidate as `deterministicUUID(firingKey:siteId)` and
 * the highest score wins. Because the firing key and the candidate set are both
 * synced cluster state, every host that observes the same inputs computes the
 * same winner with no coordination round-trip — two dispatchers working a
 * single-track 交換駅 off the same 運行図, each deriving the identical passing
 * assignment without speaking. They only diverge when their views of the inputs
 * diverge (a real partition / clock skew), where dispatch degrades cleanly back
 * to the firing-key idempotency backstop (#46).
 *
 * HRW (vs. modulo-hashing the key onto a host index) keeps the assignment stable
 * under membership churn: when a host leaves, only the firings it owned move, and
 * they redistribute deterministically across the survivors rather than reshuffling
 * the whole map. The UUID string compare is a total order; the explicit `<`/`>`
 * tie-break on `siteId` keeps selection deterministic even in the (astronomically
 * unlikely) event of equal scores.
 *
 * Returns the winning `siteId`, or `null` when there are no candidates.
 */
export function selectFiringHost(
	firingKey: string,
	candidates: FiringCandidateHost[],
): string | null {
	let winnerSiteId: string | null = null;
	let winnerScore = "";
	for (const { siteId } of candidates) {
		const score = deterministicUUID(BOUND_NAMESPACE, `${firingKey}:${siteId}`);
		if (
			winnerSiteId === null ||
			score > winnerScore ||
			(score === winnerScore && siteId > winnerSiteId)
		) {
			winnerSiteId = siteId;
			winnerScore = score;
		}
	}
	return winnerSiteId;
}

/**
 * Liveness window for firing-key rendezvous candidacy. A host is a dispatch
 * candidate only when its heartbeat-maintained `modified_at` (falling back to
 * `online_at`) is fresh within this window — mirrors the client-session window
 * in `delegation.ts` and `relay-router`'s `STALE_THRESHOLD_MS`.
 */
export const FIRING_HOST_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Per-host dispatch gate: `canRunHere` AND (when this firing has a schedule key)
 * the rendezvous winner.
 *
 * This is the leaderless coordination layer for singleton dispatch (#46). The
 * firing-key idempotency keys converge the *persisted effects* of a double
 * dispatch after the fact; this gate avoids the double dispatch in the first
 * place during normal operation, where every live host shares the same `hosts`
 * view and so agrees on one winner. It does NOT claim exactly-once under a
 * partition — when views diverge, two hosts can each believe they won, and the
 * idempotency backstop is what bounds the blast radius there. Eliminating the
 * partition case is consensus, tracked separately.
 *
 * Degradation is deliberate:
 * - Event firings carry `next_run_at = NULL` → no firing key → no rendezvous;
 *   returns the bare `canRunHere` verdict (event intake is hub-affined and
 *   idempotency-keyed elsewhere).
 * - A lone live host (or only this host) → no contention → runs.
 * - This host is ALWAYS a candidate even if the `hosts` table hasn't caught up
 *   to its own registration — a host knows it is live. The residual availability
 *   cost is the inverse: a peer that is fresh-in-table but already dead can win a
 *   firing that is then skipped until liveness eviction reassigns it (a missed
 *   heartbeat beat, recovered next tick).
 *
 * Candidates are the live hosts that are THEMSELVES eligible for this task
 * (`canRunHere` evaluated against each peer's host_name/site_id), so a
 * host-pinned task rendezvouses only over the hosts its affinity admits.
 */
export function shouldDispatchHere(
	db: Database,
	task: Task,
	hostName: string,
	siteId: string,
	staleMs: number = FIRING_HOST_STALE_MS,
): boolean {
	if (!canRunHere(db, task, hostName, siteId)) {
		return false;
	}

	const firingKey = computeFiringKey(task.id, task.next_run_at);
	if (firingKey === null) {
		// No scheduled instant to key on (event firing) — rely on canRunHere +
		// intake affinity + the idempotency backstop, exactly as before HRW.
		return true;
	}

	const cutoff = Date.now() - staleMs;
	const rows = db
		.query("SELECT site_id, host_name, modified_at, online_at FROM hosts WHERE deleted = 0")
		.all() as Array<{
		site_id: string;
		host_name: string | null;
		modified_at: string | null;
		online_at: string | null;
	}>;

	const candidates: FiringCandidateHost[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.site_id)) continue;
		const ts = row.modified_at ?? row.online_at;
		if (!ts || new Date(ts).getTime() < cutoff) continue;
		const peerHostName = row.host_name ?? row.site_id;
		// Only hosts that pass this task's own affinity/dependency gate contend.
		if (!canRunHere(db, task, peerHostName, row.site_id)) continue;
		seen.add(row.site_id);
		candidates.push({ siteId: row.site_id, hostName: peerHostName });
	}

	// This host knows it is live even if its hosts row lags or is missing.
	if (!seen.has(siteId)) {
		candidates.push({ siteId, hostName });
	}

	if (candidates.length <= 1) {
		return true;
	}

	return selectFiringHost(firingKey, candidates) === siteId;
}

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

	// Find the next matching time.
	//
	// Cron expressions are interpreted in UTC. We use UTC getters/setters throughout
	// so that a given cron spec fires at the same wall-clock UTC moment regardless of
	// host timezone — critical for multi-host cluster deployment and for consistency
	// with all other timestamps in the system (outcomes, messages, task metadata all
	// serialize as UTC via toISOString()).
	const next = new Date(from);
	next.setUTCSeconds(0);
	next.setUTCMilliseconds(0);
	next.setUTCMinutes(next.getUTCMinutes() + 1);

	// Try up to 4 years in the future to avoid infinite loops
	const maxDate = new Date(from);
	maxDate.setUTCFullYear(maxDate.getUTCFullYear() + 4);

	while (next <= maxDate) {
		const m = next.getUTCMinutes();
		const h = next.getUTCHours();
		const d = next.getUTCDate();
		const mon = next.getUTCMonth() + 1;
		const dow = next.getUTCDay();

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

		next.setUTCMinutes(next.getUTCMinutes() + 1);
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
		throw new Error(`Failed to parse cron expression "${cronExpr}": ${formatError(error)}`);
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

		// Check if dependency failed and require_success is set
		if (task.require_success && depTask.status === "failed") {
			return false;
		}

		if (depTask.status !== "completed") {
			// Dependency not yet complete
			return false;
		}
	}

	return true;
}

/**
 * Verify that the lease on `taskId` is still held by `(siteId, leaseId)`.
 *
 * The phase1 (`pending → claimed`) and phase3 (`claimed → running`) CAS updates
 * are local-only on each replica's SQLite. In a multi-master cluster, two hosts
 * polling concurrently can each see `status='pending'` in their local DB and
 * each succeed at their local CAS — both then proceed to `runTask`, both insert
 * `[Task wakeup]` developer rows, both launch agent loops on the same thread.
 *
 * This helper closes that window: after the local `claimed → running` CAS,
 * `runTask` waits for sync to settle and re-reads the row. If LWW resolution
 * has overwritten our claim with a peer's, we observe a mismatch here and bail
 * before any agent-loop side effects (developer message inserts, tool runs).
 *
 * NOT race-free: the settle wait is heuristic. A sync RTT exceeding the wait
 * still slips through. This is defense-in-depth, not consensus — the proper
 * fix is cluster-wide singleton coordination (tracked separately).
 */
export function verifyLeaseStillHeld(
	db: Database,
	taskId: string,
	expectedSiteId: string,
	expectedLeaseId: string,
):
	| { held: true }
	| {
			held: false;
			reason:
				| "row_missing"
				| "row_deleted"
				| "claimed_by_mismatch"
				| "lease_id_mismatch"
				| "status_not_running";
			actual: {
				claimed_by: string | null;
				lease_id: string | null;
				status: string;
				deleted: number;
			} | null;
	  } {
	const row = db
		.query("SELECT claimed_by, lease_id, status, deleted FROM tasks WHERE id = ?")
		.get(taskId) as {
		claimed_by: string | null;
		lease_id: string | null;
		status: string;
		deleted: number;
	} | null;
	if (!row) {
		return { held: false, reason: "row_missing", actual: null };
	}
	if (row.deleted) {
		return { held: false, reason: "row_deleted", actual: row };
	}
	if (row.claimed_by !== expectedSiteId) {
		return { held: false, reason: "claimed_by_mismatch", actual: row };
	}
	if (row.lease_id !== expectedLeaseId) {
		return { held: false, reason: "lease_id_mismatch", actual: row };
	}
	if (row.status !== "running") {
		return { held: false, reason: "status_not_running", actual: row };
	}
	return { held: true };
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
				if (requires.host !== undefined) {
					const hostReq = requires.host;
					if (typeof hostReq === "string") {
						// Simple string match or glob pattern
						if (hostReq.includes("*")) {
							// Convert glob to regex: * becomes .*
							const pattern = new RegExp(`^${hostReq.replace(/\*/g, ".*")}$`);
							if (!pattern.test(hostName)) {
								return false;
							}
						} else {
							// Exact match
							if (hostReq !== hostName) {
								return false;
							}
						}
					} else if (Array.isArray(hostReq)) {
						// Array of hosts — match if hostName is in the array
						if (!hostReq.includes(hostName)) {
							return false;
						}
					}
				}

				// Check site_id requirement
				if (typeof requires.site_id === "string" && requires.site_id !== siteId) {
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
	for (const config of cronConfigs) {
		const taskId = deterministicUUID(BOUND_NAMESPACE, `cron-${config.name}`);
		const now = new Date().toISOString();
		const nextRunAt = computeNextRunAt(config.cron).toISOString();

		// Check if task already exists (idempotent)
		const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(taskId) as {
			id: string;
		} | null;

		if (!existing) {
			insertRow(
				db,
				"tasks",
				{
					id: taskId,
					type: "cron",
					status: "pending",
					trigger_spec: config.cron,
					payload: config.payload || null,
					thread_id: null,
					origin_thread_id: null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: nextRunAt,
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
					system_prompt_addition: null,
					heartbeat_at: null,
					result: null,
					error: null,
					created_at: now,
					created_by: "system",
					modified_at: now,
					deleted: 0,
				},
				siteId,
			);
		}
	}
}

export function seedHeartbeat(
	db: Database,
	heartbeatConfig: HeartbeatConfig | undefined,
	siteId: string,
): void {
	// Default: enabled with 30min interval
	const config = heartbeatConfig ?? { enabled: true, interval_ms: 1_800_000 };

	if (!config.enabled) return;

	const id = deterministicUUID(BOUND_NAMESPACE, "heartbeat");
	const now = new Date();
	const intervalMs = config.interval_ms;
	const nextBoundary = Math.ceil(now.getTime() / intervalMs) * intervalMs;
	const nextRunAt = new Date(nextBoundary).toISOString();
	const triggerSpec = JSON.stringify({ type: "heartbeat", interval_ms: intervalMs });
	const modelHint = config.model_hint ?? null;

	// Check if heartbeat task already exists (idempotent)
	const existing = db.query("SELECT id FROM tasks WHERE id = ?").get(id) as {
		id: string;
	} | null;

	if (!existing) {
		insertRow(
			db,
			"tasks",
			{
				id,
				type: "heartbeat",
				status: "pending",
				trigger_spec: triggerSpec,
				payload: null,
				created_at: now.toISOString(),
				created_by: "system",
				thread_id: null,
				origin_thread_id: null,
				claimed_by: null,
				claimed_at: null,
				lease_id: null,
				next_run_at: nextRunAt,
				last_run_at: null,
				run_count: 0,
				max_runs: null,
				requires: null,
				model_hint: modelHint,
				no_history: 1,
				inject_mode: "status",
				depends_on: null,
				require_success: 0,
				alert_threshold: 5,
				consecutive_failures: 0,
				event_depth: 0,
				no_quiescence: 0,
				system_prompt_addition: null,
				heartbeat_at: null,
				result: null,
				error: null,
				modified_at: now.toISOString(),
				deleted: 0,
			},
			siteId,
		);
	}

	// Migrate existing heartbeat tasks: the heartbeat doesn't need conversation
	// history — it receives volatile enrichment (standing instructions, task digest,
	// thread activity) which provides all necessary context. Loading history on a
	// long-running heartbeat thread wastes tokens on stale self-referential output.
	db.prepare(
		"UPDATE tasks SET no_history = 1 WHERE type = 'heartbeat' AND no_history = 0", // outbox-exempt: legacy migration
		// TODO: follow-up RFC — route through insertRow/updateRow or formalize as semantic exception
	).run();
}
