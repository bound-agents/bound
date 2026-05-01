import { insertRow } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import { randomUUID } from "@bound/shared";
import { resolveModel } from "../model-resolution";
import type { RegisteredTool, ToolContext } from "../types";

function parseTimeOffset(offset: string): Date {
	const now = new Date();
	const match = offset.match(/^(\d+)([mhd])$/);

	if (!match) {
		throw new Error(`Invalid time offset format: ${offset}`);
	}

	const [, num, unit] = match;
	const n = Number.parseInt(num, 10);

	switch (unit) {
		case "m":
			now.setMinutes(now.getMinutes() + n);
			break;
		case "h":
			now.setHours(now.getHours() + n);
			break;
		case "d":
			now.setDate(now.getDate() + n);
			break;
		default:
			throw new Error(`Unknown time unit: ${unit}`);
	}

	return now;
}

export function createScheduleTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "schedule",
				description: "Schedule a deferred, cron, or event-driven task",
				parameters: {
					type: "object",
					properties: {
						task_description: {
							type: "string",
							description: "What the task should do",
						},
						cron: {
							type: "string",
							description: "Cron expression for recurring tasks (e.g., '0,30 * * * *')",
						},
						delay: {
							type: "string",
							description: "Deferred time offset (e.g., '5m', '2h', '1d')",
						},
						on_event: {
							type: "string",
							description: "Event name for event-driven tasks",
						},
						payload: {
							type: "string",
							description: "Task payload as JSON string",
						},
						model_hint: {
							type: "string",
							description: "Model ID or tier to suggest to scheduler",
						},
						thread_id: {
							type: "string",
							description: "Thread ID for task context",
						},
						no_history: {
							type: "boolean",
							description: "Skip loading conversation history",
						},
						after: {
							type: "string",
							description: "Task ID this depends on",
						},
						require_success: {
							type: "boolean",
							description: "Require dependency to succeed",
						},
						inject_mode: {
							type: "string",
							enum: ["results", "all", "file"],
							description: "How to inject dependency results",
						},
						alert_threshold: {
							type: "integer",
							description: "Consecutive failures before advisory (default 3)",
						},
					},
					required: ["task_description"],
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			try {
				const taskDescription = input.task_description as string;
				if (!taskDescription) {
					return "Error: task_description is required";
				}

				const cron = input.cron as string | undefined;
				const delay = input.delay as string | undefined;
				const onEvent = input.on_event as string | undefined;

				// Validate exactly one trigger type is provided
				const triggerCount = [cron, delay, onEvent].filter(Boolean).length;
				if (triggerCount === 0) {
					return "Error: must specify one of cron, delay, or on_event";
				}
				if (triggerCount > 1) {
					return "Error: specify only one of cron, delay, or on_event";
				}

				const taskId = randomUUID();
				const now = new Date().toISOString();
				let type: string;
				let triggerSpec: string;
				let nextRunAt: string | null = null;

				if (delay) {
					type = "deferred";
					const runAt = parseTimeOffset(delay);
					nextRunAt = runAt.toISOString();
					triggerSpec = JSON.stringify({ type: "deferred", at: nextRunAt });
				} else if (cron) {
					// Validate cron expression has 5 fields
					const cronFields = cron.trim().split(/\s+/);
					if (cronFields.length !== 5) {
						return `Error: cron expression must have 5 fields (minute hour day month weekday), got ${cronFields.length}`;
					}
					type = "cron";
					triggerSpec = JSON.stringify({ type: "cron", expression: cron });
					// Set next_run_at to now (scheduler will compute actual next)
					nextRunAt = now;
				} else if (onEvent) {
					type = "event";
					triggerSpec = JSON.stringify({ type: "event", event: onEvent });
				} else {
					return "Error: must specify one of cron, delay, or on_event";
				}

				const payload = input.payload ? (input.payload as string) : null;
				const modelHint = input.model_hint ? (input.model_hint as string) : null;

				// Validate model-hint against the cluster-wide pool when modelRouter is available
				if (modelHint && ctx.modelRouter) {
					const resolution = resolveModel(
						modelHint,
						ctx.modelRouter as ModelRouter,
						ctx.db,
						ctx.siteId,
					);
					if (resolution.kind === "error") {
						return `Error: ${resolution.error}`;
					}
				}

				const noHistory = input.no_history ? 1 : 0;
				const dependsOn = input.after ? JSON.stringify([input.after as string]) : null;
				const requireSuccess = input.require_success ? 1 : 0;
				const injectMode = (input.inject_mode as string) || "results";

				// Parse alert_threshold
				let alertThreshold = 3;
				if (input.alert_threshold) {
					const parsed = Number.parseInt(input.alert_threshold as string, 10);
					if (!Number.isNaN(parsed) && parsed > 0) {
						alertThreshold = parsed;
					}
				}

				const threadId = input.thread_id ? (input.thread_id as string) : ctx.threadId || null;

				insertRow(
					ctx.db,
					"tasks",
					{
						id: taskId,
						type,
						status: "pending",
						trigger_spec: triggerSpec,
						payload,
						created_at: now,
						created_by: ctx.siteId,
						thread_id: null,
						origin_thread_id: threadId,
						claimed_by: null,
						claimed_at: null,
						lease_id: null,
						next_run_at: nextRunAt,
						last_run_at: null,
						run_count: 0,
						max_runs: null,
						requires: null,
						model_hint: modelHint,
						no_history: noHistory,
						inject_mode: injectMode,
						depends_on: dependsOn,
						require_success: requireSuccess,
						alert_threshold: alertThreshold,
						consecutive_failures: 0,
						event_depth: 0,
						no_quiescence: 0,
						heartbeat_at: null,
						result: null,
						error: null,
						modified_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);

				return taskId;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
