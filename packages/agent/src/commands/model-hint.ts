import { formatError } from "@bound/shared";

import { updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const modelHint: CommandDefinition = {
	name: "model-hint",
	args: [
		{ name: "model", required: false, description: "Model ID or tier to switch to" },
		{ name: "reset", required: false, description: "Clear the hint" },
		{ name: "for-turns", required: false, description: "Turn count limit for the hint" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			if (!ctx.taskId) {
				return {
					stdout: "",
					stderr: "Error: taskId not available in context\n",
					exitCode: 1,
				};
			}

			// Check if a hint already exists for this task
			const existing = ctx.db
				.prepare("SELECT id FROM tasks WHERE id = ? AND deleted = 0")
				.get(ctx.taskId) as { id: string } | undefined;

			if (args.reset === "true") {
				// Clear the hint by setting model_hint to null
				if (existing) {
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

			if (!existing) {
				return {
					stdout: "",
					stderr: `Error: task not found: ${ctx.taskId}\n`,
					exitCode: 1,
				};
			}

			// Build the update payload
			const updates: Record<string, unknown> = { model_hint: args.model };

			if (args["for-turns"]) {
				const turns = Number.parseInt(args["for-turns"], 10);
				if (!Number.isNaN(turns) && turns > 0) {
					updates.model_hint_turns = turns;
				}
			}

			// Store the model hint for the agent loop to read
			updateRow(ctx.db, "tasks", ctx.taskId, updates, ctx.siteId);

			return {
				stdout: `Model hint set to: ${args.model}\n`,
				stderr: "",
				exitCode: 0,
			};
		} catch (error) {
			const message = formatError(error);
			return {
				stdout: "",
				stderr: `Error: ${message}\n`,
				exitCode: 1,
			};
		}
	},
};
