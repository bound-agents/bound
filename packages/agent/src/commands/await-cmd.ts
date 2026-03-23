import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

const TERMINAL_STATES = ["completed", "failed", "cancelled"];

export const awaitCmd: CommandDefinition = {
	name: "await",
	args: [
		{
			name: "task-ids",
			required: true,
			description: "Comma-separated task IDs or space-separated positional args",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const taskIdsStr = args["task-ids"];
			const taskIds = taskIdsStr.split(",").map((id) => id.trim());

			const results: Record<string, Record<string, unknown>> = {};

			// Poll until all tasks reach terminal state
			const POLL_INTERVAL_MS = 2000;
			const MAX_TIMEOUT_MS = 300000; // 300 seconds
			const startTime = Date.now();

			let allTerminal = false;

			while (!allTerminal) {
				allTerminal = true;

				for (const taskId of taskIds) {
					const task = ctx.db
						.prepare("SELECT id, status, result, error FROM tasks WHERE id = ? AND deleted = 0")
						.get(taskId) as Record<string, unknown> | undefined;

					if (!task) {
						results[taskId] = { status: "not_found", result: null, error: "Task not found" };
					} else {
						results[taskId] = {
							status: task.status,
							result: task.result,
							error: task.error,
						};

						if (!TERMINAL_STATES.includes(task.status as string)) {
							allTerminal = false;
						}
					}
				}

				if (!allTerminal) {
					if (Date.now() - startTime >= MAX_TIMEOUT_MS) {
						break;
					}
					await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				}
			}

			const output = JSON.stringify(results);
			const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

			// Spec 6.2: Truncate if aggregate results exceed 50KB
			if (output.length > MAX_OUTPUT_SIZE) {
				const truncated = output.substring(0, MAX_OUTPUT_SIZE);
				return {
					stdout: `${truncated}\n(output truncated, ${output.length} bytes total)\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			return {
				stdout: `${output}\n`,
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
