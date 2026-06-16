import { describe, expect, it } from "bun:test";
import { MCPClient, escapeNonAscii, extractMCPToolResult } from "../mcp-client";

/**
 * Build an MCPClient with its transport stubbed out so `callTool` can be
 * exercised against a canned `CallToolResult` shape without a live server.
 */
function stubbedClient(callToolResult: Record<string, unknown>): MCPClient {
	const client = new MCPClient({
		name: "stub",
		transport: "stdio",
		command: "true",
	} as never);
	const internals = client as unknown as {
		connected: boolean;
		client: { callTool: (args: unknown) => Promise<Record<string, unknown>> };
	};
	internals.connected = true;
	internals.client = { callTool: async () => callToolResult };
	return client;
}

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

describe("MCPClient.callTool structuredContent fallback (#165)", () => {
	it("projects structuredContent as JSON when no content block carries text", async () => {
		const client = stubbedClient({
			content: [],
			structuredContent: { temperature: 21, unit: "C" },
		});
		const result = await client.callTool("weather", {});
		expect(result.content).toBe(JSON.stringify({ temperature: 21, unit: "C" }));
		expect(result.isError).toBe(false);
	});

	it("projects structuredContent when content is absent entirely", async () => {
		const client = stubbedClient({
			structuredContent: { rows: [1, 2, 3] },
		});
		const result = await client.callTool("query", {});
		expect(result.content).toBe(JSON.stringify({ rows: [1, 2, 3] }));
	});

	it("prefers the text mirror over structuredContent when both are present", async () => {
		const client = stubbedClient({
			content: [{ type: "text", text: "21C" }],
			structuredContent: { temperature: 21 },
		});
		const result = await client.callTool("weather", {});
		expect(result.content).toBe("21C");
	});

	it("leaves content empty when neither a text block nor structuredContent exists", async () => {
		const client = stubbedClient({ content: [] });
		const result = await client.callTool("noop", {});
		expect(result.content).toBe("");
	});
});

describe("escapeNonAscii", () => {
	it("passes ASCII-only strings through unchanged", () => {
		expect(escapeNonAscii("hello world")).toBe("hello world");
		expect(escapeNonAscii("")).toBe("");
		expect(escapeNonAscii("abc123 !@#$%^&*()_+-=[]{}|;':\",./<>?`~")).toBe(
			"abc123 !@#$%^&*()_+-=[]{}|;':\",./<>?`~",
		);
	});

	it("escapes em dash (issue #33 repro: U+2014)", () => {
		// em dash is the canonical example from the bug report
		expect(escapeNonAscii("—")).toBe("\\u2014");
		expect(escapeNonAscii("before — after")).toBe("before \\u2014 after");
	});

	it("escapes checkmark and cross (issue #33 repro: U+2713 and U+2717)", () => {
		expect(escapeNonAscii("✓")).toBe("\\u2713");
		expect(escapeNonAscii("✗")).toBe("\\u2717");
	});

	it("escaped output round-trips via JSON.parse to the original string", () => {
		// The primary guarantee: after escaping, JSON.parse restores originals.
		const original = "em dash — checkmark ✓ cross ✗ accent café";
		const escaped = escapeNonAscii(original);
		// All escaped code points must be 0x7F or below in the output
		for (let i = 0; i < escaped.length; i++) {
			expect(escaped.charCodeAt(i)).toBeLessThanOrEqual(0x7f);
		}
		// Round-trip: wrap in a JSON string and parse back
		const roundTripped = JSON.parse(`"${escaped}"`);
		expect(roundTripped).toBe(original);
	});

	it("escapes surrogate pairs (emoji: U+1F600 😀) as two \\uXXXX sequences", () => {
		// 😀 is U+1F600, encoded in UTF-16 as surrogates D83D + DE00
		const emoji = "\uD83D\uDE00"; // same as '😀'
		const escaped = escapeNonAscii(emoji);
		expect(escaped).toBe("\\ud83d\\ude00");
		// Round-trip: JSON.parse handles lone surrogates
		const roundTripped = JSON.parse(`"${escaped}"`);
		expect(roundTripped).toBe(emoji);
	});

	it("preserves DEL (0x7F) and escapes everything above it", () => {
		// 0x7F is DEL — ASCII, so NOT escaped
		expect(escapeNonAscii("\x7f")).toBe("\x7f");
		// 0x80 is the first non-ASCII byte — MUST be escaped
		expect(escapeNonAscii("\x80")).toBe("\\u0080");
	});

	it("handles a realistic JSON body string (full issue #33 repro)", () => {
		// Simulate what happens when the agent calls github-bound add_issue_comment
		// with a body containing the characters reported in issue #33.
		const body = JSON.stringify({
			body: "This is fixed — see ✓ PR #42\nNo more â corruption ✗",
		});
		const escaped = escapeNonAscii(body);
		// ASCII-only output
		for (let i = 0; i < escaped.length; i++) {
			expect(escaped.charCodeAt(i)).toBeLessThanOrEqual(0x7f);
		}
		// Round-trips correctly
		const parsed = JSON.parse(escaped) as { body: string };
		expect(parsed.body).toBe(
			"This is fixed \u2014 see \u2713 PR #42\nNo more \u00e2 corruption \u2717",
		);
	});
});
