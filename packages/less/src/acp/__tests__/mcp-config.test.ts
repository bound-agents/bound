import { describe, expect, it } from "bun:test";
import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "../../config";
import { acpMcpServersToConfigs, mergeMcpConfigs } from "../mcp-config";

describe("acpMcpServersToConfigs", () => {
	it("maps an ACP stdio server to a boundless stdio config", () => {
		const servers: McpServer[] = [
			{
				name: "github",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: [{ name: "GITHUB_TOKEN", value: "ghp_xxx" }],
			} as McpServer,
		];
		const { configs, warnings } = acpMcpServersToConfigs(servers);
		expect(warnings).toEqual([]);
		expect(configs).toEqual([
			{
				transport: "stdio",
				name: "github",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: { GITHUB_TOKEN: "ghp_xxx" },
				enabled: true,
			},
		]);
	});

	it('treats an explicit type:"stdio" the same as the bare stdio variant', () => {
		const servers = [
			{ type: "stdio", name: "local", command: "./srv", args: [], env: [] },
		] as unknown as McpServer[];
		const { configs } = acpMcpServersToConfigs(servers);
		expect(configs[0]).toMatchObject({ transport: "stdio", name: "local", command: "./srv" });
	});

	it("omits env when the ACP server passes none", () => {
		const servers = [
			{ name: "noenv", command: "run", args: [], env: [] },
		] as unknown as McpServer[];
		const { configs } = acpMcpServersToConfigs(servers);
		expect(configs[0]).toEqual({
			transport: "stdio",
			name: "noenv",
			command: "run",
			args: [],
			enabled: true,
		});
		expect("env" in configs[0]).toBe(false);
	});

	it("maps an ACP http server to a boundless http config", () => {
		const servers = [
			{ type: "http", name: "remote", url: "https://mcp.example.com", headers: [] },
		] as unknown as McpServer[];
		const { configs, warnings } = acpMcpServersToConfigs(servers);
		expect(warnings).toEqual([]);
		expect(configs[0]).toEqual({
			transport: "http",
			name: "remote",
			url: "https://mcp.example.com",
			enabled: true,
		});
	});

	it("folds http headers into a record and passes them through", () => {
		const servers = [
			{
				type: "http",
				name: "authed",
				url: "https://mcp.example.com",
				headers: [
					{ name: "Authorization", value: "Bearer x" },
					{ name: "X-Tenant", value: "acme" },
				],
			},
		] as unknown as McpServer[];
		const { configs, warnings } = acpMcpServersToConfigs(servers);
		expect(configs[0]).toMatchObject({
			transport: "http",
			name: "authed",
			url: "https://mcp.example.com",
			headers: { Authorization: "Bearer x", "X-Tenant": "acme" },
		});
		expect(warnings).toHaveLength(0);
	});

	it("omits the headers field when the http server passes none", () => {
		const servers = [
			{ type: "http", name: "bare", url: "https://mcp.example.com", headers: [] },
		] as unknown as McpServer[];
		const { configs } = acpMcpServersToConfigs(servers);
		expect(configs[0]).toMatchObject({ transport: "http", name: "bare" });
		expect(configs[0]).not.toHaveProperty("headers");
	});

	it("skips sse and acp transports with warnings", () => {
		const servers = [
			{ type: "sse", name: "streamed", url: "https://sse.example.com", headers: [] },
			{ type: "acp", name: "nested", id: "abc" },
		] as unknown as McpServer[];
		const { configs, warnings } = acpMcpServersToConfigs(servers);
		expect(configs).toEqual([]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toMatchObject({ name: "streamed", mapped: false });
		expect(warnings[1]).toMatchObject({ name: "nested", mapped: false });
	});
});

describe("mergeMcpConfigs", () => {
	const stdio = (name: string): McpServerConfig => ({
		transport: "stdio",
		name,
		command: "x",
		args: [],
		enabled: true,
	});

	it("appends extra configs that don't collide with base", () => {
		const { merged, collisions } = mergeMcpConfigs([stdio("a")], [stdio("b")]);
		expect(merged.map((c) => c.name)).toEqual(["a", "b"]);
		expect(collisions).toEqual([]);
	});

	it("keeps the base config on a name collision and reports it", () => {
		const base = stdio("github");
		const extra: McpServerConfig = { ...stdio("github"), command: "different" };
		const { merged, collisions } = mergeMcpConfigs([base], [extra]);
		expect(merged).toHaveLength(1);
		expect(merged[0].command).toBe("x"); // base wins
		expect(collisions).toEqual(["github"]);
	});
});
