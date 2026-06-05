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
	it("connects to each server's same-origin proxy path and registers its tools", async () => {
		const servers: McpAppServer[] = [
			{ name: "excalidraw", transport: "http", proxyPath: "/api/mcp-apps/proxy/excalidraw" },
		];
		const calls: { url: string }[] = [];
		const host = await connectMcpServers(
			servers,
			async (url) => {
				calls.push({ url: url.href });
				return fakeClient([tool("create_view", "ui://excalidraw/app.html"), tool("plain")]);
			},
			"http://localhost:3001",
		);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("http://localhost:3001/api/mcp-apps/proxy/excalidraw");
		const names = host.getToolDefinitions().map((d) => d.function.name);
		expect(names).toEqual(["mcp__excalidraw__create_view", "mcp__excalidraw__plain"]);
		expect(host.isUiBearing("mcp__excalidraw__create_view")).toBe(true);
		expect(host.isUiBearing("mcp__excalidraw__plain")).toBe(false);
	});

	it("does not pass auth headers from the browser (they are injected by the proxy)", async () => {
		const servers: McpAppServer[] = [
			{ name: "authed", transport: "http", proxyPath: "/api/mcp-apps/proxy/authed" },
		];
		let seenHeaders: Record<string, string> | undefined = { sentinel: "unset" };
		await connectMcpServers(
			servers,
			async (_url, headers) => {
				seenHeaders = headers;
				return fakeClient([tool("t")]);
			},
			"http://localhost:3001",
		);
		expect(seenHeaders).toBeUndefined();
	});

	it("skips a server that fails to connect and still registers the others", async () => {
		const servers: McpAppServer[] = [
			{ name: "down", transport: "http", proxyPath: "/api/mcp-apps/proxy/down" },
			{ name: "up", transport: "http", proxyPath: "/api/mcp-apps/proxy/up" },
		];
		const host = await connectMcpServers(
			servers,
			async (url) => {
				if (url.href.includes("down")) throw new Error("ECONNREFUSED");
				return fakeClient([tool("ok")]);
			},
			"http://localhost:3001",
		);
		const names = host.getToolDefinitions().map((d) => d.function.name);
		expect(names).toEqual(["mcp__up__ok"]);
	});

	it("returns an empty host when every server fails", async () => {
		const servers: McpAppServer[] = [
			{ name: "a", transport: "http", proxyPath: "/api/mcp-apps/proxy/a" },
		];
		const host = await connectMcpServers(
			servers,
			async () => {
				throw new Error("nope");
			},
			"http://localhost:3001",
		);
		expect(host.getToolDefinitions()).toEqual([]);
	});

	it("returns an empty host for an empty server list without connecting", async () => {
		let connectCalls = 0;
		const host = await connectMcpServers(
			[],
			async () => {
				connectCalls++;
				return fakeClient([]);
			},
			"http://localhost:3001",
		);
		expect(connectCalls).toBe(0);
		expect(host.getToolDefinitions()).toEqual([]);
	});
});
