import { describe, expect, it } from "bun:test";
import { parseToolCallContent } from "../tool-call-content";

describe("parseToolCallContent", () => {
	it("routes tagged thinking in tool-mode text through the reasoning field", () => {
		const parsed = parseToolCallContent(
			JSON.stringify([
				{ type: "text", text: "<thinking>Choose the narrowest test.</thinking>" },
				{ type: "tool_use", id: "tool-1", name: "boundless_bash", input: { command: "bun test" } },
			]),
		);

		expect(parsed.thinkingText).toBe("Choose the narrowest test.");
		expect(parsed.inlineText).toBe("");
		expect(parsed.toolUses).toEqual([
			{ type: "tool_use", id: "tool-1", name: "boundless_bash", input: { command: "bun test" } },
		]);
	});

	it("preserves ordinary text outside tagged thinking", () => {
		const parsed = parseToolCallContent(
			JSON.stringify([{ type: "text", text: "Before<thinking>reasoning</thinking>After" }]),
		);

		expect(parsed.thinkingText).toBe("reasoning");
		expect(parsed.inlineText).toBe("Before\n\nAfter");
	});
});
