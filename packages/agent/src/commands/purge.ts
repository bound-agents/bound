import { insertRow } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { randomUUID } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

export const purge: CommandDefinition = {
	name: "purge",
	args: [
		{ name: "last", required: false, description: "Number of last messages to purge" },
		{ name: "ids", required: false, description: "Comma-separated message IDs to purge" },
		{ name: "thread-id", required: false, description: "Thread ID for last N messages" },
		{ name: "summary", required: false, description: "Create a summary of purged messages" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
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
					return commandError("--last must be a positive integer");
				}

				const messages = ctx.db
					.prepare("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?")
					.all(threadId, n) as Array<{ id: string }>;

				targetIds = messages.map((m) => m.id);
			} else {
				return commandError("must specify --ids or (--last and --thread-id)");
			}

			// Tool-pair integrity: when a tool_call is targeted, auto-include its paired tool_result
			if (targetIds.length > 0) {
				const targetSet = new Set(targetIds);
				const placeholders = targetIds.map(() => "?").join(", ");
				const targeted = ctx.db
					.prepare(`SELECT id, role FROM messages WHERE id IN (${placeholders})`)
					.all(...targetIds) as Array<{ id: string; role: string }>;

				const additionalIds: string[] = [];
				for (const msg of targeted) {
					if (msg.role === "tool_call") {
						// Find the paired tool_result that immediately follows this tool_call
						const paired = ctx.db
							.prepare(
								`SELECT id FROM messages
								 WHERE thread_id = (SELECT thread_id FROM messages WHERE id = ?)
								   AND role = 'tool_result'
								   AND created_at > (SELECT created_at FROM messages WHERE id = ?)
								 ORDER BY created_at ASC LIMIT 1`,
							)
							.get(msg.id, msg.id) as { id: string } | undefined;

						if (paired && !targetSet.has(paired.id)) {
							additionalIds.push(paired.id);
							targetSet.add(paired.id);
						}
					}
				}

				if (additionalIds.length > 0) {
					targetIds = [...targetIds, ...additionalIds];
				}
			}

			// Create a purge message referencing the target IDs
			const purgeMessageId = randomUUID();
			const summary = args.summary
				? "Messages purged from conversation"
				: "Summary of purged messages";
			const threadId = args["thread-id"] || ctx.threadId || "";

			// Store content as JSON with target_ids for context-assembly.ts to parse
			const content = JSON.stringify({
				target_ids: targetIds,
				summary,
			});

			insertRow(
				ctx.db,
				"messages",
				{
					id: purgeMessageId,
					thread_id: threadId,
					role: "purge",
					content,
					model_id: null,
					tool_name: null,
					created_at: now,
					modified_at: now,
					host_origin: ctx.siteId,
				},
				ctx.siteId,
			);

			return commandSuccess(
				`Purge message created: ${purgeMessageId}\nTargeted ${targetIds.length} messages\n`,
			);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};
