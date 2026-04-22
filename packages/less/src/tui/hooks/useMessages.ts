import type { BoundClient } from "@bound/client";
import type { Message } from "@bound/shared";
import { useEffect, useState } from "react";

export interface UseMessagesResult {
	messages: Message[];
	appendMessage: (message: Message) => void;
	clearMessages: () => void;
	replaceMessages: (messages: Message[]) => void;
	updateMessage: (messageId: string, updates: Partial<Message>) => void;
}

/**
 * Manages message list state.
 * - State: `Message[]` initialized from attach flow
 * - Listens to `client.on("message:created", ...)` to append new messages
 * - Handles pending tool call placeholders (from AC7.2):
 *   - When a `tool:call` message arrives, replace the placeholder with the actual tool call
 *   - When `tool:result` arrives, append it
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
				if (msg.id && prev.some((m) => m.id === msg.id)) {
					return prev;
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

	return {
		messages,
		appendMessage,
		clearMessages,
		replaceMessages,
		updateMessage,
	};
}
