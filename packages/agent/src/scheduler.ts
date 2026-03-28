import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { insertRow } from "@bound/core";
import { formatError } from "@bound/shared";
import type { Task } from "@bound/shared";
import { createAdvisory } from "./advisories";
import type { AgentLoop } from "./agent-loop";
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
const EVICTION_TIMEOUT = 120_000; // 2 minutes
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_EVENT_DEPTH = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Graduated quiescence tiers (idle duration in ms → multiplier)
// Thresholds are the lower bound of each idle band
const QUIESCENCE_TIERS: Array<{ threshold: number; multiplier: number }> = [
	{ threshold: 0, multiplier: 2 }, // 0-1h idle: ×2
	{ threshold: 3_600_000, multiplier: 3 }, // 1-4h idle: ×3
	{ threshold: 14_400_000, multiplier: 5 }, // 4-12h idle: ×5
	{ threshold: 43_200_000, multiplier: 10 }, // 12-24h idle: ×10
];

interface SchedulerConfig {
	pollInterval?: number;
	syncEnabled?: boolean;
}

export class Scheduler {
	private running = false;
	private intervalId: ReturnType<typeof setTimeout> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastUserInteractionAt = new Date();
	private eventDepth = 0;
	private runningTasks = new Map<string, { leaseId: string; startedAt: Date }>();

	constructor(
		private ctx: AppContext,
		private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
		private config: SchedulerConfig = {},
		private sandbox?: {
			exec?: (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
		},
	) {
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
			this.updateHeartbeats();
		}, HEARTBEAT_INTERVAL);

		// Start main scheduler loop with dynamic quiescence-based interval
		const scheduleTick = () => {
			if (!this.running) return;

			this.tick();

			// Recalculate interval based on quiescence and reset timer
			const effectiveInterval = this.getEffectivePollInterval();
			this.intervalId = setTimeout(scheduleTick, effectiveInterval);
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
		this.ctx.db
			.query(
				`UPDATE tasks SET status = 'failed', error = 'evicted due to heartbeat timeout'
			 WHERE status = 'running' AND heartbeat_at < ?`,
			)
			.run(evictionTime);
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
				this.ctx.db
					.query("UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?")
					.run(this.ctx.hostName, claimedAt, task.id);
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

		// Mark as running
		this.ctx.db
			.query("UPDATE tasks SET status = 'running', lease_id = ?, heartbeat_at = ? WHERE id = ?")
			.run(leaseId, now, task.id);

		this.runningTasks.set(task.id, {
			leaseId,
			startedAt: new Date(),
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
				const threadId = task.thread_id || randomUUID();
				const taskNow = new Date().toISOString();

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
							user_id: "system",
							interface: "scheduler",
							host_origin: this.ctx.hostName,
							color: 0,
							title: task.payload ? task.payload.slice(0, 80) : `Task ${task.id}`,
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

				// Bug #1: Inject task payload as the first user message so the agent
				// loop has something to work from (required for Bedrock and any model
				// that enforces "conversation must start with a user message").
				if (task.payload) {
					insertRow(
						this.ctx.db,
						"messages",
						{
							id: randomUUID(),
							thread_id: threadId,
							role: "user",
							content: task.payload,
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
						// Soft error: run() returned normally but with an error field
						this.ctx.db
							.query(
								"UPDATE tasks SET status = 'failed', error = ?, result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?",
							)
							.run(result.error, resultStr, completedAt, task.id);

						// Alert if consecutive failures just reached the threshold
						const newConsecutiveFailures = (task.consecutive_failures ?? 0) + 1;
						if (newConsecutiveFailures === task.alert_threshold) {
							this.triggerFailureAdvisory(task, result.error, newConsecutiveFailures);
						}

						// Cron tasks still reschedule even after soft errors so they keep retrying
						if (task.type === "cron" && task.trigger_spec) {
							try {
								const cronExpr = extractCronExpression(task.trigger_spec);
								const nextRunAt = computeNextRunAt(cronExpr, new Date());
								this.ctx.db
									.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?")
									.run(nextRunAt.toISOString(), task.id);
							} catch (cronError) {
								this.ctx.logger.error("Failed to compute next cron time after soft error", {
									error: formatError(cronError),
									taskId: task.id,
								});
							}
						}
					} else {
						// Mark as completed and reset consecutive failure counter
						this.ctx.db
							.query(
								"UPDATE tasks SET status = 'completed', result = ?, run_count = run_count + 1, last_run_at = ?, consecutive_failures = 0 WHERE id = ?",
							)
							.run(resultStr, completedAt, task.id);

						// If cron task, compute next run time
						if (task.type === "cron" && task.trigger_spec) {
							try {
								const cronExpr = extractCronExpression(task.trigger_spec);
								const nextRunAt = computeNextRunAt(cronExpr, new Date());
								this.ctx.db
									.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?")
									.run(nextRunAt.toISOString(), task.id);
							} catch (error) {
								const errorMsg = formatError(error);
								this.ctx.logger.error("Failed to compute next cron time", {
									error: errorMsg,
									taskId: task.id,
								});
							}
						}
					}
				}
			} catch (error) {
				const errorMsg = formatError(error);
				const currentTask = this.ctx.db
					.query("SELECT lease_id FROM tasks WHERE id = ?")
					.get(task.id) as { lease_id: string | null } | undefined;

				if (currentTask?.lease_id === leaseId) {
					this.ctx.db
						.query(
							"UPDATE tasks SET status = 'failed', error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?",
						)
						.run(errorMsg, task.id);

					// Alert if consecutive failures just reached the threshold
					const newConsecutiveFailures = (task.consecutive_failures ?? 0) + 1;
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
					this.ctx.db
						.query(
							"UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ?",
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
					impact: "Scheduled task is not completing. Cron tasks will continue retrying on schedule.",
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
		const cronResult = this.ctx.optionalConfig["cronSchedules"];
		if (!cronResult || !cronResult.ok) {
			return null;
		}

		// Find matching schedule by expression or name
		const schedules = cronResult.value as Record<string, { schedule: string; template?: string[] }>;
		for (const [_name, schedule] of Object.entries(schedules)) {
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
					if (task.type === "cron" && task.trigger_spec) {
						try {
							const cronExpr = extractCronExpression(task.trigger_spec);
							const nextRunAt = computeNextRunAt(cronExpr, new Date());
							this.ctx.db
								.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?")
								.run(nextRunAt.toISOString(), task.id);
						} catch (error) {
							const errorMsg = formatError(error);
							this.ctx.logger.error("Failed to compute next cron time", {
								error: errorMsg,
								taskId: task.id,
							});
						}
					}
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
				}
			} finally {
				this.runningTasks.delete(task.id);
			}
		});
	}

	// Get current quiescence-adjusted poll interval using 4-tier graduated table
	getEffectivePollInterval(): number {
		const now = new Date();
		const inactivityMs = now.getTime() - this.lastUserInteractionAt.getTime();

		// Check if any pending tasks have no_quiescence set
		const noQuiescenceTasks = this.ctx.db
			.query("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending' AND no_quiescence = 1")
			.get() as { count: number } | null;

		// If any task requires immediate attention, use base interval
		if (noQuiescenceTasks && noQuiescenceTasks.count > 0) {
			return POLL_INTERVAL;
		}

		// Walk tiers from highest threshold down, pick the first that applies
		let multiplier = 1;
		for (let i = QUIESCENCE_TIERS.length - 1; i >= 0; i--) {
			const tier = QUIESCENCE_TIERS[i];
			if (inactivityMs >= tier.threshold) {
				multiplier = tier.multiplier;
				break;
			}
		}

		return POLL_INTERVAL * multiplier;
	}
}
