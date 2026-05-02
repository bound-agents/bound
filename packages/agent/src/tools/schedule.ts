import { insertRow } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import { randomUUID } from "@bound/shared";
import { z } from "zod";
import { resolveModel } from "../model-resolution";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

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

const scheduleSchema = z.object({
	task_description: z.string().describe("What the task should do"),
	cron: z
		.string()
		.optional()
		.describe("Cron expression for recurring tasks (e.g., '0,30 * * * *')"),
	delay: z.string().optional().describe("Deferred time offset (e.g., '5m', '2h', '1d')"),
	on_event: z.string().optional().describe("Event name for event-driven tasks"),
	payload: z.string().optional().describe("Task payload as JSON string"),
	model_hint: z.string().optional().describe("Model ID or tier to suggest to scheduler"),
	thread_id: z.string().optional().describe("Thread ID for task context"),
	no_history: z.boolean().optional().describe("Skip loading conversation history"),
	after: z.string().optional().describe("Task ID this depends on"),
	require_success: z.boolean().optional().describe("Require dependency to succeed"),
	inject_mode: z
		.enum(["results", "status", "file"])
		.optional()
		.describe("How to inject dependency results"),
	alert_threshold: z
		.number()
		.optional()
		.describe("Consecutive failures before advisory (default 3)"),
});

export function createScheduleTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(scheduleSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "schedule",
				description: "Schedule a deferred, cron, or event-driven task",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(scheduleSchema, raw, "schedule");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				// Validate exactly one trigger type is provided
				const triggerCount = [input.cron, input.delay, input.on_event].filter(Boolean).length;
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

				if (input.delay) {
					type = "deferred";
					const runAt = parseTimeOffset(input.delay);
					nextRunAt = runAt.toISOString();
					triggerSpec = JSON.stringify({ type: "deferred", at: nextRunAt });
				} else if (input.cron) {
					// Validate cron expression has 5 fields
					const cronFields = input.cron.trim().split(/\s+/);
					if (cronFields.length !== 5) {
						return `Error: cron expression must have 5 fields (minute hour day month weekday), got ${cronFields.length}`;
					}
					type = "cron";
					triggerSpec = JSON.stringify({ type: "cron", expression: input.cron });
					// Set next_run_at to now (scheduler will compute actual next)
					nextRunAt = now;
				} else if (input.on_event) {
					type = "event";
					triggerSpec = JSON.stringify({ type: "event", event: input.on_event });
				} else {
					return "Error: must specify one of cron, delay, or on_event";
				}

				const payload = input.payload ?? null;
				const modelHint = input.model_hint ?? null;

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
				const dependsOn = input.after ? JSON.stringify([input.after]) : null;
				const requireSuccess = input.require_success ? 1 : 0;
				const injectMode = input.inject_mode ?? "results";

				// Parse alert_threshold
				let alertThreshold = 3;
				if (input.alert_threshold) {
					if (input.alert_threshold > 0) {
						alertThreshold = input.alert_threshold;
					}
				}

				const threadId = input.thread_id ?? ctx.threadId ?? null;

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
