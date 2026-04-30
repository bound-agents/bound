import { updateRow } from "@bound/core";
import type { RegisteredTool, ToolContext } from "../types";

export function createCancelTool(ctx: ToolContext): RegisteredTool {
	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "cancel",
				description: "Cancel a scheduled task (supports task-id or payload-match)",
				parameters: {
					type: "object",
					properties: {
						task_id: {
							type: "string",
							description: "Task ID to cancel",
						},
						payload_match: {
							type: "string",
							description: "Cancel all tasks matching this payload substring",
						},
					},
				},
			},
		},
		execute: async (input: Record<string, unknown>) => {
			try {
				const payloadMatch = input.payload_match as string | undefined;
				const taskId = input.task_id as string | undefined;

				if (payloadMatch) {
					// Find all pending/claimed tasks whose payload contains the match string
					const tasks = ctx.db
						.prepare(
							"SELECT id FROM tasks WHERE payload LIKE ? AND status IN ('pending', 'claimed') AND deleted = 0",
						)
						.all(`%${payloadMatch}%`) as Array<{ id: string }>;

					if (tasks.length === 0) {
						return `No tasks found matching payload: ${payloadMatch}`;
					}

					for (const task of tasks) {
						updateRow(ctx.db, "tasks", task.id, { status: "cancelled" }, ctx.siteId);
					}

					return `Cancelled ${tasks.length} tasks matching payload: ${payloadMatch}`;
				}

				if (!taskId) {
					return "Error: must specify task_id or payload_match";
				}

				// Check if task exists
				const existing = ctx.db
					.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
					.get(taskId) as { id: string } | null;

				if (!existing) {
					return `Error: Task not found: ${taskId}`;
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
