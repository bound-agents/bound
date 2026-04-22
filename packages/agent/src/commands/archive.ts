import { formatError } from "@bound/shared";

import { softDelete } from "@bound/core";
import type { CommandContext, CommandDefinition, CommandResult } from "@bound/sandbox";

function parseTimeOffset(offset: string): Date {
	const now = new Date();
	const match = offset.match(/^(\d+)(d|w|m)$/);

	if (!match) {
		throw new Error(`Invalid time offset format: ${offset}`);
	}

	const [, num, unit] = match;
	const n = Number.parseInt(num, 10);

	switch (unit) {
		case "d":
			now.setDate(now.getDate() - n);
			break;
		case "w":
			now.setDate(now.getDate() - n * 7);
			break;
		case "m":
			now.setMonth(now.getMonth() - n);
			break;
		default:
			throw new Error(`Unknown time unit: ${unit}`);
	}

	return now;
}

export const archive: CommandDefinition = {
	name: "archive",
	description: "Archive a thread to long-term storage",
	args: [
		{ name: "thread-id", required: false, description: "Thread ID to archive" },
		{
			name: "older-than",
			required: false,
			description: "Archive threads inactive for N days/weeks/months",
		},
	],
	handler: async (args: Record<string, string>, ctx: CommandContext): Promise<CommandResult> => {
		try {
			if (args["thread-id"]) {
				const threadId = args["thread-id"];

				// Archive a specific thread
				const existing = ctx.db
					.prepare("SELECT id FROM threads WHERE id = ? AND deleted = 0")
					.get(threadId) as { id: string } | undefined;

				if (!existing) {
					return {
						stdout: "",
						stderr: `Thread not found: ${threadId}\n`,
						exitCode: 1,
					};
				}

				// Soft-delete the thread
				softDelete(ctx.db, "threads", threadId, ctx.siteId);

				return {
					stdout: `Thread archived: ${threadId}\n`,
					stderr: "",
					exitCode: 0,
				};
			}
			if (args["older-than"]) {
				// Archive threads with no messages in N days
				const cutoffDate = parseTimeOffset(args["older-than"]);
				const cutoffTime = cutoffDate.toISOString();

				// Find threads not modified since cutoff
				const threads = ctx.db
					.prepare("SELECT id FROM threads WHERE last_message_at < ? AND deleted = 0")
					.all(cutoffTime) as Array<{ id: string }>;

				if (threads.length === 0) {
					return {
						stdout: "No threads matched the criteria\n",
						stderr: "",
						exitCode: 0,
					};
				}

				// Archive matching threads
				for (const thread of threads) {
					softDelete(ctx.db, "threads", thread.id, ctx.siteId);
				}

				return {
					stdout: `Archived ${threads.length} thread(s)\n`,
					stderr: "",
					exitCode: 0,
				};
			}
			return {
				stdout: "",
				stderr: "Error: must specify --thread-id or --older-than\n",
				exitCode: 1,
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
