import { describe, expect, it } from "bun:test";
import { toModelMessages } from "../bridge";
import type { LLMMessage } from "../types";

const IMAGE_DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function history(): LLMMessage[] {
	return [
		{ role: "user", content: "look" },
		{
			role: "tool_call",
			content: [{ type: "tool_use", id: "c1", name: "read", input: { path: "a.png" } }],
		},
		{
			role: "tool_result",
			tool_use_id: "c1",
			content: [
				{ type: "text", text: "before" },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: IMAGE_DATA },
					description: "a pixel",
				},
				{ type: "text", text: "after" },
			],
		},
	];
}

function toolOutput(messages: ReturnType<typeof toModelMessages>): unknown {
	const tool = messages.find((m) => m.role === "tool") as {
		content: Array<{ output: unknown }>;
	};
	return tool.content[0].output;
}

describe("toModelMessages — toolResultMedia", () => {
	it("text-only: a tool-result image becomes a placeholder; text items and order are kept", () => {
		const output = toolOutput(toModelMessages(history(), { toolResultMedia: "text-only" }));
		expect(output).toEqual({
			type: "content",
			value: [
				{ type: "text", text: "before" },
				{
					type: "text",
					text: '[Image omitted: file_id=(inline) media_type=image/png description="a pixel" reason="provider takes text-only tool results"]',
				},
				{ type: "text", text: "after" },
			],
		});
		expect(JSON.stringify(output)).not.toContain(IMAGE_DATA);
	});

	it("text-only: a file_ref image placeholder carries the file id, even when it resolves", () => {
		const msgs = history();
		(msgs[2].content as Array<{ type: string; source?: unknown }>)[1].source = {
			type: "file_ref",
			file_id: "f-123",
			media_type: "image/jpeg",
		};
		const output = toolOutput(
			toModelMessages(msgs, { toolResultMedia: "text-only", resolveFileRef: () => IMAGE_DATA }),
		) as { value: Array<{ type: string; text?: string }> };
		expect(output.value.every((i) => i.type === "text")).toBe(true);
		expect(output.value[1].text).toContain("file_id=f-123 media_type=image/jpeg");
		expect(JSON.stringify(output)).not.toContain(IMAGE_DATA);
	});

	it("text-only: documents use text_representation, else the unavailable placeholder", () => {
		const msgs: LLMMessage[] = [
			...history().slice(0, 2),
			{
				role: "tool_result",
				tool_use_id: "c1",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: IMAGE_DATA },
						text_representation: "pdf text",
					},
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: IMAGE_DATA },
						title: "Spec",
					},
				],
			},
		];
		const output = toolOutput(toModelMessages(msgs, { toolResultMedia: "text-only" }));
		expect(output).toEqual({
			type: "content",
			value: [
				{ type: "text", text: "pdf text" },
				{ type: "text", text: '[Document unavailable: file_id=(inline) title="Spec"]' },
			],
		});
	});

	it("default: the image still rides as an ai@7 file item (Anthropic-family path)", () => {
		const output = toolOutput(toModelMessages(history()));
		expect(output).toEqual({
			type: "content",
			value: [
				{ type: "text", text: "before" },
				{ type: "file", data: { type: "data", data: IMAGE_DATA }, mediaType: "image/png" },
				{ type: "text", text: "after" },
			],
		});
	});
});
