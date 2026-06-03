import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../../config";
import type { McpServerManager } from "../../mcp/manager";
import { buildToolSet } from "../registry";

const echoTool: Tool = {
	name: "echo",
	description: "Echo a message",
	inputSchema: {
		type: "object",
		properties: { message: { type: "string" } },
	},
};

function makeMcpTools(): Map<string, { tools: Tool[]; config: McpServerConfig }> {
	return new Map([
		[
			"proxysrv",
			{
				tools: [echoTool],
				config: { name: "proxysrv", transport: "stdio", command: "x" } as McpServerConfig,
			},
		],
	]);
}

describe("buildToolSet MCP handler", () => {
	it("registers the namespaced MCP tool definition", () => {
		const { tools } = buildToolSet("/cwd", "host", makeMcpTools());
		const names = tools.map((t) => t.function.name);
		expect(names).toContain("boundless_mcp_proxysrv_echo");
	});

	it("handler proxies through to the MCP client's callTool when a manager is wired", async () => {
		let received: { name: string; arguments: unknown } | null = null;
		const mockClient = {
			callTool: async (args: { name: string; arguments: unknown }) => {
				received = args;
				return { isError: false, content: [{ type: "text", text: "pong" }] };
			},
		};
		const manager = {
			getClient: () => mockClient,
		} as unknown as McpServerManager;

		const { handlers } = buildToolSet(
			"/cwd",
			"test-host",
			makeMcpTools(),
			undefined,
			undefined,
			undefined,
			manager,
		);

		const handler = handlers.get("boundless_mcp_proxysrv_echo");
		expect(handler).toBeDefined();

		const result = await handler?.({ message: "ping" }, new AbortController().signal, "/cwd");

		// The tool actually executed against the MCP client...
		expect(received).toEqual({ name: "echo", arguments: { message: "ping" } });
		// ...and the result is mapped into ContentBlocks (provenance + payload),
		// NOT the "not directly executable" placeholder.
		const texts = (result?.content ?? [])
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text);
		expect(texts.some((t) => t.includes("pong"))).toBe(true);
		expect(texts.some((t) => t.includes("not directly executable"))).toBe(false);
	});

	it("falls back to a clear error when no manager is wired", async () => {
		const { handlers } = buildToolSet("/cwd", "host", makeMcpTools());
		const handler = handlers.get("boundless_mcp_proxysrv_echo");
		const result = await handler?.({}, new AbortController().signal, "/cwd");
		expect(result?.isError).toBe(true);
	});
});
