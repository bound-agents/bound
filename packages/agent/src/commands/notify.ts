import { enqueueNotification } from "@bound/core";
import type { CommandContext, CommandDefinition } from "@bound/sandbox";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { commandError, commandSuccess, handleCommandError } from "./helpers";

interface UserRow {
	id: string;
	display_name: string;
	platform_ids: string | null;
}

interface ThreadRow {
	id: string;
}

/**
 * Resolve a bound username to a user ID and validate platform access.
 */
function resolveUser(db: CommandContext["db"], username: string): UserRow | null {
	const userId = deterministicUUID(BOUND_NAMESPACE, username);
	return db
		.query("SELECT id, display_name, platform_ids FROM users WHERE id = ? AND deleted = 0")
		.get(userId) as UserRow | null;
}

/**
 * Find the most recent DM thread for a user on a given platform.
 */
function findDmThread(
	db: CommandContext["db"],
	userId: string,
	platform: string,
): ThreadRow | null {
	return db
		.query(
			"SELECT id FROM threads WHERE user_id = ? AND interface = ? AND deleted = 0 ORDER BY last_message_at DESC LIMIT 1",
		)
		.get(userId, platform) as ThreadRow | null;
}

/**
 * Get all non-deleted users from the database.
 */
function getAllUsers(db: CommandContext["db"]): UserRow[] {
	return db
		.query("SELECT id, display_name, platform_ids FROM users WHERE deleted = 0")
		.all() as UserRow[];
}

/**
 * Enqueue a proactive notification and optionally trigger execution.
 */
async function enqueueAndExecute(
	ctx: CommandContext,
	threadId: string,
	sourceThreadId: string | undefined,
	message: string,
): Promise<void> {
	enqueueNotification(ctx.db, threadId, {
		type: "proactive",
		source_thread: sourceThreadId ?? null,
		content: message,
	});

	if (ctx.threadExecutor) {
		// Direct execution — the executor will drain the dispatch queue for this thread
		await ctx.threadExecutor.execute(threadId, async () => ({ yielded: false }));
	}
}

export const notify: CommandDefinition = {
	name: "notify",
	args: [
		{ name: "user", required: false, description: "Target bound username" },
		{ name: "all", required: false, description: "Send to all users" },
		{ name: "platform", required: false, description: "Target platform (e.g., discord)" },
		{ name: "message", required: false, description: "Notification message content" },
	],
	handler: async (args: Record<string, string>, ctx: CommandContext) => {
		try {
			const platform = args.platform;
			const user = args.user;
			const all = args.all;
			const message = args.message;

			// Validate --platform
			if (!platform?.trim()) {
				return commandError("Missing required flag: --platform <name>");
			}

			// Validate --user / --all mutual exclusivity
			if (user && all) {
				return commandError("--user and --all are mutually exclusive");
			}
			if (!user && !all) {
				return commandError("One of --user <name> or --all is required");
			}

			// Validate message
			if (!message?.trim()) {
				return commandError("Missing notification message");
			}

			const sourceThreadId = ctx.threadId;

			if (all) {
				return await handleAll(ctx, platform.trim(), message.trim(), sourceThreadId);
			}

			return await handleSingleUser(
				ctx,
				(user as string).trim(),
				platform.trim(),
				message.trim(),
				sourceThreadId,
			);
		} catch (error) {
			return handleCommandError(error);
		}
	},
};

async function handleSingleUser(
	ctx: CommandContext,
	username: string,
	platform: string,
	message: string,
	sourceThreadId: string | undefined,
) {
	const userRow = resolveUser(ctx.db, username);
	if (!userRow) {
		return commandError(`User not found: ${username}`);
	}

	const thread = findDmThread(ctx.db, userRow.id, platform);
	if (!thread) {
		return commandError(`No ${platform} thread found for user ${username}`);
	}

	await enqueueAndExecute(ctx, thread.id, sourceThreadId, message);
	return commandSuccess(`Notification enqueued for ${username} on ${platform}.\n`);
}

async function handleAll(
	ctx: CommandContext,
	platform: string,
	message: string,
	sourceThreadId: string | undefined,
) {
	const users = getAllUsers(ctx.db);
	let delivered = 0;
	let skipped = 0;

	for (const user of users) {
		// Check if user has the target platform
		const platformIds = user.platform_ids ? JSON.parse(user.platform_ids) : {};
		if (!platformIds[platform]) {
			skipped++;
			continue;
		}

		const thread = findDmThread(ctx.db, user.id, platform);
		if (!thread) {
			skipped++;
			continue;
		}

		await enqueueAndExecute(ctx, thread.id, sourceThreadId, message);
		delivered++;
	}

	if (delivered === 0) {
		return commandError(`No ${platform} threads found for any users`);
	}

	const skipNote = skipped > 0 ? ` (${skipped} skipped — no thread)` : "";
	return commandSuccess(
		`Notification enqueued for ${delivered} user(s) on ${platform}${skipNote}.\n`,
	);
}
