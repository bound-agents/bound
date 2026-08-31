import { randomUUID } from "node:crypto";
import { findLiveThreadById } from "@bound/core";
import { z } from "zod";
import { clientSessionWakeupWarning } from "../delegation.js";
import type { RegisteredTool, ToolContext } from "../types";
import { routeNotificationWakeup } from "../wakeup-routing.js";
import { parseToolInput, zodToToolParams } from "./tool-schema";

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

				const thread = findLiveThreadById(ctx.db, thread_id);

				if (!thread) {
					return `Error: Thread not found or is deleted: ${thread_id}`;
				}

				const caller = ctx.threadId ? findLiveThreadById(ctx.db, ctx.threadId) : null;
				if (caller?.user_id && thread.user_id && caller.user_id !== thread.user_id) {
					return "Error: Cannot notify a thread owned by a different user.";
				}

				// Route the wakeup to the host holding the thread's live WS session
				// (#91 under unified delegation): a local enqueue on THIS host would
				// mint a second, detached loop when the session lives elsewhere.
				const routed = routeNotificationWakeup(
					ctx.db,
					ctx.eventBus,
					ctx.siteId,
					thread.id,
					{
						type: "proactive",
						source_thread: ctx.threadId ?? null,
						content: message.trim(),
						notification_id: randomUUID(),
					},
					ctx.topologyRole,
				);
				const warning = clientSessionWakeupWarning(ctx.db, thread.id);
				const confirmation =
					routed.delivery === "relayed"
						? `Notification enqueued for thread ${thread_id} (routed to session host ${routed.targetHostName}).`
						: `Notification enqueued for thread ${thread_id}.`;
				return warning ? `${confirmation}\n${warning}` : confirmation;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return `Error: ${msg}`;
			}
		},
	};
}
