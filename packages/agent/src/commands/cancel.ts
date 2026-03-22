import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const cancel: CommandDefinition = {
	name: "cancel",
	args: [{ name: "task-id", required: true, description: "Task ID to cancel" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const taskId = args["task-id"];

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
