import { softDelete } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const forget: CommandDefinition = {
	name: "forget",
	args: [
		{ name: "key", required: false, description: "Memory key to delete" },
		{
			name: "prefix",
			required: false,
			description: "Delete all entries whose key starts with this prefix",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			if (args.prefix) {
				// Soft-delete all semantic_memory entries where key starts with prefix
				const prefix = args.prefix;
				const entries = ctx.db
					.prepare("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
					.all(`${prefix}%`) as Array<{ id: string; key: string }>;

				if (entries.length === 0) {
					return commandSuccess(`No memories found with prefix: ${prefix}\n`);
				}

				for (const entry of entries) {
					softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
				}

				return commandSuccess(`Deleted ${entries.length} memories with prefix: ${prefix}\n`);
			}

			const key = args.key;
			if (!key) {
				return commandError("must specify key or --prefix");
			}

			const memoryId = deterministicUUID(BOUND_NAMESPACE, key);

			// Check if entry exists and is not deleted
			const existing = ctx.db
				.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(key) as { id: string } | undefined;

			if (!existing) {
				return commandError(`Memory not found: ${key}`);
			}

			// Soft-delete the entry
			softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId);

			return commandSuccess(`Memory deleted: ${key}\n`);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
