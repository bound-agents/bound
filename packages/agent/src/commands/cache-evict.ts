import { formatError } from "@bound/shared";

import { softDelete } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

export const cacheEvict: CommandDefinition = {
	name: "cache-evict",
	description: "Evict a specific cache entry",
	args: [{ name: "pattern", required: true, description: "Glob pattern of files to evict" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const pattern = args.pattern;

			// Simple pattern matching (% for SQL LIKE)
			const sqlPattern = pattern.replace(/\*/g, "%").replace(/\?/g, "_");

			// Find files matching the pattern
			const files = ctx.db
				.prepare("SELECT id FROM files WHERE path LIKE ? AND deleted = 0")
				.all(sqlPattern) as Array<{ id: string }>;

			if (files.length === 0) {
				return {
					stdout: "No files matched the pattern\n",
					stderr: "",
					exitCode: 0,
				};
			}

			// Soft-delete matching files
			for (const file of files) {
				softDelete(ctx.db, "files", file.id, ctx.siteId);
			}

			return {
				stdout: `Evicted ${files.length} cached file(s)\n`,
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
