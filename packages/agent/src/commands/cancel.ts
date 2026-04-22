import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const cancel: CommandDefinition = {
	name: "cancel",
	description: "Cancel a scheduled task (supports --payload-match)",
	args: [
		{ name: "task-id", required: false, description: "Task ID to cancel" },
		{
			name: "payload-match",
			required: false,
			description: "Cancel tasks whose payload contains this string",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			if (args["payload-match"]) {
				const match = args["payload-match"];

				// Find all pending/claimed tasks whose payload contains the match string
				const tasks = ctx.db
					.prepare(
						"SELECT id FROM tasks WHERE payload LIKE ? AND status IN ('pending', 'claimed') AND deleted = 0",
					)
					.all(`%${match}%`) as Array<{ id: string }>;

				if (tasks.length === 0) {
					return commandSuccess(`No tasks found matching payload: ${match}\n`);
				}

				for (const task of tasks) {
					updateRow(ctx.db, "tasks", task.id, { status: "cancelled" }, ctx.siteId);
				}

				return commandSuccess(`Cancelled ${tasks.length} tasks matching payload: ${match}\n`);
			}

			const taskId = args["task-id"];
			if (!taskId) {
				return commandError("must specify task-id or --payload-match");
			}

			// Check if task exists
			const existing = ctx.db
				.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
				.get(taskId) as { id: string } | undefined;

			if (!existing) {
				return commandError(`Task not found: ${taskId}`);
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

			return commandSuccess(`Task cancelled: ${taskId}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
