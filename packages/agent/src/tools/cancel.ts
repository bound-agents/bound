import { findTaskInfraBinding, updateRow } from "@bound/core";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const cancelSchema = z.object({
	task_id: z.string().optional().describe("Task ID to cancel"),
	payload_match: z.string().optional().describe("Cancel all tasks matching this payload substring"),
});

export function createCancelTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(cancelSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "cancel",
				description: "Cancel a scheduled task (supports task-id or payload-match)",
				parameters: jsonSchema,
			},
		},
		// Idempotent: cancelling an already-cancelled task is a no-op (terminal
		// state). payload_match resolves to a set; re-running matches the same
		// set or a subset.
		idempotent: true,
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(cancelSchema, raw, "cancel");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				const payloadMatch = input.payload_match;
				const taskId = input.task_id;

				if (payloadMatch) {
					// Find all pending/claimed tasks whose payload contains the match string.
					// Heartbeat tasks are excluded — they are uncancellable by design.
					const tasks = ctx.db
						.prepare(
							"SELECT id FROM tasks WHERE payload LIKE ? AND type != 'heartbeat' AND status IN ('pending', 'claimed') AND deleted = 0",
						)
						.all(`%${payloadMatch}%`) as Array<{ id: string }>;

					if (tasks.length === 0) {
						return `No tasks found matching payload: ${payloadMatch}`;
					}

					// Skip tasks a live webhook / connector binding still points at — same
					// foreign-key guard as the single-task path, applied silently here the
					// way heartbeats are excluded above.
					const cancellable = tasks.filter((t) => !findTaskInfraBinding(ctx.db, t.id));
					const skipped = tasks.length - cancellable.length;

					if (cancellable.length === 0) {
						return `No cancellable tasks matching payload: ${payloadMatch} (${skipped} skipped — bound to a live webhook or connector handle)`;
					}

					for (const task of cancellable) {
						updateRow(ctx.db, "tasks", task.id, { status: "cancelled" }, ctx.siteId);
					}

					const suffix =
						skipped > 0
							? ` (${skipped} skipped — bound to a live webhook or connector handle)`
							: "";
					return `Cancelled ${cancellable.length} tasks matching payload: ${payloadMatch}${suffix}`;
				}

				if (!taskId) {
					return "Error: must specify task_id or payload_match";
				}

				// Check if task exists and fetch type for the heartbeat guard below.
				const existing = ctx.db
					.prepare("SELECT id, type FROM tasks WHERE id = ? AND deleted = 0")
					.get(taskId) as { id: string; type: string } | null;

				if (!existing) {
					return `Error: Task not found: ${taskId}`;
				}

				// Heartbeat tasks are uncancellable by design — the scheduler healer
				// re-arms them on every tick regardless of status. Allowing a cancel
				// just leaves the task in a wedged state until the healer fires.
				if (existing.type === "heartbeat") {
					return "Error: Cannot cancel heartbeat tasks (uncancellable by design)";
				}

				// Webhook handlers and connector subscriptions own a backing event
				// task (webhooks.task_id / connector_handles.task_id). Those tasks
				// share type "event" with ordinary --on tasks, so the guard keys off
				// the live binding rather than the type — the application-level
				// equivalent of a foreign-key constraint (#20: synced tables carry no
				// FK clauses). Cancelling the task out from under a live binding
				// orphans it and silently darks the event stream; the sanctioned
				// teardown (webhook deregister / connector detach) soft-deletes the
				// binding first, which releases the task for normal cancellation.
				const binding = findTaskInfraBinding(ctx.db, taskId);
				if (binding) {
					const release =
						binding.kind === "webhook"
							? "delete the webhook to retire its task"
							: "detach the connector handle to retire its task";
					return `Error: Cannot cancel task ${taskId}: it backs ${binding.kind} '${binding.label}' (${release}; uncancellable while the binding is live)`;
				}

				// Update task status to cancelled
				updateRow(
					ctx.db,
					"tasks",
					taskId,
					{
						status: "cancelled",
					},
					ctx.siteId,
				);

				return `Task cancelled: ${taskId}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
