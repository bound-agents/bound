import { softDelete } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

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
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			if (args.prefix) {
				// Soft-delete all semantic_memory entries where key starts with prefix
				const prefix = args.prefix;
				const entries = ctx.db
					.prepare("SELECT id, key FROM semantic_memory WHERE key LIKE ? AND deleted = 0")
					.all(`${prefix}%`) as Array<{ id: string; key: string }>;

				if (entries.length === 0) {
					return {
						stdout: `No memories found with prefix: ${prefix}\n`,
						stderr: "",
						exitCode: 0,
					};
				}

				for (const entry of entries) {
					softDelete(ctx.db, "semantic_memory", entry.id, ctx.siteId);
				}

				return {
					stdout: `Deleted ${entries.length} memories with prefix: ${prefix}\n`,
					stderr: "",
					exitCode: 0,
				};
			}

			const key = args.key;
			if (!key) {
				return {
					stdout: "",
					stderr: "Error: must specify key or --prefix\n",
					exitCode: 1,
				};
			}

			const memoryId = deterministicUUID(BOUND_NAMESPACE, key);

			// Check if entry exists and is not deleted
			const existing = ctx.db
				.prepare("SELECT id FROM semantic_memory WHERE key = ? AND deleted = 0")
				.get(key) as { id: string } | undefined;

			if (!existing) {
				return {
					stdout: "",
					stderr: `Memory not found: ${key}\n`,
					exitCode: 1,
				};
			}

			// Soft-delete the entry
			softDelete(ctx.db, "semantic_memory", memoryId, ctx.siteId);

			return {
				stdout: `Memory deleted: ${key}\n`,
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
