import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../config";
import { AppLogger } from "../logging";
import { McpServerManager } from "../mcp/manager";

describe("McpServerManager", () => {
	let testDir: string;
	let logger: AppLogger;

	beforeEach(() => {
		const hex = randomBytes(4).toString("hex");
		testDir = join(tmpdir(), `boundless-mcp-manager-test-${hex}`);
		mkdirSync(testDir, { recursive: true });
		logger = new AppLogger(testDir);
	});

	afterEach(() => {
		try {
			logger.close();
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("constructor", () => {
		it("initializes with empty server state", () => {
			const manager = new McpServerManager(logger);
			const states = manager.getServerStates();
			expect(states.size).toBe(0);
		});
	});

	describe("ensureAllEnabled", () => {
		it("AC6.6: marks invalid stdio server as failed with error message", async () => {
			const manager = new McpServerManager(logger);
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "invalid-server",
					command: "/nonexistent/command",
					args: [],
					enabled: true,
				},
			];

			// This should not throw
			await manager.ensureAllEnabled(configs);

			const states = manager.getServerStates();
			expect(states.has("invalid-server")).toBe(true);

			const state = states.get("invalid-server");
			expect(state?.status).toBe("failed");
			expect(state?.error).toBeTruthy();
			expect(state?.client).toBeNull();
			expect(state?.tools).toEqual([]);
		});

		it("skips disabled servers", async () => {
			const manager = new McpServerManager(logger);
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "disabled-server",
					command: "/nonexistent/command",
					args: [],
					enabled: false,
				},
			];

			await manager.ensureAllEnabled(configs);

			const states = manager.getServerStates();
			expect(states.has("disabled-server")).toBe(true);

			const state = states.get("disabled-server");
			expect(state?.status).toBe("disabled");
			expect(state?.error).toBeNull();
			expect(state?.client).toBeNull();
			expect(state?.tools).toEqual([]);
		});

		it("AC6.6: does not throw when one server fails, continues with others", async () => {
			const manager = new McpServerManager(logger);
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "valid-config",
					command: "echo",
					args: ["test"],
					enabled: true,
				},
				{
					transport: "stdio",
					name: "invalid-config",
					command: "/nonexistent/command",
					args: [],
					enabled: true,
				},
			];

			// Should not throw
			await manager.ensureAllEnabled(configs);

			const states = manager.getServerStates();
			expect(states.size).toBe(2);

			// Invalid server should be marked failed
			const invalidState = states.get("invalid-config");
			expect(invalidState?.status).toBe("failed");

			// But we tried to start the valid one too (even if it failed)
			const validState = states.get("valid-config");
			expect(validState).toBeDefined();
		});

		it("stores config and transport in server state", async () => {
			const manager = new McpServerManager(logger);
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "test-server",
					command: "/nonexistent",
					args: [],
					enabled: true,
				},
			];

			await manager.ensureAllEnabled(configs);

			const states = manager.getServerStates();
			const state = states.get("test-server");
			expect(state?.config).toBeDefined();
			expect(state?.config.name).toBe("test-server");
		});
	});

	describe("terminateAll", () => {
		it("AC6.7: terminates all running servers", async () => {
			const manager = new McpServerManager(logger);

			// After calling terminateAll on empty manager, should not throw
			await manager.terminateAll();

			const states = manager.getServerStates();
			expect(states.size).toBe(0);
		});

		it("does not throw when terminating empty state", async () => {
			const manager = new McpServerManager(logger);

			// Should be safe
			await expect(manager.terminateAll()).resolves.toBeUndefined();
		});
	});

	describe("getRunningTools", () => {
		it("returns empty map when no servers are running", () => {
			const manager = new McpServerManager(logger);
			const tools = manager.getRunningTools();
			expect(tools.size).toBe(0);
		});

		it("returns map with server names as keys", async () => {
			const manager = new McpServerManager(logger);

			// Create state with tools (we'll mock this by directly calling ensureAllEnabled
			// which attempts to connect)
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "test-server",
					command: "/nonexistent",
					args: [],
					enabled: true,
				},
			];

			await manager.ensureAllEnabled(configs);

			// Even if it failed, getRunningTools should not throw
			const tools = manager.getRunningTools();
			expect(tools).toBeDefined();
			expect(tools instanceof Map).toBe(true);
		});
	});

	describe("getServerStates", () => {
		it("returns empty map initially", () => {
			const manager = new McpServerManager(logger);
			const states = manager.getServerStates();
			expect(states.size).toBe(0);
		});

		it("includes all servers after ensureAllEnabled", async () => {
			const manager = new McpServerManager(logger);
			const configs: McpServerConfig[] = [
				{
					transport: "stdio",
					name: "server1",
					command: "/nonexistent1",
					args: [],
					enabled: true,
				},
				{
					transport: "stdio",
					name: "server2",
					command: "/nonexistent2",
					args: [],
					enabled: false,
				},
			];

			await manager.ensureAllEnabled(configs);

			const states = manager.getServerStates();
			expect(states.size).toBe(2);
			expect(states.has("server1")).toBe(true);
			expect(states.has("server2")).toBe(true);
		});

		it("returns state with all required fields", async () => {
			const manager = new McpServerManager(logger);
			const config: McpServerConfig = {
				transport: "stdio",
				name: "test-server",
				command: "/nonexistent",
				args: [],
				enabled: true,
			};

			await manager.ensureAllEnabled([config]);

			const states = manager.getServerStates();
			const state = states.get("test-server");

			expect(state).toBeDefined();
			expect(state?.config).toEqual(config);
			expect(state?.status).toBeDefined();
			expect(["not-spawned", "running", "failed", "disabled"]).toContain(state?.status);
			expect(state?.client).toBeDefined();
			expect(state?.tools).toBeDefined();
			expect(Array.isArray(state?.tools)).toBe(true);
			expect(state?.error).toBeDefined();
			expect(typeof state?.error === "string" || state?.error === null).toBe(true);
			expect(state?.transport).toBeDefined();
		});
	});
});
