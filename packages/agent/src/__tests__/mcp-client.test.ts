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

	it("handles audio and text-resource blocks as text content", () => {
		const result = extractMCPToolResult([
			{ type: "audio", mimeType: "audio/wav", data: "..." },
			{ type: "resource", resource: { text: "file contents", uri: "file:///a.txt" } },
		]);
		expect(result.content).toBe("[audio: audio/wav]\nfile contents");
		expect(result.images).toBeUndefined();
		expect(result.documents).toBeUndefined();
		expect(result.resourceLinks).toBeUndefined();
	});

	it("routes binary image-mime resource blobs into images, not documents", () => {
		// MCP servers can return embedded image bytes via the `resource`
		// content type with a `blob` field instead of the dedicated `image`
		// type. They're still images — no need to round-trip them through
		// the files table.
		const result = extractMCPToolResult([
			{
				type: "resource",
				resource: {
					uri: "file:///shot.png",
					mimeType: "image/png",
					blob: "AAAA",
				},
			},
		]);
		expect(result.content).toBe("");
		expect(result.images).toEqual([{ media_type: "image/png", data: "AAAA" }]);
		expect(result.documents).toBeUndefined();
	});

	it("routes binary non-image resource blobs into documents (preserving uri)", () => {
		const result = extractMCPToolResult([
			{ type: "text", text: "report follows" },
			{
				type: "resource",
				resource: {
					uri: "https://example.test/report.pdf",
					mimeType: "application/pdf",
					blob: "JVBERi0=",
				},
			},
		]);
		expect(result.content).toBe("report follows");
		expect(result.images).toBeUndefined();
		expect(result.documents).toEqual([
			{
				media_type: "application/pdf",
				data: "JVBERi0=",
				uri: "https://example.test/report.pdf",
			},
		]);
	});

	it("defaults missing mimeType on a binary resource to application/octet-stream", () => {
		const result = extractMCPToolResult([
			{
				type: "resource",
				resource: { uri: "file:///blob.bin", blob: "ZGF0YQ==" },
			},
		]);
		expect(result.documents).toEqual([
			{
				media_type: "application/octet-stream",
				data: "ZGF0YQ==",
				uri: "file:///blob.bin",
			},
		]);
	});

	it("collects resource_link items with full metadata", () => {
		const result = extractMCPToolResult([
			{ type: "text", text: "see also:" },
			{
				type: "resource_link",
				uri: "https://example.test/doc.pdf",
				name: "Annual report",
				mimeType: "application/pdf",
				description: "FY2025 numbers",
			},
			{
				type: "resource_link",
				uri: "https://example.test/data.csv",
			},
		]);
		expect(result.content).toBe("see also:");
		expect(result.resourceLinks).toEqual([
			{
				uri: "https://example.test/doc.pdf",
				name: "Annual report",
				mimeType: "application/pdf",
				description: "FY2025 numbers",
			},
			{
				uri: "https://example.test/data.csv",
				name: undefined,
				mimeType: undefined,
				description: undefined,
			},
		]);
	});

	it("ignores resource_link items missing the uri field (malformed)", () => {
		const result = extractMCPToolResult([{ type: "resource_link", name: "no-uri" }]);
		expect(result.resourceLinks).toBeUndefined();
	});
});
