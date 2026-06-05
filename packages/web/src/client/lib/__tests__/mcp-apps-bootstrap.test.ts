import { describe, expect, it } from "bun:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type McpAppServer, connectMcpServers } from "../mcp-apps-bootstrap";

function fakeClient(tools: Tool[]): Client {
	return {
		listTools: async () => ({ tools }),
		callTool: async () => ({ content: [] }),
		getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
	} as unknown as Client;
}

function tool(name: string, uiResourceUri?: string): Tool {
	return {
		name,
		inputSchema: { type: "object", properties: {} },
		...(uiResourceUri
			? { _meta: { "ui.resourceUri": uiResourceUri, ui: { resourceUri: uiResourceUri } } }
			: {}),
	} as unknown as Tool;
}

describe("connectMcpServers", () => {
	it("connects to each server and registers its tools", async () => {
		const servers: McpAppServer[] = [
			{ name: "excalidraw", url: "https://mcp.excalidraw.com/mcp", transport: "http" },
		];
		const calls: { url: string; headers?: Record<string, string> }[] = [];
		const host = await connectMcpServers(servers, async (url, headers) => {
			calls.push({ url: url.href, headers });
			return fakeClient([tool("create_view", "ui://excalidraw/app.html"), tool("plain")]);
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://mcp.excalidraw.com/mcp");
		const names = host.getToolDefinitions().map((d) => d.function.name);
		expect(names).toEqual(["mcp__excalidraw__create_view", "mcp__excalidraw__plain"]);
		expect(host.isUiBearing("mcp__excalidraw__create_view")).toBe(true);
		expect(host.isUiBearing("mcp__excalidraw__plain")).toBe(false);
	});

	it("forwards configured headers to the connector", async () => {
		const servers: McpAppServer[] = [
			{
				name: "authed",
				url: "https://mcp.example.com/mcp",
				transport: "http",
				headers: { Authorization: "Bearer xyz" },
			},
		];
		let seenHeaders: Record<string, string> | undefined;
		await connectMcpServers(servers, async (_url, headers) => {
			seenHeaders = headers;
			return fakeClient([tool("t")]);
		});
		expect(seenHeaders).toEqual({ Authorization: "Bearer xyz" });
	});

	it("skips a server that fails to connect and still registers the others", async () => {
		const servers: McpAppServer[] = [
			{ name: "down", url: "https://down.example.com/mcp", transport: "http" },
			{ name: "up", url: "https://up.example.com/mcp", transport: "http" },
		];
		const host = await connectMcpServers(servers, async (url) => {
			if (url.href.includes("down")) throw new Error("ECONNREFUSED");
			return fakeClient([tool("ok")]);
		});
		const names = host.getToolDefinitions().map((d) => d.function.name);
		expect(names).toEqual(["mcp__up__ok"]);
	});

	it("returns an empty host when every server fails", async () => {
		const servers: McpAppServer[] = [
			{ name: "a", url: "https://a.example.com/mcp", transport: "http" },
		];
		const host = await connectMcpServers(servers, async () => {
			throw new Error("nope");
		});
		expect(host.getToolDefinitions()).toEqual([]);
	});

	it("returns an empty host for an empty server list without connecting", async () => {
		let connectCalls = 0;
		const host = await connectMcpServers([], async () => {
			connectCalls++;
			return fakeClient([]);
		});
		expect(connectCalls).toBe(0);
		expect(host.getToolDefinitions()).toEqual([]);
	});
});
