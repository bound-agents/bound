import { insertRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { randomUUID } from "@bound/shared";

function parseTimeOffset(offset: string): Date {
	const now = new Date();
	const match = offset.match(/^(\d+)([mhd])$/);

	if (!match) {
		throw new Error(`Invalid time offset format: ${offset}`);
	}

	const [, num, unit] = match;
	const n = Number.parseInt(num, 10);

	switch (unit) {
		case "m":
			now.setMinutes(now.getMinutes() + n);
			break;
		case "h":
			now.setHours(now.getHours() + n);
			break;
		case "d":
			now.setDate(now.getDate() + n);
			break;
		default:
			throw new Error(`Unknown time unit: ${unit}`);
	}

	return now;
}

export const schedule: CommandDefinition = {
	name: "schedule",
	args: [
		{ name: "in", required: false, description: "Deferred time (e.g., 5m, 2h, 1d)" },
		{ name: "every", required: false, description: "Cron expression" },
		{ name: "on", required: false, description: "Event name for event-driven tasks" },
		{ name: "payload", required: false, description: "Task payload as JSON" },
		{ name: "requires", required: false, description: "Host requirements" },
		{ name: "model-hint", required: false, description: "Model hint for the task" },
		{ name: "no-history", required: false, description: "Set no_history flag" },
		{ name: "after", required: false, description: "Task ID to depend on" },
		{ name: "require-success", required: false, description: "Require dependency success" },
		{ name: "quiet", required: false, description: "Quiet mode" },
		{ name: "inject", required: false, description: "Inject mode (results or all)" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const taskId = randomUUID();
			const now = new Date().toISOString();
			let type: string;
			let triggerSpec: string;
			let nextRunAt: string | null = null;

			if (args.in) {
				type = "deferred";
				const runAt = parseTimeOffset(args.in);
				nextRunAt = runAt.toISOString();
				triggerSpec = JSON.stringify({ type: "deferred", at: nextRunAt });
			} else if (args.every) {
				type = "cron";
				triggerSpec = JSON.stringify({ type: "cron", expression: args.every });
				// Set next_run_at to now (scheduler will compute actual next)
				nextRunAt = now;
			} else if (args.on) {
				type = "event";
				triggerSpec = JSON.stringify({ type: "event", event: args.on });
			} else {
				return {
					stdout: "",
					stderr: "Error: must specify --in, --every, or --on\n",
					exitCode: 1,
				};
			}

			const payload = args.payload ? args.payload : null;
			const requiresField = args.requires ? args.requires : null;
			const modelHint = args["model-hint"] ? args["model-hint"] : null;
			const noHistory = args["no-history"] ? 1 : 0;
			const dependsOn = args.after ? JSON.stringify([args.after]) : null;
			const requireSuccess = args["require-success"] ? 1 : 0;
			const injectMode = args.inject ? args.inject : "results";

			insertRow(
				ctx.db,
				"tasks",
				{
					id: taskId,
					type,
					status: "pending",
					trigger_spec: triggerSpec,
					payload,
					created_at: now,
					created_by: ctx.siteId,
					thread_id: ctx.threadId ? ctx.threadId : null,
					claimed_by: null,
					claimed_at: null,
					lease_id: null,
					next_run_at: nextRunAt,
					last_run_at: null,
					run_count: 0,
					max_runs: null,
					requires: requiresField,
					model_hint: modelHint,
					no_history: noHistory,
					inject_mode: injectMode,
					depends_on: dependsOn,
					require_success: requireSuccess,
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

			return {
				stdout: `${taskId}\n`,
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
