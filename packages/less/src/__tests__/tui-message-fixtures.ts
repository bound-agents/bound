import type { Message } from "@bound/shared";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock, type MessageBlockProps } from "../tui/components/MessageBlock";

export type MessageFixture = Partial<Message> & Pick<Message, "id" | "role" | "content">;

/** A persisted transcript message with explicit, production-shaped defaults. */
export function messageFixture(overrides: MessageFixture): Message {
	return {
		thread_id: "t1",
		model_id: null,
		tool_name: null,
		created_at: "2026-05-22T00:00:00Z",
		modified_at: null,
		host_origin: "test",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

export type ToolUse = {
	id: string;
	name: string;
	input?: Record<string, unknown>;
};

export function toolCall(id: string, uses: ToolUse[]): Message {
	return messageFixture({
		id,
		role: "tool_call",
		content: JSON.stringify(uses.map((use) => ({ type: "tool_use", ...use }))),
	});
}

export function toolResult(id: string, toolUseId: string, content = "ok"): Message {
	return messageFixture({ id, role: "tool_result", tool_name: toolUseId, content });
}

export function renderMessageBlock(message: Message, props: Omit<MessageBlockProps, "message">) {
	const result = render(React.createElement(MessageBlock, { message, ...props }));
	return { lastFrame: () => result.lastFrame() };
}
