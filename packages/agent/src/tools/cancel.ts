import { updateRow } from "@bound/core";
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
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(cancelSchema, raw, "cancel");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				const payloadMatch = input.payload_match;
				const taskId = input.task_id;

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
