import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

const TERMINAL_STATES = ["completed", "failed", "cancelled"];

const awaitEventSchema = z.object({
	task_ids: z.string().describe("Comma-separated task IDs to wait for"),
	timeout: z.number().optional().describe("Timeout in milliseconds (default 300000)"),
});

export function createAwaitEventTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(awaitEventSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "await_event",
				description: "Poll until tasks reach a terminal state",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(awaitEventSchema, raw, "await_event");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				if (input.task_ids.trim() === "") {
					return "Error: task_ids cannot be empty";
				}

				const taskIds = input.task_ids.split(",").map((id) => id.trim());
				const timeout = input.timeout ?? 300000;

				const results: Record<string, Record<string, unknown>> = {};

				// Poll until all tasks reach terminal state
				const POLL_INTERVAL_MS = 2000;
				const startTime = Date.now();

				let allTerminal = false;

				while (!allTerminal) {
					allTerminal = true;

					for (const taskId of taskIds) {
						const task = ctx.db
							.prepare("SELECT id, status, result, error FROM tasks WHERE id = ? AND deleted = 0")
							.get(taskId) as Record<string, unknown> | null;

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
						if (Date.now() - startTime >= timeout) {
							break;
						}
						await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
					}
				}

				const output = JSON.stringify(results);
				const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB

				// Truncate if aggregate results exceed 50KB
				if (output.length > MAX_OUTPUT_SIZE) {
					const truncated = output.substring(0, MAX_OUTPUT_SIZE);
					return `${truncated}\n(output truncated, ${output.length} bytes total)`;
				}

				return output;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
