import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { createAdvisory } from "../advisories";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const advisory: CommandDefinition = {
	name: "advisory",
	args: [
		{ name: "title", required: true, description: "Short advisory title" },
		{ name: "detail", required: true, description: "Full description of the issue" },
		{ name: "action", required: false, description: "Recommended corrective action" },
		{ name: "impact", required: false, description: "Impact description" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const { title, detail, action, impact } = args;

			if (!title?.trim()) {
				return commandError("Missing required argument: title");
			}
			if (!detail?.trim()) {
				return commandError("Missing required argument: detail");
			}

			const id = createAdvisory(
				ctx.db,
				{
					type: "general",
					status: "proposed",
					title: title.trim(),
					detail: detail.trim(),
					action: action?.trim() ?? null,
					impact: impact?.trim() ?? null,
					evidence: null,
				},
				ctx.siteId,
			);

			return commandSuccess(`Advisory created: ${id}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
