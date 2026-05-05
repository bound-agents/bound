import { randomUUID } from "node:crypto";
import { enqueueNotification } from "@bound/core";
import { z } from "zod";
import type { RegisteredTool, ToolContext } from "../types";
import { parseToolInput, zodToToolParams } from "./tool-schema";

interface ThreadRow {
	id: string;
}

const introspectSchema = z.object({
	thread_id: z.string().describe("Target thread ID to introspect"),
	message: z.string().describe("Question or request to send to the target thread"),
	timeout: z.number().optional().describe("Timeout in milliseconds (default 300000)"),
});

export function createIntrospectTool(ctx: ToolContext): RegisteredTool {
	const jsonSchema = zodToToolParams(introspectSchema);

	return {
		kind: "builtin",
		toolDefinition: {
			type: "function",
			function: {
				name: "introspect",
				description:
					"Introspect on a question by consulting another one of your threads. Use when you need deeper reflection or insight informed by a different context.",
				parameters: jsonSchema,
			},
		},
		execute: async (raw: Record<string, unknown>) => {
			const parsed = parseToolInput(introspectSchema, raw, "introspect");
			if (!parsed.ok) return parsed.error;
			const input = parsed.value;

			try {
				// Validate thread_id is not empty
				if (!input.thread_id.trim()) {
					return "Error: thread_id is required and cannot be empty";
				}

				// Self-introspect guard
				if (input.thread_id === ctx.threadId) {
					return "Error: Cannot introspect self. Use introspect to consult a different thread.";
				}

				// Check thread exists and is not deleted
				const thread = ctx.db
					.query("SELECT id FROM threads WHERE id = ? AND deleted = 0")
					.get(input.thread_id) as ThreadRow | null;

				if (!thread) {
					return `Error: Thread not found or is deleted: ${input.thread_id}`;
				}

				// Generate correlation ID
				const correlationId = randomUUID();

				// Enqueue notification with introspect payload
				enqueueNotification(ctx.db, input.thread_id, {
					type: "introspect",
					correlation_id: correlationId,
					source_thread: ctx.threadId ?? null,
					content: input.message,
				});

				// Emit event for wakeup
				ctx.eventBus.emit("notify:enqueued", { thread_id: input.thread_id });

				return `Introspect request sent to thread ${input.thread_id} with correlation ${correlationId}. Awaiting response...`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `Error: ${message}`;
			}
		},
	};
}
