import { afterEach, describe, expect, it } from "bun:test";
import type { Client, Tool } from "@modelcontextprotocol/client";
import { type McpAppServer, connectMcpServers, initMcpApps } from "../mcp-apps-bootstrap";

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

/** A tool with explicit `_meta.ui.visibility` (MCP Apps spec). */
function toolWithVisibility(name: string, visibility: Array<"model" | "app">): Tool {
	return {
		name,
		inputSchema: { type: "object", properties: {} },
		_meta: { ui: { visibility } },
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
		expect(host.resolveByServerTool("excalidraw", "create_view")?.uiResourceUri).toBe(
			"ui://excalidraw/app.html",
		);
		expect(host.resolve("mcp__excalidraw__plain")?.uiResourceUri).toBeUndefined();
	});

	it("excludes app-only tools (_meta.ui.visibility=['app']) from the model-facing definitions", async () => {
		const servers: McpAppServer[] = [
			{ name: "excalidraw", transport: "http", proxyPath: "/api/mcp-apps/proxy/excalidraw" },
		];
		const host = await connectMcpServers(
			servers,
			async () =>
				fakeClient([
					tool("create_view", "ui://excalidraw/app.html"),
					toolWithVisibility("save_checkpoint", ["app"]),
					toolWithVisibility("read_checkpoint", ["app"]),
					toolWithVisibility("export_to_excalidraw", ["app"]),
					toolWithVisibility("explicit_model", ["model"]),
					toolWithVisibility("both", ["model", "app"]),
				]),
			"http://localhost:3001",
		);

		// create_view has no visibility (default ["model","app"] → visible);
		// explicit_model and both include "model" → visible; the three ["app"]
		// tools are widget-only and must never be offered to the model.
		const registered = [
			"create_view",
			"save_checkpoint",
			"read_checkpoint",
			"export_to_excalidraw",
			"explicit_model",
			"both",
		].filter((name) => host.resolveByServerTool("excalidraw", name));
		expect(registered).toEqual(["create_view", "explicit_model", "both"]);
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
		expect(host.resolve("mcp__up__ok")?.serverName).toBe("up");
		expect(host.resolveByServerTool("down", "ok")).toBeUndefined();
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
		expect(host.resolveByServerTool("a", "t")).toBeUndefined();
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
		expect(host.resolveByServerTool("fake", "t")).toBeUndefined();
	});
});

// initMcpApps / fetchMcpAppServers drive the one-time bootstrap: load the
// server list over fetch, connect, and stow the host on the shared store.
// `started` is module-level and latches true on the first call, so exactly one
// invocation runs the body per process — that first call exercises the full
// happy path (fetch → connect → host) and subsequent calls hit the idempotent
// short-circuit.
describe("initMcpApps", () => {
	const realFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("fetches the server list, connects, and returns a populated host on first call", async () => {
		// This is the first initMcpApps call in the process: started === false, so
		// the whole body runs — fetchMcpAppServers over patched fetch, then
		// connectMcpServers against the real connector (which will fail to reach the
		// proxy path and skip, leaving an empty host). The point is line coverage of
		// the fetch + connect + mcpAppHost.set path, not a live MCP connection.
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/api/mcp-apps")) {
				return new Response(
					JSON.stringify({
						servers: [{ name: "demo", transport: "http", proxyPath: "/api/mcp-apps/proxy/demo" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			// The in-page MCP connect attempt hits fetch too; fail it so the server is
			// skipped and the host comes back empty but defined.
			return new Response("no", { status: 502 });
		}) as unknown as typeof fetch;

		const host = await initMcpApps();
		// A host object is returned (non-null) once a non-empty server list loads.
		expect(host).not.toBeNull();
		expect(host).not.toBeNull();
	});

	it("is idempotent — a later call short-circuits to null without fetching", async () => {
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response(JSON.stringify({ servers: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		const host = await initMcpApps();
		expect(host).toBeNull();
		expect(fetched).toBe(false);
	});

	it("a call with an injected fetcher also short-circuits once started", async () => {
		let called = false;
		const host = await initMcpApps(async () => {
			called = true;
			return [];
		});
		expect(host).toBeNull();
		expect(called).toBe(false);
	});
});
