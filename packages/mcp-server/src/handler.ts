import type { BoundClient, BoundMessage } from "./bound-client";
import { BoundNotRunningError } from "./bound-client";

const POLL_INTERVAL_MS = 500;
const MAX_POLL_MS = 30 * 60 * 1000; // 30 minutes

export interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export function createBoundChatHandler(
	client: BoundClient,
): (args: { message: string; thread_id?: string }) => Promise<ToolResult> {
	return async ({ message, thread_id }) => {
		try {
			// Step 1: Get or create thread
			const threadId = thread_id ?? (await client.createMcpThread()).thread_id;

			// Step 2: Send message
			await client.sendMessage(threadId, message);

			// Step 3: Poll until agent loop completes
			const startTime = Date.now();
			while (true) {
				const status = await client.getStatus(threadId);
				if (!status.active) break;

				if (Date.now() - startTime >= MAX_POLL_MS) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: "Timed out waiting for bound agent to respond after 30 minutes.",
							},
						],
					};
				}

				await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			}

			// Step 4: Return last assistant message
			const messages = await client.getMessages(threadId);
			const lastAssistant = [...messages]
				.reverse()
				.find((m: BoundMessage) => m.role === "assistant");

			return {
				content: [
					{
						type: "text",
						text: lastAssistant?.content ?? "",
					},
				],
			};
		} catch (e) {
			if (e instanceof BoundNotRunningError) {
				return {
					isError: true,
					content: [{ type: "text", text: e.message }],
				};
			}
			throw e;
		}
	};
}
