import { randomUUID } from "node:crypto";
import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const skillRetire: CommandDefinition = {
	name: "skill-retire",
	args: [
		{
			name: "name",
			required: true,
			description: "Name of the skill to retire",
		},
		{
			name: "reason",
			required: false,
			description: "Reason for retiring the skill",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const name = args.name;
			const reason = args.reason ?? null;

			// Find the skill
			const skill = ctx.db
				.prepare(
					"SELECT id, status FROM skills WHERE name = ? AND deleted = 0",
				)
				.get(name) as { id: string; status: string } | null;

			if (!skill) {
				return commandError(`Skill '${name}' not found.`);
			}

			const now = new Date().toISOString();

			// Retire the skill
			updateRow(
				ctx.db,
				"skills",
				skill.id,
				{
					status: "retired",
					retired_by: "agent",
					retired_reason: reason,
					modified_at: now,
				},
				ctx.siteId,
			);

			// Scan tasks for payloads referencing this skill and create advisories
			const tasks = ctx.db
				.prepare(
					"SELECT id, payload, thread_id FROM tasks WHERE deleted = 0 AND payload IS NOT NULL",
				)
				.all() as Array<{ id: string; payload: string; thread_id: string | null }>;

			let advisoryCount = 0;
			for (const task of tasks) {
				let payload: unknown;
				try {
					payload = JSON.parse(task.payload);
				} catch {
					continue;
				}
				if (
					typeof payload === "object" &&
					payload !== null &&
					"skill" in payload &&
					(payload as Record<string, unknown>).skill === name
				) {
					const advisoryId = randomUUID();
					insertRow(
						ctx.db,
						"advisories",
						{
							id: advisoryId,
							type: "general",
							status: "proposed",
							title: `Skill '${name}' was retired`,
							detail: `Task ${task.id} references skill '${name}' which was retired by agent${reason ? `: ${reason}` : ""}.`,
							action: `Update task ${task.id} to use a different skill or remove the skill reference.`,
							impact: null,
							evidence: JSON.stringify({ task_id: task.id, skill: name }),
							proposed_at: now,
							defer_until: null,
							resolved_at: null,
							created_by: ctx.siteId,
							modified_at: now,
							deleted: 0,
						},
						ctx.siteId,
					);
					advisoryCount++;
				}
			}

			const msg = reason
				? `Skill '${name}' retired. Reason: ${reason}.\n`
				: `Skill '${name}' retired.\n`;
			const advisoryMsg =
				advisoryCount > 0
					? `${advisoryCount} advisory${advisoryCount === 1 ? "" : "s"} created for referencing tasks.\n`
					: "";
			return commandSuccess(msg + advisoryMsg);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
