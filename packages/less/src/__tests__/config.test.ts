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

describe("config", () => {
	let testDir: string;

	beforeEach(() => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-config-test-${hex}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("loadConfig", () => {
		it("AC4.1: returns defaults when config.json doesn't exist", () => {
			const config = loadConfig(testDir);
			expect(config.url).toBe("http://localhost:3001");
			expect(config.model).toBeNull();
		});

		it("parses valid config.json", () => {
			const configPath = join(testDir, "config.json");
			writeFileSync(configPath, JSON.stringify({ url: "http://custom:3001", model: "opus" }));
			const config = loadConfig(testDir);
			expect(config.url).toBe("http://custom:3001");
			expect(config.model).toBe("opus");
		});

		it("throws on invalid JSON", () => {
			const configPath = join(testDir, "config.json");
			writeFileSync(configPath, "not json");
			expect(() => loadConfig(testDir)).toThrow();
		});
	});

	describe("saveConfig", () => {
		it("AC4.3: preserves unknown fields on save", () => {
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
			const loaded = loadConfig(testDir);
			expect((loaded._raw as Record<string, unknown>).futureField).toBe(42);

			// Save with new values
			const updated: Config = { url: "http://new:3001", model: "sonnet" };
			saveConfig(testDir, updated);

			// Reload and verify both new and unknown fields are present
			const reloaded = loadConfig(testDir);
			expect(reloaded.url).toBe("http://new:3001");
			expect(reloaded.model).toBe("sonnet");
			expect((reloaded._raw as Record<string, unknown>).futureField).toBe(42);
		});

		it("creates config.json if it doesn't exist", () => {
			const config: Config = { url: "http://test:3001", model: "haiku" };
			saveConfig(testDir, config);

			const reloaded = loadConfig(testDir);
			expect(reloaded.url).toBe("http://test:3001");
			expect(reloaded.model).toBe("haiku");
		});
	});

	describe("loadMcpConfig", () => {
		it("AC4.2: returns empty servers array when mcp.json doesn't exist", () => {
			const config = loadMcpConfig(testDir);
			expect(config.servers).toEqual([]);
		});

		it("parses valid mcp.json", () => {
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
			const config = loadMcpConfig(testDir);
			expect(config.servers).toHaveLength(1);
			expect(config.servers[0].name).toBe("github");
		});

		it("AC4.9: throws on duplicate server names", () => {
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
			expect(() => loadMcpConfig(testDir)).toThrow(
				/Duplicate MCP server name: 'github' appears 2 times/,
			);
		});

		it("throws on invalid JSON", () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(mcpPath, "not json");
			expect(() => loadMcpConfig(testDir)).toThrow();
		});
	});

	describe("saveMcpConfig", () => {
		it("creates mcp.json if it doesn't exist", () => {
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

			const reloaded = loadMcpConfig(testDir);
			expect(reloaded.servers).toHaveLength(1);
			expect(reloaded.servers[0].name).toBe("test");
		});

		it("preserves unknown fields in mcp.json on save", () => {
			const mcpPath = join(testDir, "mcp.json");
			writeFileSync(
				mcpPath,
				JSON.stringify({
					servers: [],
					futureField: "preserved",
				}),
			);

			const loaded = loadMcpConfig(testDir);
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

			const reloaded = loadMcpConfig(testDir);
			expect(reloaded.servers).toHaveLength(1);
			expect((reloaded._raw as Record<string, unknown>).futureField).toBe("preserved");
		});
	});
});
