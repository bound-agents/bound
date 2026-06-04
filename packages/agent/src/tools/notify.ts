import { enqueueNotification } from "@bound/core";
import { z } from "zod";
import { clientSessionWakeupWarning } from "../delegation.js";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

interface ThreadRow {
	id: string;
}

/**
 * Enqueue a proactive notification and signal the server to run inference.
 */
function enqueueAndSignal(
	ctx: ToolContext,
	threadId: string,
	sourceThreadId: string | undefined,
	message: string,
): void {
	enqueueNotification(ctx.db, threadId, {
		type: "proactive",
		source_thread: sourceThreadId ?? null,
		content: message,
	});

	ctx.eventBus.emit("notify:enqueued", { thread_id: threadId });
}

const notifySchema = z.object({
	thread_id: z.string().describe("Target thread ID"),
	message: z.string().describe("Notification message content"),
});

export function createNotifyTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(notifySchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "notify",
				description:
					"Remind yourself of something. Enqueues a message and triggers inference on the target thread. When composing messages, use 'we' and 'our' — you are both the sender and the receiver. Be sure to check if the target thread has the right capabilities to act on your reminder before using this.",
				parameters: jsonSchema,
			},
		},
		// Non-idempotent: each call sends another message to the target.
		idempotent: false,
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(notifySchema, raw, "notify");
			if (!parsed.ok) return parsed.error;
			const { thread_id, message } = parsed.value;

			try {
				if (!message.trim()) {
					return "Error: Missing notification message";
				}

				if (thread_id === ctx.threadId) {
					return "Error: Cannot notify the current thread. Run notify from a background task to deliver to this thread.";
				}

				const thread = ctx.db
					.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
					.get(thread_id) as ThreadRow | null;

				if (!thread) {
					return `Error: Thread not found or is deleted: ${thread_id}`;
				}

				enqueueAndSignal(ctx, thread.id, ctx.threadId, message.trim());
				const warning = clientSessionWakeupWarning(ctx.db, thread.id);
				const confirmation = `Notification enqueued for thread ${thread_id}.`;
				return warning ? `${confirmation}\n${warning}` : confirmation;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return `Error: ${msg}`;
			}
		},
	};
}
