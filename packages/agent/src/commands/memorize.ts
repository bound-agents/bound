import { insertRow, updateRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { commandSuccess, handleCommandError } from "./helpers";

export const memorize: CommandDefinition = {
	name: "memorize",
	args: [
		{ name: "key", required: true, description: "Memory key" },
		{ name: "value", required: true, description: "Memory value" },
		{ name: "source", required: false, description: "Source of the memory entry" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const key = args.key;
			const value = args.value;
			const source = args.source || ctx.taskId || ctx.threadId || "agent";
			const memoryId = deterministicUUID(BOUND_NAMESPACE, key);
			const now = new Date().toISOString();

			// Check if entry exists (including soft-deleted rows to avoid UNIQUE constraint on re-insert)
			const existing = ctx.db
				.prepare("SELECT id, deleted FROM semantic_memory WHERE key = ?")
				.get(key) as { id: string; deleted: number } | undefined;

			if (existing) {
				// Update existing entry — also restores soft-deleted rows by setting deleted=0
				updateRow(
					ctx.db,
					"semantic_memory",
					memoryId,
					{
						value,
						source,
						last_accessed_at: now,
						deleted: 0,
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

			return commandSuccess(`Memory saved: ${key}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
