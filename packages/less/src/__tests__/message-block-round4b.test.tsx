import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { MessageBlock } from "../tui/components/MessageBlock";
import { messageFixture } from "./tui-message-fixtures";

describe("MessageBlock round4b — write preview body rendering", () => {
	describe("WritePreviewBody truncation (MessageBlock.tsx 517-521)", () => {
		it("renders '⋯ N more lines' when a write preview exceeds the preview cap", () => {
			const manyLines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
			const call = messageFixture({
				id: "call-bigwrite",
				role: "tool_call" as const,
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "write-big",
						name: "boundless_write",
						input: { file_path: "/tmp/out.txt", content: manyLines },
					},
				]),
			});
			const frame =
				render(
					React.createElement(MessageBlock, { message: call, terminalColumns: 120 }),
				).lastFrame() ?? "";
			expect(frame).toContain("more");
		});

		it("renders a single-line write preview with the + gutter", () => {
			const call = messageFixture({
				id: "call-write1",
				role: "tool_call" as const,
				content: JSON.stringify([
					{
						type: "tool_use",
						id: "write-1",
						name: "boundless_write",
						input: { file_path: "/tmp/one.ts", content: "const only = 1;" },
					},
				]),
			});
			const frame =
				render(
					React.createElement(MessageBlock, { message: call, terminalColumns: 120 }),
				).lastFrame() ?? "";
			expect(frame).toContain("const only = 1;");
		});
	});
});
