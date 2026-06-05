import { describe, expect, it } from "bun:test";
import type { McpAppsConfig } from "@bound/shared";
import { createMcpAppsRoutes } from "../mcp-apps";

describe("createMcpAppsRoutes", () => {
	it("returns the configured servers", async () => {
		const config: McpAppsConfig = {
			servers: [{ name: "excalidraw", url: "https://mcp.excalidraw.com/mcp", transport: "http" }],
		};
		const app = createMcpAppsRoutes(config);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as McpAppsConfig;
		expect(body.servers).toHaveLength(1);
		expect(body.servers[0]).toMatchObject({
			name: "excalidraw",
			url: "https://mcp.excalidraw.com/mcp",
			transport: "http",
		});
	});

	it("returns an empty server list when config is null (mcp_apps.json absent)", async () => {
		const app = createMcpAppsRoutes(null);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as McpAppsConfig;
		expect(body.servers).toEqual([]);
	});

	it("does not invent servers from an empty config", async () => {
		const app = createMcpAppsRoutes({ servers: [] });
		const res = await app.request("/");
		const body = (await res.json()) as McpAppsConfig;
		expect(body.servers).toEqual([]);
	});
});
