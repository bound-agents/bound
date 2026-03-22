import { insertRow } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";
import { randomUUID } from "@bound/shared";

export const purge: CommandDefinition = {
	name: "purge",
	args: [
		{ name: "last", required: false, description: "Number of last messages to purge" },
		{ name: "ids", required: false, description: "Comma-separated message IDs to purge" },
		{ name: "thread-id", required: false, description: "Thread ID for last N messages" },
		{ name: "create-summary", required: false, description: "Create a summary of purged messages" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			const now = new Date().toISOString();
			let targetIds: string[] = [];

			if (args.ids) {
				// Parse comma-separated IDs
				targetIds = args.ids.split(",").map((id) => id.trim());
			} else if (args.last && args["thread-id"]) {
				// Get last N messages from thread
				const n = Number.parseInt(args.last, 10);
				const threadId = args["thread-id"];

				if (Number.isNaN(n) || n <= 0) {
					return {
						stdout: "",
						stderr: "Error: --last must be a positive integer\n",
						exitCode: 1,
					};
				}

				const messages = ctx.db
					.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
					.all(threadId, n) as Array<{ id: string }>;

				targetIds = messages.map((m) => m.id);
			} else {
				return {
					stdout: "",
					stderr: "Error: must specify --ids or (--last and --thread-id)\n",
					exitCode: 1,
				};
			}

			// Create a purge message referencing the target IDs
			const purgeMessageId = randomUUID();
			const summary = args["create-summary"] ? "Messages purged from conversation" : null;
			const threadId = args["thread-id"] || ctx.threadId || "";

			insertRow(
				ctx.db,
				"messages",
				{
					id: purgeMessageId,
					thread_id: threadId,
					role: "purge",
					content: summary || "",
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: null,
					host_origin: "",
				},
				ctx.siteId,
			);

			// Store the target IDs in change_log or as metadata
			// For now, we just create the purge message
			return {
				stdout: `Purge message created: ${purgeMessageId}\nTargeted ${targetIds.length} messages\n`,
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
