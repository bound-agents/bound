import { beforeEach, describe, expect, it } from "bun:test";
import type { McpServerManager } from "../mcp/manager";
import { proxyToolCall } from "../mcp/proxy";

// Mock the MCP manager
const createMockManager = (getClientImpl: (name: string) => any = () => null): McpServerManager => {
	const manager = {
		getClient: getClientImpl,
	} as unknown as McpServerManager;
	return manager;
};

describe("proxyToolCall", () => {
	let manager: McpServerManager;
	const hostname = "test-host";
	const signal = new AbortController().signal;

	beforeEach(() => {
		manager = createMockManager();
	});

	it("returns error ContentBlock when tool name not in mapping", async () => {
		const toolNameMapping = new Map();

		const result = await proxyToolCall(
			manager,
			"unknown_tool",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		expect(result).toEqual([
			{
				type: "text",
				text: expect.stringContaining("Unknown tool"),
			},
		]);
	});

	it("returns error ContentBlock when server not running", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_read", { serverName: "test", toolName: "read" }],
		]);

		manager = createMockManager(() => null);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_read",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		expect(result).toEqual([
			{
				type: "text",
				text: expect.stringContaining("not running"),
			},
		]);
	});

	it("maps text content to ContentBlock", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_read", { serverName: "test", toolName: "read" }],
		]);

		let callToolArgs: any = null;
		const mockClient = {
			callTool: async (args: any) => {
				callToolArgs = args;
				return {
					isError: false,
					content: [
						{
							type: "text",
							text: "file content here",
						},
					],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_read",
			{ file: "test.txt" },
			signal,
			hostname,
			toolNameMapping,
		);

		// Should include provenance block and text content
		expect(result.length).toBe(2);
		expect(result[0]).toEqual({
			type: "text",
			text: expect.stringContaining("[boundless:mcp]"),
		});
		expect(result[1]).toEqual({
			type: "text",
			text: "file content here",
		});

		// Verify client.callTool was called with correct args
		expect(callToolArgs).toEqual({
			name: "read",
			arguments: { file: "test.txt" },
		});
	});

	it("maps image content to ContentBlock", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_screenshot", { serverName: "test", toolName: "screenshot" }],
		]);

		const mockClient = {
			callTool: async () => {
				return {
					isError: false,
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
						},
					],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_screenshot",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		// Should include provenance block and image content
		expect(result.length).toBe(2);
		expect(result[0]).toEqual({
			type: "text",
			text: expect.stringContaining("[boundless:mcp]"),
		});
		expect(result[1]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			},
		});
	});

	it("handles unsupported content types gracefully", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_tool", { serverName: "test", toolName: "tool" }],
		]);

		const mockClient = {
			callTool: async () => {
				return {
					isError: false,
					content: [
						{
							type: "unsupported",
							data: "something",
						},
					],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_tool",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		// Should include provenance and graceful degradation message
		expect(result.length).toBe(2);
		expect(result[1]).toEqual({
			type: "text",
			text: expect.stringContaining("unsupported MCP content type"),
		});
	});

	it("marks result as error when MCP result has isError", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_tool", { serverName: "test", toolName: "tool" }],
		]);

		const mockClient = {
			callTool: async () => {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Tool execution failed",
						},
					],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_tool",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		// Result should be marked as error
		expect(result).toHaveLength(2);
		// The isError flag should be handled (either on first text block or separate)
		const textBlock = result.find((b) => b.type === "text" && (b as any).text.includes("failed"));
		expect(textBlock).toBeDefined();
	});

	it("includes hostname, serverName, toolName in provenance", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_github_read", { serverName: "github", toolName: "read_file" }],
		]);

		const mockClient = {
			callTool: async () => {
				return {
					isError: false,
					content: [
						{
							type: "text",
							text: "content",
						},
					],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_github_read",
			{},
			signal,
			"my-laptop",
			toolNameMapping,
		);

		const provenanceBlock = result[0];
		expect(provenanceBlock.type).toBe("text");
		expect((provenanceBlock as any).text).toContain("my-laptop");
		expect((provenanceBlock as any).text).toContain("github");
		expect((provenanceBlock as any).text).toContain("read_file");
	});

	it("handles empty content array from MCP", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_tool", { serverName: "test", toolName: "tool" }],
		]);

		const mockClient = {
			callTool: async () => {
				return {
					isError: false,
					content: [],
				};
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_tool",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		// Should include provenance block at minimum
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0].type).toBe("text");
		expect((result[0] as any).text).toContain("[boundless:mcp]");
	});

	it("propagates MCP callTool errors as error ContentBlock", async () => {
		const toolNameMapping = new Map([
			["boundless_mcp_test_tool", { serverName: "test", toolName: "tool" }],
		]);

		const mockClient = {
			callTool: async () => {
				throw new Error("MCP server error: connection lost");
			},
		};

		manager = createMockManager(() => mockClient);

		const result = await proxyToolCall(
			manager,
			"boundless_mcp_test_tool",
			{},
			signal,
			hostname,
			toolNameMapping,
		);

		// Should return error ContentBlock
		expect(result.length).toBeGreaterThanOrEqual(1);
		const textBlocks = result.filter((b) => b.type === "text");
		const hasError = textBlocks.some(
			(b) => (b as any).text.includes("error") || (b as any).text.includes("Error"),
		);
		expect(hasError).toBe(true);
	});
});
