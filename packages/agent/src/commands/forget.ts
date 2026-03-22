import { softDelete } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";

export const forget: CommandDefinition = {
	name: "forget",
	args: [{ name: "key", required: true, description: "Memory key to delete" }],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const key = args.key;
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
