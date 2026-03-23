import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export const memorize: CommandDefinition = {
	name: "memorize",
	args: [
		{ name: "key", required: true, description: "Memory key" },
		{ name: "value", required: true, description: "Memory value" },
		{ name: "source", required: false, description: "Source of the memory entry" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const key = args.key;
			const value = args.value;
			const source = args.source || "agent";
			const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
			const now = new Date().toISOString();

			// Check if entry exists
			const existing = ctx.db
				.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(key) as { id: string } | undefined;

			if (existing) {
				// Update existing entry
				updateRow(
					ctx.db,
					"semantic_memory",
					memoryId,
					{
						value,
						source,
						last_accessed_at: now,
					},
					ctx.siteId,
				);
			} else {
				// Create new entry
				insertRow(
					ctx.db,
					"semantic_memory",
					{
						id: memoryId,
						key,
						value,
						source,
						created_at: now,
						modified_at: now,
						last_accessed_at: now,
						deleted: 0,
					},
					ctx.siteId,
				);
			}

			return {
				stdout: `Memory saved: ${key}\n`,
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
