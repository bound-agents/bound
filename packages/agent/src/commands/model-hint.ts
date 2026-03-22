import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const modelHint: CommandDefinition = {
	name: "model-hint",
	args: [
		{ name: "model", required: false, description: "Model ID or tier to switch to" },
		{ name: "reset", required: false, description: "Clear the hint" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const now = new Date().toISOString();

			// Check if a hint already exists for this task
			const existing = ctx.db
				.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
				.get(ctx.taskId) as { id: string } | undefined;

			if (args.reset === "true") {
				// Clear the hint by setting model_hint to null
				if (existing && ctx.taskId) {
					updateRow(ctx.db, "tasks", ctx.taskId, { model_hint: null }, ctx.siteId);
				}

				return {
					stdout: "Model hint cleared\n",
					stderr: "",
					exitCode: 0,
				};
			}

			if (!args.model) {
				return {
					stdout: "",
					stderr: "Error: must specify --model or --reset\n",
					exitCode: 1,
				};
			}

			// Store the model hint for the agent loop to read
			// This is typically used during a task run to suggest model switching
			if (existing && ctx.taskId) {
				updateRow(ctx.db, "tasks", ctx.taskId, { model_hint: args.model }, ctx.siteId);
			} else if (ctx.taskId) {
				// Create a temporary task entry to store the hint
				insertRow(
					ctx.db,
					"tasks",
					{
						id: ctx.taskId,
						type: "hint",
						status: "pending",
						trigger_spec: JSON.stringify({ type: "hint" }),
						payload: null,
						created_at: now,
						created_by: ctx.siteId,
						thread_id: ctx.threadId || null,
						claimed_by: null,
						claimed_at: null,
						lease_id: null,
						next_run_at: null,
						last_run_at: null,
						run_count: 0,
						max_runs: null,
						requires: null,
						model_hint: args.model,
						no_history: 0,
						inject_mode: "results",
						depends_on: null,
						require_success: 0,
						alert_threshold: 1,
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
			}

			return {
				stdout: `Model hint set to: ${args.model}\n`,
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
