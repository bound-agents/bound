import { describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import {
	UNREADABLE_CONTENT_PLACEHOLDER,
	extractFullText,
	parseConversationContent,
	parseMessageContent,
} from "../message-text";

const truncated = `[{"type":"thinking","thinking":"","reasoning_encrypted_content":"${"f9/3/+f57/".repeat(200)}`;

function msg(role: Message["role"], content: string): Message {
	return { role, content } as Message;
}

describe("#340 unreadable block-array content", () => {
	it("renders a truncated block array as a placeholder for assistant and user messages", () => {
		expect(parseConversationContent(truncated)).toBe(UNREADABLE_CONTENT_PLACEHOLDER);
		expect(extractFullText(msg("assistant", truncated))).toBe(UNREADABLE_CONTENT_PLACEHOLDER);
		expect(extractFullText(msg("user", truncated))).toBe(UNREADABLE_CONTENT_PLACEHOLDER);
	});

	it("keeps valid arrays, ordinary bracketed text, and tool-result strings readable", () => {
		expect(parseConversationContent('[{"type":"text","text":"hi"}]')).toEqual([
			{ type: "text", text: "hi" },
		]);
		expect(parseConversationContent("[1] first point")).toBe("[1] first point");
		expect(parseMessageContent(truncated)).toBe(truncated);
		expect(extractFullText(msg("tool_result", truncated))).toBe(truncated);
	});
});
