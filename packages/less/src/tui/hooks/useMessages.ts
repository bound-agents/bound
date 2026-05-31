import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { useEffect, useState } from "react";

/**
 * Sentinel id for the optimistic user-message placeholder. A message carrying
 * this id is a locally-appended echo of what the user just sent, rendered
 * immediately so the input doesn't feel like it dropped during the (sometimes
 * >3s) round-trip to persistence. It is reconciled away the moment the real
 * `message:created` for that user turn arrives. See #88.
 */
export const PENDING_USER_MESSAGE_ID = "__pending_user__";

export interface UseMessagesResult {
	messages: Message[];
	appendMessage: (message: Message) => void;
	clearMessages: () => void;
	replaceMessages: (messages: Message[]) => void;
	updateMessage: (messageId: string, updates: Partial<Message>) => void;
	/**
	 * Optimistically render the user's message before the server has persisted
	 * and broadcast it. Reconciled by the first real user `message:created`.
	 */
	appendPendingUserMessage: (threadId: string, content: string) => void;
	/** Drop a stuck optimistic placeholder (e.g. when the send call threw). */
	clearPendingUserMessage: () => void;
}

/**
 * Manages message list state.
 * - State: `Message[]` initialized from attach flow
 * - Listens to `client.on("message:created", ...)` to append new messages
 * - Handles pending tool call placeholders (from AC7.2):
 *   - When a `tool:call` message arrives, replace the placeholder with the actual tool call
 *   - When `tool:result` arrives, append it
 * - Handles the optimistic user-message placeholder (#88):
 *   - `appendPendingUserMessage` renders the user's text immediately
 *   - The first real user `message:created` replaces it (only one send is ever
 *     in flight in boundless, so id/content matching is unnecessary)
 */
export function useMessages(
	client: BoundClient | null,
	initialMessages: Message[] = [],
): UseMessagesResult {
	const [messages, setMessages] = useState<Message[]>(initialMessages);

	useEffect(() => {
		if (!client) return;

		const handleMessageCreated = (msg: Message) => {
			setMessages((prev) => {
				// Deduplicate: skip if a message with this ID is already present.
				// The server may broadcast the same message twice (once from the
				// agent loop and once from the post-loop handler).
				if (msg.id && msg.id !== PENDING_USER_MESSAGE_ID && prev.some((m) => m.id === msg.id)) {
					return prev;
				}

				// If a real user message arrives, reconcile it with the optimistic
				// placeholder we rendered on send. Only one send is in flight at a
				// time, so replacing the placeholder regardless of content avoids
				// both a stuck placeholder and a duplicate echo.
				if (msg.role === "user" && msg.id && msg.id !== PENDING_USER_MESSAGE_ID) {
					const pendingIdx = prev.findIndex((m) => m.id === PENDING_USER_MESSAGE_ID);
					if (pendingIdx !== -1) {
						const updated = [...prev];
						updated[pendingIdx] = msg;
						return updated;
					}
				}

				// If this is a tool_call message, check if there's a pending placeholder to replace
				// Pending placeholders are identified by missing id field
				if (msg.role === "tool_call") {
					const placeholderIdx = prev.findIndex(
						(m) => m.role === "tool_call" && m.tool_name === msg.tool_name && !m.id,
					);
					if (placeholderIdx !== -1) {
						// Replace placeholder with actual tool call
						const updated = [...prev];
						updated[placeholderIdx] = msg;
						return updated;
					}
				}

				// Otherwise, append the new message
				return [...prev, msg];
			});
		};

		client.on("message:created", handleMessageCreated);

		return () => {
			client.off("message:created", handleMessageCreated);
		};
	}, [client]);

	const appendMessage = (message: Message) => {
		setMessages((prev) => [...prev, message]);
	};

	const clearMessages = () => {
		setMessages([]);
	};

	const replaceMessages = (next: Message[]) => {
		setMessages(next);
	};

	const updateMessage = (messageId: string, updates: Partial<Message>) => {
		setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, ...updates } : m)));
	};

	const appendPendingUserMessage = (threadId: string, content: string) => {
		const placeholder: Message = {
			id: PENDING_USER_MESSAGE_ID,
			thread_id: threadId,
			role: "user",
			content,
			model_id: null,
			tool_name: null,
			created_at: new Date().toISOString(),
			modified_at: null,
			host_origin: "",
			deleted: 0,
			exit_code: null,
			metadata: null,
		};
		setMessages((prev) => {
			// Guard against a double-append if send is somehow invoked twice before
			// the placeholder is reconciled.
			if (prev.some((m) => m.id === PENDING_USER_MESSAGE_ID)) return prev;
			return [...prev, placeholder];
		});
	};

	const clearPendingUserMessage = () => {
		setMessages((prev) => prev.filter((m) => m.id !== PENDING_USER_MESSAGE_ID));
	};

	return {
		messages,
		appendMessage,
		clearMessages,
		replaceMessages,
		updateMessage,
		appendPendingUserMessage,
		clearPendingUserMessage,
	};
}
