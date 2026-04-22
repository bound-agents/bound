import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";

const DEFAULT_MAX_POLL_MS = 30 * 60 * 1000; // 30 minutes

export interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export interface BoundChatHandlerOptions {
	maxPollMs?: number;
}

export function createBoundChatHandler(
	client: BoundClient,
	options?: BoundChatHandlerOptions,
): (args: { message: string; thread_id?: string }) => Promise<ToolResult> {
	const maxPollMs = options?.maxPollMs ?? DEFAULT_MAX_POLL_MS;

	return async ({ message, thread_id }) => {
		try {
			// Step 1: Get or create thread
			const threadId = thread_id ?? (await client.createMcpThread()).thread_id;

			// Step 2: Subscribe to thread events
			client.subscribe(threadId);

			// Step 3: Wait for completion via thread:status event (with timeout)
			const completionPromise = new Promise<void>((resolve, reject) => {
				// biome-ignore lint/style/useConst: handler is assigned after use in setTimeout
				let handler: (data: { thread_id: string; active: boolean }) => void;

				const timeout = setTimeout(() => {
					client.off("thread:status", handler);
					client.unsubscribe(threadId);
					reject(new Error("Timed out waiting for bound agent to respond after 30 minutes."));
				}, maxPollMs);

				handler = (data: { thread_id: string; active: boolean }) => {
					if (data.thread_id === threadId && !data.active) {
						clearTimeout(timeout);
						client.off("thread:status", handler);
						client.unsubscribe(threadId);
						resolve();
					}
				};
				client.on("thread:status", handler);
			});

			// Step 4: Send message over WS (fire-and-forget)
			client.sendMessage(threadId, message);

			// Step 5: Wait for completion
			await completionPromise;

			// Step 6: Return last assistant message (via HTTP listMessages)
			// Only fetch recent messages — we just need the last assistant reply
			const messages = await client.listMessages(threadId, { limit: 20 });
			const lastAssistant = [...messages].reverse().find((m: Message) => m.role === "assistant");

			return {
				content: [
					{
						type: "text",
						text: lastAssistant?.content ?? "",
					},
				],
			};
		} catch (e) {
			if (e instanceof Error) {
				return {
					isError: true,
					content: [{ type: "text", text: e.message }],
				};
			}
			throw e;
		}
	};
}
