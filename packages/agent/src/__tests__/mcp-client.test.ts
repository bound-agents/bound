import { describe, expect, it } from "bun:test";
import { extractMCPToolResult } from "../mcp-client";

describe("extractMCPToolResult", () => {
	it("extracts text-only content", () => {
		const result = extractMCPToolResult([{ type: "text", text: "hello world" }]);
		expect(result.content).toBe("hello world");
		expect(result.images).toBeUndefined();
	});

	it("joins multiple text blocks with newlines", () => {
		const result = extractMCPToolResult([
			{ type: "text", text: "line 1" },
			{ type: "text", text: "line 2" },
		]);
		expect(result.content).toBe("line 1\nline 2");
		expect(result.images).toBeUndefined();
	});

	it("preserves image blocks alongside text", () => {
		const result = extractMCPToolResult([
			{ type: "text", text: "Here is the screenshot" },
			{
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUg==",
			},
		]);
		expect(result.content).toBe("Here is the screenshot");
		expect(result.images).toHaveLength(1);
		expect(result.images?.[0]).toEqual({
			media_type: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUg==",
		});
	});

	it("handles multiple images", () => {
		const result = extractMCPToolResult([
			{ type: "text", text: "Two screenshots" },
			{ type: "image", mimeType: "image/png", data: "AAAA" },
			{ type: "image", mimeType: "image/jpeg", data: "BBBB" },
		]);
		expect(result.images).toHaveLength(2);
		expect(result.images?.[0].media_type).toBe("image/png");
		expect(result.images?.[1].media_type).toBe("image/jpeg");
	});

	it("handles image-only content (no text)", () => {
		const result = extractMCPToolResult([{ type: "image", mimeType: "image/png", data: "AAAA" }]);
		expect(result.content).toBe("");
		expect(result.images).toHaveLength(1);
	});

	it("handles audio and resource blocks as text placeholders", () => {
		const result = extractMCPToolResult([
			{ type: "audio", mimeType: "audio/wav", data: "..." },
			{ type: "resource", resource: { text: "file contents", uri: "file:///a.txt" } },
		]);
		expect(result.content).toBe("[audio: audio/wav]\nfile contents");
		expect(result.images).toBeUndefined();
	});
});
