import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID, formatError } from "@bound/shared";
import type { Task } from "@bound/shared";
import { createAdvisory } from "./advisories";
import type { AgentLoop } from "./agent-loop";
import { buildHeartbeatContext } from "./heartbeat-context";
import { canRunHere, computeNextRunAt } from "./task-resolution";
import type { AgentLoopConfig } from "./types";

const LEASE_DURATION = 300000; // 5 minutes

/**
 * Extracts the raw cron expression from a trigger_spec string.
 * The schedule command stores trigger_spec as JSON like {"type":"cron","expression":"0 * * * *"},
 * but seedCronTasks stores raw cron strings like "0 * * * *".
 * This helper handles both formats.
 */
function extractCronExpression(triggerSpec: string): string {
	try {
		const parsed = JSON.parse(triggerSpec);
		if (parsed && typeof parsed.expression === "string") {
			return parsed.expression;
		}
	} catch {
		// Not JSON — treat as raw cron expression
	}
	return triggerSpec;
}
const EVICTION_TIMEOUT = 300_000; // 5 minutes
const CRON_THREAD_ROTATION_THRESHOLD = 200;
const DEFERRED_MAX_RETRIES = 2;
const DEFERRED_RETRY_BACKOFF_MS = 5_000; // 5 seconds per consecutive failure

/**
 * Reschedules a cron task to its next run time and resets status to 'pending'.
 * Extracted as a helper because this logic is needed in three places:
 * soft errors, hard errors, and model validation failures.
 */
function rescheduleCronTask(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
): void {
	if (task.type !== "cron" || !task.trigger_spec) return;
	try {
		const cronExpr = extractCronExpression(task.trigger_spec);
		const nextRunAt = computeNextRunAt(cronExpr, new Date());
		db.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?").run(
			nextRunAt.toISOString(),
			task.id,
		);
	} catch (cronError) {
		logger.error(`Failed to compute next cron time after ${context}`, {
			error: formatError(cronError),
			taskId: task.id,
		});
	}
}

/**
 * Auto-retries a failed deferred task if consecutive_failures is below the retry limit.
 * Uses linear backoff (30s * consecutive_failures). Returns true if retried.
 */
function retryDeferredTask(
	db: AppContext["db"],
	task: Task,
	consecutiveFailures: number,
	logger: AppContext["logger"],
): boolean {
	if (task.type !== "deferred") return false;
	if (consecutiveFailures >= DEFERRED_MAX_RETRIES) return false;
	try {
		const backoffMs = DEFERRED_RETRY_BACKOFF_MS * consecutiveFailures;
		const nextRunAt = new Date(Date.now() + backoffMs).toISOString();
		db.query(
			"UPDATE tasks SET status = 'pending', next_run_at = ?, claimed_by = NULL, claimed_at = NULL, lease_id = NULL WHERE id = ?",
		).run(nextRunAt, task.id);
		logger.info(
			`Retrying deferred task ${task.id} (attempt ${consecutiveFailures + 1}/${DEFERRED_MAX_RETRIES})`,
			{
				taskId: task.id,
				backoffMs,
			},
		);
		return true;
	} catch (retryError) {
		logger.error("Failed to retry deferred task", {
			error: formatError(retryError),
			taskId: task.id,
		});
		return false;
	}
}

/**
 * Reschedules a heartbeat task to the next clock-aligned boundary and resets status to 'pending'.
 * Clock alignment ensures heartbeats fire at predictable times (e.g., every 30 minutes at :00 and :30).
 * Respects quiescence multipliers to reduce frequency during idle periods.
 */
export function rescheduleHeartbeat(
	db: AppContext["db"],
	task: Task,
	logger: AppContext["logger"],
	context: string,
	lastUserInteractionAt: Date,
): void {
	if (task.type !== "heartbeat") return;

	let intervalMs: number;
	try {
		const spec = JSON.parse(task.trigger_spec);
		intervalMs = spec.interval_ms;
		if (!intervalMs || intervalMs < 60_000) {
			logger.error(`[@bound/agent/scheduler] Invalid heartbeat interval_ms: ${intervalMs}`);
			return;
		}
	} catch {
		logger.error(
			`[@bound/agent/scheduler] Failed to parse heartbeat trigger_spec: ${task.trigger_spec}`,
		);
		return;
	}

	// Compute quiescence multiplier using the shared helper
	const multiplier = computeQuiescenceMultiplier(lastUserInteractionAt);

	const now = Date.now();
	const effectiveInterval = intervalMs * multiplier;
	const nextBoundary = Math.ceil(now / effectiveInterval) * effectiveInterval;
	const nextRunAt = new Date(nextBoundary).toISOString();

	db.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?").run(
		nextRunAt,
		task.id,
	);

	logger.info(
		`[@bound/agent/scheduler] Rescheduled heartbeat (${context}): next_run_at=${nextRunAt}, multiplier=${multiplier}x, effective_interval=${effectiveInterval}ms`,
	);
}

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_EVENT_DEPTH = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Graduated quiescence tiers (idle duration in ms → multiplier)
// Thresholds are the lower bound of each idle band
const QUIESCENCE_TIERS: Array<{ threshold: number; multiplier: number }> = [
	{ threshold: 0, multiplier: 1 }, // 0-30m idle: ×1 (active user, use configured interval)
	{ threshold: 1_800_000, multiplier: 2 }, // 30m-1h idle: ×2
	{ threshold: 3_600_000, multiplier: 3 }, // 1-4h idle: ×3
	{ threshold: 14_400_000, multiplier: 5 }, // 4-12h idle: ×5
	{ threshold: 43_200_000, multiplier: 10 }, // 12-24h idle: ×10
];

/** Minimum idle duration before quiescence note is injected into task context. */
const QUIESCENCE_NOTE_THRESHOLD = 1_800_000; // 30 minutes

/**
 * Compute quiescence multiplier based on idle duration.
 * Returns the multiplier from QUIESCENCE_TIERS based on how long
 * the system has been idle.
 */
export function computeQuiescenceMultiplier(lastUserInteractionAt: Date): number {
	const inactivityMs = Date.now() - lastUserInteractionAt.getTime();
	let multiplier = 1;
	for (let i = QUIESCENCE_TIERS.length - 1; i >= 0; i--) {
		const tier = QUIESCENCE_TIERS[i];
		if (inactivityMs >= tier.threshold) {
			multiplier = tier.multiplier;
			break;
		}
	}
	return multiplier;
}

/**
 * Format idle duration in milliseconds to a human-readable string.
 * Examples: "30m", "2h 15m", "0m".
 */
export function formatIdleDuration(ms: number): string {
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

interface SchedulerConfig {
	pollInterval?: number;
	syncEnabled?: boolean;
	/**
	 * Optional model-hint validator called before each task run.
	 * Returns { ok: true } when the model is available, { ok: false, error } otherwise.
	 * When absent, model hints are not validated at run time (existing behaviour).
	 */
	modelValidator?: (modelId: string) => { ok: true } | { ok: false; error: string };
	/**
	 * Optional callback to generate a thread title after a task's agent loop completes.
	 * Called with the thread ID; fire-and-forget (errors are logged, not propagated).
	 */
	generateTitle?: (threadId: string) => Promise<void>;
}

export class Scheduler {
	private running = false;
	private intervalId: ReturnType<typeof setTimeout> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastUserInteractionAt = new Date();
	private eventDepth = 0;
	private runningTasks = new Map<string, { leaseId: string; startedAt: Date }>();
	private operatorUserId: string;

	constructor(
		private ctx: AppContext,
		private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
		private config: SchedulerConfig = {},
		private sandbox?: {
			exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
		},
	) {
		// Resolve operator user ID so scheduler threads are visible in the operator's cross-thread digest.
		// allowlist is a required config — startup fails without it, so default_web_user is always present.
		this.operatorUserId = deterministicUUID(BOUND_NAMESPACE, ctx.config.allowlist.default_web_user);

		// Register event handler for all event types
		ctx.eventBus.on("message:created", () => this.onUserInteraction());
	}

	start(pollInterval: number = POLL_INTERVAL): { stop: () => void } {
		if (this.running) {
			throw new Error("Scheduler already running");
		}

		this.running = true;
		this.lastUserInteractionAt = new Date();

		// Start heartbeat updates for running tasks
		this.heartbeatInterval = setInterval(() => {
			try {
				this.updateHeartbeats();
			} catch (err: unknown) {
				if (err instanceof RangeError && String(err.message).includes("closed database")) {
					this.running = false;
					if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
					if (this.intervalId) clearTimeout(this.intervalId);
					return;
				}
				throw err;
			}
		}, HEARTBEAT_INTERVAL);

		// Start main scheduler loop with dynamic quiescence-based interval
		const scheduleTick = () => {
			if (!this.running) return;

			try {
				this.tick();

				// Recalculate interval based on quiescence and reset timer
				const effectiveInterval = this.getEffectivePollInterval();
				this.intervalId = setTimeout(scheduleTick, effectiveInterval);
			} catch (err: unknown) {
				// Auto-stop on closed database — prevents leaked timers from
				// crashing the process when a test closes the DB before stop().
				if (err instanceof RangeError && String(err.message).includes("closed database")) {
					this.running = false;
					return;
				}
				throw err;
			}
		};

		this.intervalId = setTimeout(scheduleTick, pollInterval);

		this.ctx.logger.info("Scheduler started");

		return {
			stop: () => this.stop(),
		};
	}

	stop(): void {
		if (!this.running) {
			return;
		}

		this.running = false;

		if (this.intervalId) {
			clearTimeout(this.intervalId);
			this.intervalId = null;
		}

		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}

		this.ctx.logger.info("Scheduler stopped");
	}

	private onUserInteraction(): void {
		this.lastUserInteractionAt = new Date();
		this.eventDepth = 0;
	}

	private updateHeartbeats(): void {
		if (!this.running) return;

		const now = new Date().toISOString();
		for (const [taskId, info] of this.runningTasks.entries()) {
			this.ctx.db
				.query("UPDATE tasks SET heartbeat_at = ? WHERE id = ? AND lease_id = ?")
				.run(now, taskId, info.leaseId);
		}
	}

	private tick(): void {
		if (!this.running) return;

		try {
			// Check for emergency stop
			const emergencyStop = this.ctx.db
				.query("SELECT value FROM cluster_config WHERE key = 'emergency_stop'")
				.get() as { value: string } | undefined;

			if (emergencyStop) {
				this.ctx.logger.info("[scheduler] Emergency stop active, skipping tick");
				return;
			}

			// Phase 0: Eviction
			this.phase0Eviction();

			// Phase 1: Schedule
			this.phase1Schedule();

			// Phase 2: Sync (deferred for Phase 5)
			// this.phase2Sync();

			// Phase 3: Run
			this.phase3Run();
		} catch (error) {
			const errorMsg = formatError(error);
			this.ctx.logger.error("Scheduler tick failed", { error: errorMsg });
		}
	}

	private phase0Eviction(): void {
		const now = new Date();
		const leaseExpiry = new Date(now.getTime() - LEASE_DURATION).toISOString();

		// (a) Expire stale claimed tasks
		this.ctx.db
			.query(
				`UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_id = NULL
			 WHERE status = 'claimed' AND claimed_at < ?`,
			)
			.run(leaseExpiry);

		// (b) Evict crashed running tasks
		const evictionTime = new Date(now.getTime() - EVICTION_TIMEOUT).toISOString();
		const tasksToEvict = this.ctx.db
			.query("SELECT * FROM tasks WHERE status = 'running' AND heartbeat_at < ?")
			.all(evictionTime) as Task[];

		if (tasksToEvict.length > 0) {
			this.ctx.logger.warn("[scheduler] Evicting crashed tasks", {
				count: tasksToEvict.length,
				tasks: tasksToEvict.map((t) => ({
					id: t.id,
					name: t.name,
					type: t.type,
					consecutiveFailures: (t.consecutive_failures ?? 0) + 1,
				})),
			});

			this.ctx.db
				.query(
					`UPDATE tasks SET status = 'failed', error = 'evicted due to heartbeat timeout',
				 consecutive_failures = consecutive_failures + 1
				 WHERE status = 'running' AND heartbeat_at < ?`,
				)
				.run(evictionTime);

			for (const task of tasksToEvict) {
				rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "heartbeat timeout eviction");
				rescheduleHeartbeat(
					this.ctx.db,
					task,
					this.ctx.logger,
					"heartbeat timeout eviction",
					this.lastUserInteractionAt,
				);

				const newConsecutiveFailures = (task.consecutive_failures ?? 0) + 1;
				if (newConsecutiveFailures === task.alert_threshold) {
					this.triggerFailureAdvisory(
						task,
						"evicted due to heartbeat timeout",
						newConsecutiveFailures,
					);
				}
			}
		}
	}

	private phase1Schedule(): void {
		const now = new Date().toISOString();

		const pendingTasks = this.ctx.db
			.query(
				`SELECT * FROM tasks WHERE status = 'pending' AND next_run_at IS NOT NULL AND next_run_at <= ?
			 ORDER BY next_run_at ASC LIMIT 100`,
			)
			.all(now) as Task[];

		for (const task of pendingTasks) {
			if (canRunHere(this.ctx.db, task, this.ctx.hostName, this.ctx.siteId)) {
				const claimedAt = new Date().toISOString();
				const result = this.ctx.db
					.query(
						"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'",
					)
					.run(this.ctx.hostName, claimedAt, task.id);
				if (result.changes === 0) {
					this.ctx.logger.info("[scheduler] Task already claimed by another host", {
						taskId: task.id,
					});
				}
			}
		}
	}

	private phase3Run(): void {
		const claimedTasks = this.ctx.db
			.query(
				`SELECT * FROM tasks WHERE status = 'claimed' AND claimed_by = ?
			 ORDER BY created_at ASC LIMIT 10`,
			)
			.all(this.ctx.hostName) as Task[];

		for (const task of claimedTasks) {
			// Check daily budget for autonomous tasks (R-U35)
			if (this.shouldSkipDueToBudget(task)) {
				this.ctx.logger.warn("[scheduler] Skipping autonomous task due to daily budget", {
					taskId: task.id,
				});
				// Release the claim so it can be re-evaluated later
				this.ctx.db
					.query(
						"UPDATE tasks SET status = 'pending', claimed_by = NULL, claimed_at = NULL WHERE id = ?",
					)
					.run(task.id);
				continue;
			}

			this.runTask(task);
		}
	}

	private shouldSkipDueToBudget(task: Task): boolean {
		// Only check budget for autonomous (non-interactive) tasks
		// Interactive tasks (created by a user) should always run even when over budget
		const isInteractive = task.created_by !== null && task.created_by !== "system";
		if (isInteractive) {
			return false;
		}

		const modelBackends = this.ctx.config.modelBackends;
		const dailyBudget = modelBackends.daily_budget_usd;

		// If no budget configured, allow all tasks
		if (dailyBudget === undefined || dailyBudget === null) {
			return false;
		}

		// Query today's spend from turns table
		const today = new Date().toISOString().split("T")[0];
		const result = this.ctx.db
			.query("SELECT SUM(cost_usd) as total FROM turns WHERE date(created_at) = ?")
			.get(today) as { total: number | null } | null;

		const todaySpend = result?.total ?? 0;

		// Skip task if over budget
		return todaySpend >= dailyBudget;
	}

	private runTask(task: Task): void {
		const leaseId = randomUUID();
		const now = new Date().toISOString();

		// Mark as running (CAS: only if still claimed by this host)
		this.ctx.db
			.query(
				"UPDATE tasks SET status = 'running', lease_id = ?, heartbeat_at = ? WHERE id = ? AND status = 'claimed' AND claimed_by = ?",
			)
			.run(leaseId, now, task.id, this.ctx.hostName);
		const runChanges = this.ctx.db.query("SELECT changes() as count").get() as {
			count: number;
		};
		if (runChanges.count === 0) {
			this.ctx.logger.warn("[scheduler] CAS failed: task was reclaimed before runTask", {
				taskId: task.id,
			});
			return;
		}

		this.runningTasks.set(task.id, {
			leaseId,
			startedAt: new Date(),
		});

		this.ctx.logger.info("[scheduler] Task starting", {
			taskId: task.id,
			name: task.name,
			type: task.type,
			modelHint: task.model_hint ?? "default",
			threadId: task.thread_id ?? null,
			runCount: task.run_count ?? 0,
		});

		// Check if this is a cron task with a template (R-U28)
		const template = this.getCronTemplate(task);
		if (template && template.length > 0) {
			this.runTemplateTask(task, leaseId, template);
			return;
		}

		// Create agent loop and run asynchronously
		setImmediate(async () => {
			try {
				let threadId = task.thread_id || randomUUID();
				const taskNow = new Date().toISOString();

				// Rotate cron task threads that have grown too large.
				// Large threads cause slow context assembly and long LLM calls,
				// making them vulnerable to heartbeat timeout eviction.
				if (task.type === "cron" && task.thread_id) {
					const countRow = this.ctx.db
						.query("SELECT COUNT(*) as count FROM messages WHERE thread_id = ?")
						.get(task.thread_id) as { count: number };

					if (countRow.count > CRON_THREAD_ROTATION_THRESHOLD) {
						const newThreadId = randomUUID();
						this.ctx.logger.info(
							`[scheduler] Rotating cron task thread: ${countRow.count} messages exceeds threshold of ${CRON_THREAD_ROTATION_THRESHOLD}`,
							{ taskId: task.id, oldThreadId: task.thread_id, newThreadId },
						);
						this.ctx.db
							.query("UPDATE tasks SET thread_id = ? WHERE id = ?")
							.run(newThreadId, task.id);
						threadId = newThreadId;
					}
				}

				// Persist thread_id back to the task row so the UI can find the
				// thread later. Without this, tasks created without a thread_id
				// would run fine but the detail view couldn't show their messages.
				if (!task.thread_id) {
					this.ctx.db.query("UPDATE tasks SET thread_id = ? WHERE id = ?").run(threadId, task.id);
				}

				// Bug #4: Ensure a thread row exists for the threadId.
				// The thread may not exist if this is a system task with no pre-created thread.
				const existingThread = this.ctx.db
					.query("SELECT id FROM threads WHERE id = ?")
					.get(threadId) as { id: string } | null;

				if (!existingThread) {
					insertRow(
						this.ctx.db,
						"threads",
						{
							id: threadId,
							user_id: this.operatorUserId,
							interface: "scheduler",
							host_origin: this.ctx.hostName,
							color: 0,
							title: null,
							summary: null,
							summary_through: null,
							summary_model_id: null,
							extracted_through: null,
							created_at: taskNow,
							last_message_at: taskNow,
							modified_at: taskNow,
							deleted: 0,
						},
						this.ctx.siteId,
					);
				}

				// Always inject a user message so the agent loop has something to work
				// from. Bedrock (and any model that enforces "conversation must start
				// with a user message") rejects requests where the first non-system
				// message is not from the user. Use system role for task payloads so
				// the model treats them as operating instructions (like persona and
				// orientation) rather than external user input. System messages don't
				// trigger conversation ordering validation.
				insertRow(
					this.ctx.db,
					"messages",
					{
						id: randomUUID(),
						thread_id: threadId,
						role: "system",
						content:
							task.type === "heartbeat"
								? buildHeartbeatContext(this.ctx.db, task.last_run_at)
								: (task.payload ?? "Execute scheduled task."),
						model_id: null,
						tool_name: null,
						created_at: taskNow,
						modified_at: taskNow,
						host_origin: this.ctx.hostName,
						deleted: 0,
					},
					this.ctx.siteId,
				);

				// Inject quiescence note for scheduled tasks when system is idle
				if (task.type === "heartbeat" || task.type === "cron") {
					const idleMs = Date.now() - this.lastUserInteractionAt.getTime();
					if (idleMs >= QUIESCENCE_NOTE_THRESHOLD) {
						const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);
						const idleDuration = formatIdleDuration(idleMs);

						let baseInterval: string;
						let effectiveInterval: string;
						if (task.type === "heartbeat") {
							try {
								const spec = JSON.parse(task.trigger_spec);
								const baseMs = spec.interval_ms ?? 1_800_000;
								baseInterval = `${Math.round(baseMs / 60_000)}min`;
								effectiveInterval = `${Math.round((baseMs * multiplier) / 60_000)}min`;
							} catch {
								baseInterval = "30min";
								effectiveInterval = `${30 * multiplier}min`;
							}
						} else {
							// Cron tasks don't have a simple interval, extract and use the schedule expression
							baseInterval = extractCronExpression(task.trigger_spec);
							effectiveInterval = `schedule stretched by ${multiplier}x`;
						}

						const quiescenceNote = `[System note: Quiescence is active (idle ${idleDuration}). Task intervals are stretched by ${multiplier}x. Normal interval: ${baseInterval}, effective: ${effectiveInterval}.]`;

						insertRow(
							this.ctx.db,
							"messages",
							{
								id: randomUUID(),
								thread_id: threadId,
								role: "system",
								content: quiescenceNote,
								model_id: null,
								tool_name: null,
								created_at: taskNow,
								modified_at: taskNow,
								host_origin: this.ctx.hostName,
								deleted: 0,
							},
							this.ctx.siteId,
						);
					}
				}

				// Validate model hint at run time before creating the agent loop.
				// This catches models that became unavailable after the task was scheduled.
				if (task.model_hint && this.config.modelValidator) {
					const validation = this.config.modelValidator(task.model_hint);
					if (!validation.ok) {
						this.ctx.logger.warn("[scheduler] Task model validation failed", {
							taskId: task.id,
							name: task.name,
							modelHint: task.model_hint,
							error: validation.error,
						});
						const errorMsg = validation.error;
						const currentTask = this.ctx.db
							.query("SELECT lease_id FROM tasks WHERE id = ?")
							.get(task.id) as { lease_id: string | null } | undefined;
						if (currentTask?.lease_id === leaseId) {
							const updated = this.ctx.db
								.query(
									"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures",
								)
								.get(errorMsg, task.id) as { consecutive_failures: number } | null;

							const newConsecutiveFailures =
								updated?.consecutive_failures ?? (task.consecutive_failures ?? 0) + 1;
							if (newConsecutiveFailures === task.alert_threshold) {
								this.triggerFailureAdvisory(task, errorMsg, newConsecutiveFailures);
							}
							// Cron tasks must still reschedule even when the model is temporarily unavailable
							rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "model validation failure");
							rescheduleHeartbeat(
								this.ctx.db,
								task,
								this.ctx.logger,
								"model validation failure",
								this.lastUserInteractionAt,
							);
							retryDeferredTask(this.ctx.db, task, newConsecutiveFailures, this.ctx.logger);
						}
						return; // exit runTask — agent loop is not created
					}
				}

				const agentLoop = this.agentLoopFactory({
					threadId,
					taskId: task.id,
					userId: "system",
					modelId: task.model_hint || undefined,
				});

				const result = await agentLoop.run();

				// Verify lease_id still matches
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					const resultStr = JSON.stringify(result);
					const completedAt = new Date().toISOString();

					if (result.error) {
						this.ctx.logger.warn("[scheduler] Task soft-failed", {
							taskId: task.id,
							name: task.name,
							type: task.type,
							error: result.error,
							messagesCreated: result.messagesCreated,
							toolCallsMade: result.toolCallsMade,
						});

						// Soft error: run() returned normally but with an error field
						const softUpdated = this.ctx.db
							.query(
								"UPDATE tasks SET status = 'failed', error = ?, result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures",
							)
							.get(result.error, resultStr, completedAt, task.id) as {
							consecutive_failures: number;
						} | null;

						// Alert if consecutive failures just reached the threshold.
						// Use the RETURNING value so concurrent modifications to
						// consecutive_failures (e.g. from another process) are reflected.
						const newConsecutiveFailures =
							softUpdated?.consecutive_failures ?? (task.consecutive_failures ?? 0) + 1;
						if (newConsecutiveFailures === task.alert_threshold) {
							this.triggerFailureAdvisory(task, result.error, newConsecutiveFailures);
						}

						// Cron tasks still reschedule even after soft errors so they keep retrying
						rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "soft error");
						rescheduleHeartbeat(
							this.ctx.db,
							task,
							this.ctx.logger,
							"soft error",
							this.lastUserInteractionAt,
						);
						retryDeferredTask(this.ctx.db, task, newConsecutiveFailures, this.ctx.logger);
					} else {
						this.ctx.logger.info("[scheduler] Task completed", {
							taskId: task.id,
							name: task.name,
							type: task.type,
							messagesCreated: result.messagesCreated,
							toolCallsMade: result.toolCallsMade,
							filesChanged: result.filesChanged,
						});

						// Mark as completed and reset consecutive failure counter
						this.ctx.db
							.query(
								"UPDATE tasks SET status = 'completed', result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = 0 WHERE id = ?",
							)
							.run(resultStr, completedAt, task.id);

						// If cron task, compute next run time
						rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "completion");
						rescheduleHeartbeat(
							this.ctx.db,
							task,
							this.ctx.logger,
							"completion",
							this.lastUserInteractionAt,
						);
					}
				}

				// Fire-and-forget: generate a proper thread title (replaces the
				// null placeholder set during thread creation).
				if (this.config.generateTitle) {
					this.config
						.generateTitle(threadId)
						.catch((err) =>
							this.ctx.logger.warn(`Title generation failed for thread ${threadId}: ${err}`),
						);
				}
			} catch (error) {
				const errorMsg = formatError(error);

				this.ctx.logger.error("[scheduler] Task hard-failed", {
					taskId: task.id,
					name: task.name,
					type: task.type,
					error: errorMsg,
				});

				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					const hardUpdated = this.ctx.db
						.query(
							"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures",
						)
						.get(errorMsg, task.id) as { consecutive_failures: number } | null;

					// Alert if consecutive failures just reached the threshold.
					// Use the RETURNING value so concurrent modifications are reflected.
					const newConsecutiveFailures =
						hardUpdated?.consecutive_failures ?? (task.consecutive_failures ?? 0) + 1;
					if (newConsecutiveFailures === task.alert_threshold) {
						this.triggerFailureAdvisory(task, errorMsg, newConsecutiveFailures);
					}

					// Persist alert message per R-E15
					if (task.thread_id) {
						try {
							const now = new Date().toISOString();
							insertRow(
								this.ctx.db,
								"messages",
								{
									id: randomUUID(),
									thread_id: task.thread_id,
									role: "alert",
									content: `Task ${task.id} failed: ${errorMsg}`,
									model_id: null,
									tool_name: null,
									created_at: now,
									modified_at: now,
									host_origin: this.ctx.hostName,
									deleted: 0,
								},
								this.ctx.siteId,
							);
						} catch (alertError) {
							this.ctx.logger.error("Failed to persist task failure alert", {
								error: alertError instanceof Error ? alertError.message : String(alertError),
							});
						}
					}

					// Cron tasks must reschedule even after hard errors so they keep running on schedule
					rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "hard error");
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"hard error",
						this.lastUserInteractionAt,
					);
					retryDeferredTask(this.ctx.db, task, newConsecutiveFailures, this.ctx.logger);
				}
			} finally {
				this.runningTasks.delete(task.id);
			}
		});
	}

	// Event handler to be called when an event is emitted
	onEvent(eventType: string, _payload: unknown): void {
		if (this.eventDepth >= MAX_EVENT_DEPTH) {
			this.ctx.logger.warn("Max event depth exceeded");
			return;
		}

		this.eventDepth++;

		try {
			const eventTasks = this.ctx.db
				.query(
					"SELECT * FROM tasks WHERE type = 'event' AND status = 'pending' AND trigger_spec = ?",
				)
				.all(eventType) as Task[];

			for (const task of eventTasks) {
				if (canRunHere(this.ctx.db, task, this.ctx.hostName, this.ctx.siteId)) {
					const claimedAt = new Date().toISOString();
					// CAS: only claim if still pending (prevents duplicate event execution)
					this.ctx.db
						.query(
							"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending'",
						)
						.run(this.ctx.hostName, claimedAt, task.id);
				}
			}
		} finally {
			this.eventDepth--;
		}
	}

	private triggerFailureAdvisory(task: Task, error: string, consecutiveFailures: number): void {
		try {
			createAdvisory(
				this.ctx.db,
				{
					type: "general",
					status: "proposed",
					title: `Task has failed ${consecutiveFailures} times consecutively`,
					detail: `Task ${task.id} has failed ${consecutiveFailures} consecutive times. Latest error: ${error.slice(0, 500)}`,
					action: "Review the task configuration, model availability, and error details.",
					impact:
						"Scheduled task is not completing. Cron tasks will continue retrying on schedule.",
					evidence: JSON.stringify({
						taskId: task.id,
						consecutiveFailures,
						error: error.slice(0, 500),
					}),
				},
				this.ctx.siteId,
			);
		} catch (advisoryError) {
			this.ctx.logger.error("[scheduler] Failed to create task failure advisory", {
				error: formatError(advisoryError),
				taskId: task.id,
			});
		}
	}

	private getCronTemplate(task: Task): string[] | null {
		// Only check cron tasks
		if (task.type !== "cron") {
			return null;
		}

		// Parse trigger_spec to get cron expression
		let cronSpec: { type: string; expression?: string; name?: string };
		try {
			cronSpec = JSON.parse(task.trigger_spec);
		} catch {
			return null;
		}

		// Look up in cron_schedules config if available
		const cronResult = this.ctx.optionalConfig.cronSchedules;
		if (!cronResult || !cronResult.ok) {
			return null;
		}

		// Find matching schedule by expression or name
		const schedules = cronResult.value as Record<string, { schedule: string; template?: string[] }>;
		for (const [name, schedule] of Object.entries(schedules)) {
			// Skip non-cron entries (e.g., heartbeat config)
			if (name === "heartbeat" || !schedule.schedule) continue;
			if (schedule.schedule === cronSpec.expression && schedule.template) {
				return schedule.template;
			}
		}

		return null;
	}

	private runTemplateTask(task: Task, leaseId: string, template: string[]): void {
		setImmediate(async () => {
			try {
				// Execute template commands directly (no LLM call)
				const outputs: string[] = [];

				if (this.sandbox?.exec) {
					for (const cmd of template) {
						const result = await this.sandbox.exec(cmd);
						outputs.push(result.stdout || result.stderr);
						if (result.exitCode !== 0) {
							this.ctx.logger.warn("[scheduler] Template command failed", {
								taskId: task.id,
								cmd,
								exitCode: result.exitCode,
								stderr: result.stderr,
							});
						}
					}
				} else {
					this.ctx.logger.warn("[scheduler] No sandbox available for template execution", {
						taskId: task.id,
					});
				}

				// Verify lease_id still matches
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					const result = JSON.stringify({
						template_executed: true,
						commands: template,
						outputs,
					});

					this.ctx.db
						.query(
							"UPDATE tasks SET status = 'completed', result = ?, run_count = run_count + 1, last_run_at = ? WHERE id = ?",
						)
						.run(result, new Date().toISOString(), task.id);

					// If cron task, compute next run time
					rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "completion");
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template completion",
						this.lastUserInteractionAt,
					);
				}
			} catch (error) {
				const errorMsg = formatError(error);
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					this.ctx.db
						.query("UPDATE tasks SET status = 'failed', error = ? WHERE id = ?")
						.run(errorMsg, task.id);

					// Cron template tasks must reschedule even after hard errors
					rescheduleCronTask(this.ctx.db, task, this.ctx.logger, "template hard error");
					rescheduleHeartbeat(
						this.ctx.db,
						task,
						this.ctx.logger,
						"template hard error",
						this.lastUserInteractionAt,
					);
				}
			} finally {
				this.runningTasks.delete(task.id);
			}
		});
	}

	// Get current quiescence-adjusted poll interval using 4-tier graduated table
	getEffectivePollInterval(): number {
		// Check if any pending tasks have no_quiescence set
		const noQuiescenceTasks = this.ctx.db
			.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND no_quiescence = 1")
			.get() as { count: number } | null;

		// If any task requires immediate attention, use base interval
		if (noQuiescenceTasks && noQuiescenceTasks.count > 0) {
			return POLL_INTERVAL;
		}

		// Compute quiescence multiplier using the shared helper
		const multiplier = computeQuiescenceMultiplier(this.lastUserInteractionAt);

		return POLL_INTERVAL * multiplier;
	}
}
