import { describe, expect, it } from "bun:test";
import type { McpAppsConfig } from "@bound/shared";
import { createMcpAppsRoutes } from "../mcp-apps";

describe("createMcpAppsRoutes GET /", () => {
	it("returns the configured servers as same-origin proxy paths (no real url, no headers)", async () => {
		const config: McpAppsConfig = {
			servers: [
				{
					name: "excalidraw",
					url: "https://mcp.excalidraw.com/mcp",
					transport: "http",
					headers: { Authorization: "Bearer secret" },
				},
			],
		};
		const app = createMcpAppsRoutes(config);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			servers: Array<Record<string, unknown>>;
		};
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0]).toEqual({
			name: "excalidraw",
			transport: "http",
			proxyPath: "/api/mcp-apps/proxy/excalidraw",
		});
		// The real upstream URL and auth headers must never reach the browser.
		expect(body.servers[0].url).toBeUndefined();
		expect(body.servers[0].headers).toBeUndefined();
	});

	it("percent-encodes server names with unsafe path characters", async () => {
		const app = createMcpAppsRoutes({
			servers: [{ name: "my server/v2", url: "https://example.com/mcp", transport: "http" }],
		});
		const body = (await (await app.request("/")).json()) as {
			servers: Array<{ proxyPath: string }>;
		};
		expect(body.servers[0].proxyPath).toBe("/api/mcp-apps/proxy/my%20server%2Fv2");
	});

	it("returns an empty server list when config is null (mcp_apps.json absent)", async () => {
		const app = createMcpAppsRoutes(null);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { servers: unknown[] };
		expect(body.servers).toEqual([]);
	});

	it("does not invent servers from an empty config", async () => {
		const app = createMcpAppsRoutes({ servers: [] });
		const body = (await (await app.request("/")).json()) as { servers: unknown[] };
		expect(body.servers).toEqual([]);
	});
});

describe("createMcpAppsRoutes ALL /proxy/:name", () => {
	const config: McpAppsConfig = {
		servers: [
			{
				name: "excalidraw",
				url: "https://mcp.excalidraw.com/mcp",
				transport: "http",
				headers: { Authorization: "Bearer secret-token" },
			},
		],
	};

	it("forwards the request to the real upstream URL and injects configured headers", async () => {
		let seen: { url: string; method: string; auth: string | null; body: string } | undefined;
		const app = createMcpAppsRoutes(config, async (url, init) => {
			seen = {
				url: String(url),
				method: init?.method ?? "GET",
				auth: new Headers(init?.headers).get("authorization"),
				body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : "",
			};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
				status: 200,
				headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
			});
		});

		const res = await app.request("/proxy/excalidraw", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		expect(seen?.url).toBe("https://mcp.excalidraw.com/mcp");
		expect(seen?.method).toBe("POST");
		// Auth header is injected server-side, not supplied by the browser.
		expect(seen?.auth).toBe("Bearer secret-token");
		expect(seen?.body).toContain("initialize");
		// Response passes through, including the session id the SDK needs to capture.
		expect(res.status).toBe(200);
		expect(res.headers.get("mcp-session-id")).toBe("sess-1");
	});

	it("strips upstream CORS and hop-by-hop response headers", async () => {
		const app = createMcpAppsRoutes(config, async () => {
			return new Response("ok", {
				status: 200,
				headers: {
					"content-type": "text/plain",
					"access-control-allow-origin": "*",
					"content-encoding": "gzip",
				},
			});
		});
		const res = await app.request("/proxy/excalidraw", { method: "POST" });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("content-type")).toBe("text/plain");
	});

	it("404s an unknown server name", async () => {
		const app = createMcpAppsRoutes(config);
		const res = await app.request("/proxy/nope", { method: "POST" });
		expect(res.status).toBe(404);
	});

	it("502s when the upstream fetch throws", async () => {
		const app = createMcpAppsRoutes(config, async () => {
			throw new Error("ECONNREFUSED");
		});
		const res = await app.request("/proxy/excalidraw", { method: "POST" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("ECONNREFUSED");
	});
});
