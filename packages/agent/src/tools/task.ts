import { insertRow, updateRow } from "@bound/core";
import type { ModelRouter } from "@bound/llm";
import { randomUUID } from "@bound/shared";
import { z } from "zod";
import { resolveModel } from "../model-resolution";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

function parseTimeOffset(offset: string): Date {
	const now = new Date();
	const match = offset.match(/^(\d+)([smhd])$/);

	if (!match) {
		throw new Error(
			`Invalid time offset format: ${offset}. Expected a positive integer followed by a unit — s, m, h, or d (e.g. '5s', '5m', '2h', '1d').`,
		);
	}

	const [, num, unit] = match;
	const n = Number.parseInt(num, 10);

	switch (unit) {
		case "s":
			now.setSeconds(now.getSeconds() + n);
			break;
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

const taskSchema = z.object({
	action: z
		.enum(["schedule", "update"])
		.describe("Task operation: 'schedule' a new task or 'update' an existing one"),
	// ── schedule fields ──
	task_description: z.string().optional().describe("What the task should do (for schedule)"),
	cron: z
		.string()
		.optional()
		.describe("Cron expression for recurring tasks (e.g., '0,30 * * * *') (for schedule)"),
	delay: z
		.string()
		.optional()
		.describe("Deferred time offset (e.g., '5m', '2h', '1d') (for schedule)"),
	on_event: z.string().optional().describe("Event name for event-driven tasks (for schedule)"),
	payload: z.string().optional().describe("Task payload as JSON string (for schedule)"),
	thread_id: z.string().optional().describe("Thread ID for task context (for schedule)"),
	after: z.string().optional().describe("Task ID this depends on (for schedule)"),
	require_success: z.boolean().optional().describe("Require dependency to succeed (for schedule)"),
	inject_mode: z
		.enum(["results", "status", "file"])
		.optional()
		.describe("How to inject dependency results (for schedule)"),
	// ── update fields ──
	task_id: z.string().optional().describe("ID of the task to update (for update)"),
	// ── mutable config fields (schedule + update) ──
	model_hint: z
		.string()
		.optional()
		.describe(
			"Model ID or tier to suggest to scheduler. On update, pass an empty string to clear back to the system default.",
		),
	no_history: z
		.boolean()
		.optional()
		.describe(
			"Skip loading conversation history. On update, false re-enables history; omit to leave unchanged.",
		),
	alert_threshold: z
		.number()
		.optional()
		.describe("Consecutive failures before advisory (default 3)"),
});

type TaskInput = z.infer<typeof taskSchema>;

/**
 * Validate a model hint against the cluster-wide pool when a router is
 * available. Returns an error string on failure, or null when the hint is
 * acceptable (or no router is wired). Shared by schedule + update.
 */
function validateModelHint(modelHint: string, ctx: ToolContext): string | null {
	if (!ctx.modelRouter) return null;
	const resolution = resolveModel(modelHint, ctx.modelRouter as ModelRouter, ctx.db, ctx.siteId);
	if (resolution.kind === "error") {
		return `Error: ${resolution.error}`;
	}
	return null;
}

function handleSchedule(input: TaskInput, ctx: ToolContext): string {
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
	let type: import("@bound/shared").TaskType;
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

	// #64: `task_description` is labeled "What the task should do", so LLMs
	// routinely populate it with full instructions and leave `payload` empty,
	// producing a task that wakes with a null payload and exits without doing
	// the work. Fold `task_description` into `payload` when `payload` is omitted
	// so the field does what its label promises. An explicit non-empty `payload`
	// still wins. Treat empty/whitespace-only strings as absent: models that hit
	// a null-rejecting optional param work around it by passing payload:"" (or
	// pass a blank string outright), and `??` alone would let that empty string
	// defeat the fold and reproduce the empty-payload wakeup.
	const nonBlank = (s: string | undefined): string | undefined =>
		s !== undefined && s.trim() !== "" ? s : undefined;
	const payload = nonBlank(input.payload) ?? nonBlank(input.task_description) ?? null;
	const modelHint = input.model_hint ?? null;

	// Validate model-hint against the cluster-wide pool when modelRouter is available
	if (modelHint) {
		const err = validateModelHint(modelHint, ctx);
		if (err) return err;
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
			system_prompt_addition: null,
			heartbeat_at: null,
			result: null,
			error: null,
			modified_at: now,
			deleted: 0,
		},
		ctx.siteId,
	);

	return taskId;
}

function handleUpdate(input: TaskInput, ctx: ToolContext): string {
	const taskId = input.task_id;
	if (!taskId) {
		return "Error: update requires 'task_id'";
	}

	// A task's own agent loop must not rewrite its own config. When the loop is
	// driven by the scheduler, `ctx.taskId` is the running task's id; if it
	// matches the update target, refuse. This closes the class of incident where
	// a webhook/event task cleared its own model_hint mid-run, silently
	// upgrading cost (see bound_issue:task-self-clears-own-model_hint-via-task-update-20260601).
	// To change the running task's model specifically, use the `model_hint` tool,
	// which is the deliberate, single-field path for that intent.
	if (ctx.taskId && ctx.taskId === taskId) {
		return "Error: a task cannot modify itself via the task tool";
	}

	// bun:sqlite .get() returns null (not undefined) when no row found
	const existing = ctx.db.prepare("SELECT id, deleted FROM tasks WHERE id = ?").get(taskId) as {
		id: string;
		deleted: number;
	} | null;
	if (!existing || existing.deleted === 1) {
		return `Error: task '${taskId}' not found`;
	}

	// Build the partial update from the mutable config fields that were
	// provided. Each field is three-state: omitted → leave alone; present →
	// apply. Lifecycle/scheduling fields (status, trigger, payload) are NOT
	// mutable here by design — cancel is its own tool, and rescheduling has
	// distinct semantics.
	const updates: Record<string, unknown> = {};

	if (input.no_history !== undefined) {
		updates.no_history = input.no_history ? 1 : 0;
	}

	if (input.model_hint !== undefined) {
		// Empty string clears back to the system default (null).
		if (input.model_hint === "") {
			updates.model_hint = null;
		} else {
			const err = validateModelHint(input.model_hint, ctx);
			if (err) return err;
			updates.model_hint = input.model_hint;
		}
	}

	if (input.alert_threshold !== undefined) {
		if (input.alert_threshold <= 0) {
			return "Error: alert_threshold must be greater than 0";
		}
		updates.alert_threshold = input.alert_threshold;
	}

	if (Object.keys(updates).length === 0) {
		return "Error: update requires at least one of: no_history, model_hint, alert_threshold";
	}

	updateRow(ctx.db, "tasks", taskId, updates, ctx.siteId);

	const changed = Object.keys(updates).join(", ");
	return `Updated task ${taskId} (${changed})`;
}

export function createTaskTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(taskSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "task",
				description:
					"Manage scheduled tasks. action=schedule creates a deferred, cron, or event-driven task; action=update toggles no_history / model_hint / alert_threshold on an existing task by id. A task cannot update itself (use the model_hint tool to change the running task's model).",
				parameters: jsonSchema,
			},
		},
		// Non-idempotent: action=schedule creates a new task with a fresh id on
		// every call. action=update is idempotent for a given input, but the tool
		// as a whole is declared non-idempotent to preserve schedule semantics.
		idempotent: false,
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(taskSchema, raw, "task");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				if (input.action === "update") {
					return handleUpdate(input, ctx);
				}
				return handleSchedule(input, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
