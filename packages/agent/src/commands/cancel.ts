import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const cancel: CommandDefinition = {
	name: "cancel",
	args: [
		{ name: "task-id", required: false, description: "Task ID to cancel" },
		{
			name: "payload-match",
			required: false,
			description: "Cancel tasks whose payload contains this string",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
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
					return {
						stdout: `No tasks found matching payload: ${match}\n`,
						stderr: "",
						exitCode: 0,
					};
				}

				for (const task of tasks) {
					updateRow(ctx.db, "tasks", task.id, { status: "cancelled" }, ctx.siteId);
				}

				return {
					stdout: `Cancelled ${tasks.length} tasks matching payload: ${match}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			const taskId = args["task-id"];
			if (!taskId) {
				return {
					stdout: "",
					stderr: "Error: must specify task-id or --payload-match\n",
					exitCode: 1,
				};
			}

			// Check if task exists
			const existing = ctx.db
				.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
				.get(taskId) as { id: string } | undefined;

			if (!existing) {
				return {
					stdout: "",
					stderr: `Task not found: ${taskId}\n`,
					exitCode: 1,
				};
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

			return {
				stdout: `Task cancelled: ${taskId}\n`,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
