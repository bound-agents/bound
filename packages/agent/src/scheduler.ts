import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import type { Task } from "@bound/shared";
import type { AgentLoop } from "./agent-loop";
import { canRunHere, computeNextRunAt } from "./task-resolution";
import type { AgentLoopConfig } from "./types";

const LEASE_DURATION = 300000; // 5 minutes
const EVICTION_TIMEOUT = 600000; // 10 minutes
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_INACTIVITY_SCALE = 5; // 5x poll interval when quiet
const INACTIVITY_THRESHOLD = 3600000; // 1 hour
const MAX_EVENT_DEPTH = 5;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds

interface SchedulerConfig {
	pollInterval?: number;
	syncEnabled?: boolean;
}

export class Scheduler {
	private running = false;
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private lastUserInteractionAt = new Date();
	private eventDepth = 0;
	private runningTasks = new Map<string, { leaseId: string; startedAt: Date }>();

	constructor(
		private ctx: AppContext,
		private agentLoopFactory: (config: AgentLoopConfig) => AgentLoop,
		private config: SchedulerConfig = {},
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

		// Start main scheduler loop
		this.intervalId = setInterval(() => {
			this.tick();
		}, pollInterval);

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
			clearInterval(this.intervalId);
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
			// Phase 0: Eviction
			this.phase0Eviction();

			// Phase 1: Schedule
			this.phase1Schedule();

			// Phase 2: Sync (deferred for Phase 5)
			// this.phase2Sync();

			// Phase 3: Run
			this.phase3Run();
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
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
			this.runTask(task);
		}
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

		// Create agent loop and run asynchronously
		setImmediate(async () => {
			try {
				const agentLoop = this.agentLoopFactory({
					threadId: task.thread_id || randomUUID(),
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
					// Mark as completed
					const resultStr = JSON.stringify(result);
					this.ctx.db
						.query(
							"UPDATE tasks SET status = 'completed', result = ?, run_count = run_count + 1, last_run_at = ? WHERE id = ?",
						)
						.run(resultStr, new Date().toISOString(), task.id);

					// If cron task, compute next run time
					if (task.type === "cron" && task.trigger_spec) {
						try {
							const nextRunAt = computeNextRunAt(task.trigger_spec, new Date());
							this.ctx.db
								.query("UPDATE tasks SET next_run_at = ?, status = 'pending' WHERE id = ?")
								.run(nextRunAt.toISOString(), task.id);
						} catch (error) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							this.ctx.logger.error("Failed to compute next cron time", {
								error: errorMsg,
								taskId: task.id,
							});
						}
					}
				}
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
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

	// Get current quiescence-adjusted poll interval
	getEffectivePollInterval(): number {
		const now = new Date();
		const inactivityMs = now.getTime() - this.lastUserInteractionAt.getTime();

		if (inactivityMs > INACTIVITY_THRESHOLD) {
			// Scale from normal to 5x over 1 hour period
			const scale =
				1 +
				((inactivityMs - INACTIVITY_THRESHOLD) / INACTIVITY_THRESHOLD) * (MAX_INACTIVITY_SCALE - 1);
			return Math.min(
				POLL_INTERVAL * Math.min(scale, MAX_INACTIVITY_SCALE),
				POLL_INTERVAL * MAX_INACTIVITY_SCALE,
			);
		}

		return POLL_INTERVAL;
	}
}
