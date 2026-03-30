import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const skillRead: CommandDefinition = {
	name: "skill-read",
	args: [
		{
			name: "name",
			required: true,
			description: "Name of the skill to read",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const name = args.name;
			const skillMdPath = `/home/user/skills/${name}/SKILL.md`;

			// Get skill metadata
			const skill = ctx.db
				.prepare(
					"SELECT id, name, status, activation_count, last_activated_at, description, content_hash FROM skills WHERE name = ? AND deleted = 0",
				)
				.get(name) as {
				id: string;
				name: string;
				status: string;
				activation_count: number;
				last_activated_at: string | null;
				description: string;
				content_hash: string | null;
			} | null;

			if (!skill) {
				return commandError(`Skill '${name}' not found.`);
			}

			// Read SKILL.md content from files table
			const fileRow = ctx.db
				.prepare("SELECT content FROM files WHERE path = ? AND deleted = 0")
				.get(skillMdPath) as { content: string } | null;

			const skillMdContent = fileRow?.content ?? "(SKILL.md content not found in files table)";

			const header = [
				`--- Skill: ${skill.name} ---`,
				`Status:      ${skill.status}`,
				`Activations: ${skill.activation_count ?? 0}`,
				`Last used:   ${skill.last_activated_at?.slice(0, 19) ?? "never"}`,
				`Hash:        ${skill.content_hash ?? "unknown"}`,
				"",
			].join("\n");

			return commandSuccess(`${header}${skillMdContent}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
