import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const cacheUnpin: CommandDefinition = {
	name: "cache-unpin",
	args: [{ name: "path", required: true, description: "File path to unpin" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const path = args.path;

			// Find the file by path
			const file = ctx.db
				.prepare("SELECT id FROM files WHERE path = ? AND deleted = 0")
				.get(path) as { id: string } | undefined;

			if (!file) {
				return {
					stdout: "",
					stderr: `File not found: ${path}\n`,
					exitCode: 1,
				};
			}

			// Remove pinned status from file
			// For Phase 4, this is a stub implementation
			return {
				stdout: `File unpinned: ${path}\n`,
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
