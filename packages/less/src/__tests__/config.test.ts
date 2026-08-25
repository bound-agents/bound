import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Config,
	type McpConfig,
	loadConfig,
	loadMcpConfig,
	saveConfig,
	saveMcpConfig,
} from "../config";

describe("config", async () => {
	let testDir: string;

	beforeEach(async () => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-config-test-${hex}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("loadConfig", async () => {
		it("AC4.1: returns defaults when config.json doesn't exist", async () => {
			const config = await loadConfig(testDir);
			expect(config.url).toBe("http://localhost:3001");
			expect(config.model).toBeNull();
		});

		it("parses valid config.json", async () => {
			const configPath = join(testDir, "config.json");
			writeFileSync(configPath, JSON.stringify({ url: "http://custom:3001", model: "opus" }));
			const config = await loadConfig(testDir);
			expect(config.url).toBe("http://custom:3001");
			expect(config.model).toBe("opus");
		});

		it("throws on invalid JSON", async () => {
			const configPath = join(testDir, "config.json");
			writeFileSync(configPath, "not json");
			await expect(loadConfig(testDir)).rejects.toThrow();
		});
	});

	it("prefers config.js over config.json and preserves JSON as writable overrides", async () => {
		writeFileSync(
			join(testDir, "config.js"),
			'export default { url: "http://js:3001", model: "opus" };',
		);
		writeFileSync(join(testDir, "config.json"), JSON.stringify({ model: "sonnet" }));
		const config = await loadConfig(testDir);
		expect(config.url).toBe("http://js:3001");
		expect(config.model).toBe("sonnet");
	});

	it("saves boundless config updates to config.json without rewriting config.js", async () => {
		const configJsPath = join(testDir, "config.js");
		writeFileSync(configJsPath, 'export default { url: "http://js:3001", model: "opus" };');
		saveConfig(testDir, { url: "http://override:3001", model: "sonnet" });
		expect(require("node:fs").readFileSync(configJsPath, "utf-8")).toContain("http://js:3001");
		const config = await loadConfig(testDir);
		expect(config.url).toBe("http://override:3001");
		expect(config.model).toBe("sonnet");
	});

	describe("saveConfig", async () => {
		it("AC4.3: preserves unknown fields on save", async () => {
			// First create a config with an unknown field
			const configPath = join(testDir, "config.json");
			writeFileSync(
				configPath,
				JSON.stringify({
					url: "http://localhost:3001",
					model: null,
					futureField: 42,
				}),
			);

			// Load and verify the future field is preserved in _raw
			const loaded = await loadConfig(testDir);
			expect((loaded._raw as Record<string, unknown>).futureField).toBe(42);

			// Save with new values
			const updated: Config = { url: "http://new:3001", model: "sonnet" };
			saveConfig(testDir, updated);

			// Reload and verify both new and unknown fields are present
			const reloaded = await loadConfig(testDir);
			expect(reloaded.url).toBe("http://new:3001");
			expect(reloaded.model).toBe("sonnet");
			expect((reloaded._raw as Record<string, unknown>).futureField).toBe(42);
		});

		it("creates config.json if it doesn't exist", async () => {
			const config: Config = { url: "http://test:3001", model: "haiku" };
			saveConfig(testDir, config);

			const reloaded = await loadConfig(testDir);
			expect(reloaded.url).toBe("http://test:3001");
			expect(reloaded.model).toBe("haiku");
		});
	});

	describe("loadMcpConfig", async () => {
		it("AC4.2: returns empty servers array when mcp.json doesn't exist", async () => {
			const config = await loadMcpConfig(testDir);
			expect(config.servers).toEqual([]);
		});

		it("parses valid mcp.json", async () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(
				mcpPath,
				JSON.stringify({
					servers: [
						{
							transport: "stdio",
							name: "github",
							command: "npx",
							args: ["@modelcontextprotocol/server-github"],
						},
					],
				}),
			);
			const config = await loadMcpConfig(testDir);
			expect(config.servers).toHaveLength(1);
			expect(config.servers[0].name).toBe("github");
		});

		it("AC4.9: throws on duplicate server names", async () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(
				mcpPath,
				JSON.stringify({
					servers: [
						{
							transport: "stdio",
							name: "github",
							command: "cmd1",
							args: [],
						},
						{
							transport: "http",
							name: "github",
							url: "http://localhost:8000",
						},
					],
				}),
			);
			await expect(loadMcpConfig(testDir)).rejects.toThrow(
				/Duplicate MCP server name: 'github' appears 2 times/,
			);
		});

		it("throws on invalid JSON", async () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(mcpPath, "not json");
			await expect(loadMcpConfig(testDir)).rejects.toThrow();
		});
	});

	it("prefers mcp.js over mcp.json while allowing JSON server overrides", async () => {
		writeFileSync(
			join(testDir, "mcp.js"),
			'export default { servers: [{ transport: "stdio", name: "js", command: "js-cmd" }] };',
		);
		writeFileSync(
			join(testDir, "mcp.json"),
			JSON.stringify({ servers: [{ transport: "stdio", name: "json", command: "json-cmd" }] }),
		);
		const config = await loadMcpConfig(testDir);
		expect(config.servers.map((server) => server.name)).toEqual(["json"]);
	});

	it("saves boundless MCP updates to mcp.json without rewriting mcp.js", async () => {
		const mcpJsPath = join(testDir, "mcp.js");
		writeFileSync(mcpJsPath, "export default { servers: [] };");
		saveMcpConfig(testDir, {
			servers: [{ transport: "stdio", name: "override", command: "override-cmd" }],
		});
		expect(require("node:fs").readFileSync(mcpJsPath, "utf-8")).toContain("export default");
		expect((await loadMcpConfig(testDir)).servers.map((server) => server.name)).toEqual([
			"override",
		]);
	});

	describe("saveMcpConfig", async () => {
		it("creates mcp.json if it doesn't exist", async () => {
			const config: McpConfig = {
				servers: [
					{
						transport: "stdio",
						name: "test",
						command: "test-cmd",
						args: [],
					},
				],
			};
			saveMcpConfig(testDir, config);

			const reloaded = await loadMcpConfig(testDir);
			expect(reloaded.servers).toHaveLength(1);
			expect(reloaded.servers[0].name).toBe("test");
		});

		it("preserves unknown fields in mcp.json on save", async () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(
				mcpPath,
				JSON.stringify({
					servers: [],
					futureField: "preserved",
				}),
			);

			const loaded = await loadMcpConfig(testDir);
			expect((loaded._raw as Record<string, unknown>).futureField).toBe("preserved");

			const updated: McpConfig = {
				servers: [
					{
						transport: "http",
						name: "test",
						url: "http://localhost:8000",
					},
				],
			};
			saveMcpConfig(testDir, updated);

			const reloaded = await loadMcpConfig(testDir);
			expect(reloaded.servers).toHaveLength(1);
			expect((reloaded._raw as Record<string, unknown>).futureField).toBe("preserved");
		});
	});
});
