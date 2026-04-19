/**
 * MCP Server lifecycle manager.
 * Manages per-server state (spawn, connect, disconnect, enumerate).
 * Implements AC6.1, AC6.2, AC6.6, AC6.7.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config";
import type { AppLogger } from "../logging";

export interface McpServerState {
	config: McpServerConfig;
	status: "not-spawned" | "running" | "failed" | "disabled";
	client: Client | null;
	tools: Tool[];
	error: string | null;
	transport: StdioClientTransport | StreamableHTTPClientTransport | null;
}

// Type guard for checking transport type
function isStdioTransport(
	transport: StdioClientTransport | StreamableHTTPClientTransport | null,
): transport is StdioClientTransport {
	return transport instanceof StdioClientTransport;
}

/**
 * Check if two server configs are functionally equal.
 * Returns true if all relevant fields match (name, transport, command/url, args/env, enabled).
 */
function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
	// Check basic fields
	if (a.name !== b.name || a.transport !== b.transport || a.enabled !== b.enabled) {
		return false;
	}

	// Check transport-specific fields
	if (a.transport === "stdio" && b.transport === "stdio") {
		// TypeScript discriminated union narrowing — a and b are now StdioConfig type
		if (a.command !== b.command) {
			return false;
		}

		const aArgs = a.args || [];
		const bArgs = b.args || [];
		if (JSON.stringify(aArgs) !== JSON.stringify(bArgs)) {
			return false;
		}

		const aEnv = a.env || {};
		const bEnv = b.env || {};
		if (JSON.stringify(aEnv) !== JSON.stringify(bEnv)) {
			return false;
		}
	} else if (a.transport === "http" && b.transport === "http") {
		// TypeScript discriminated union narrowing — a and b are now HttpConfig type
		if (a.url !== b.url) {
			return false;
		}
	}

	return true;
}

export interface ReloadResult {
	added: string[];
	removed: string[];
	changed: string[];
	failed: string[];
}

export class McpServerManager {
	private logger: AppLogger;
	private servers: Map<string, McpServerState> = new Map();

	constructor(logger: AppLogger) {
		this.logger = logger;
	}

	/**
	 * Ensures all enabled servers are spawned/connected and tools are enumerated.
	 * Non-fatal: failures are marked on the server state but don't throw.
	 * AC6.1: Stdio MCP server spawns, handshakes, enumerates tools
	 * AC6.2: HTTP/SSE MCP server connects and enumerates tools
	 * AC6.6: Failure is non-fatal — server marked failed, tools omitted, others unaffected
	 */
	async ensureAllEnabled(configs: McpServerConfig[]): Promise<void> {
		for (const config of configs) {
			if (!config.enabled) {
				// Skip disabled servers, but record them in state
				if (!this.servers.has(config.name)) {
					this.servers.set(config.name, {
						config,
						status: "disabled",
						client: null,
						tools: [],
						error: null,
						transport: null,
					});
				}
			} else {
				// Try to spawn/connect this server
				try {
					await this.connectServer(config);
				} catch (error) {
					// AC6.6: Non-fatal error handling
					const errorMessage = error instanceof Error ? error.message : String(error);
					this.logger.error("mcp_server_failed", {
						serverName: config.name,
						error: errorMessage,
					});

					this.servers.set(config.name, {
						config,
						status: "failed",
						client: null,
						tools: [],
						error: errorMessage,
						transport: null,
					});
				}
			}
		}
	}

	/**
	 * Connect to a single MCP server and enumerate its tools.
	 */
	private async connectServer(config: McpServerConfig): Promise<void> {
		const client = new Client({
			name: "boundless",
			version: "0.0.1",
		});

		let transport: StdioClientTransport | StreamableHTTPClientTransport;

		try {
			if (config.transport === "stdio") {
				// TypeScript discriminated union narrowing — config is now StdioConfig type
				transport = new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: config.env,
				});
			} else if (config.transport === "http") {
				// TypeScript discriminated union narrowing — config is now HttpConfig type
				transport = new StreamableHTTPClientTransport(new URL(config.url));
			} else {
				// Exhaustiveness check — config is never type if a new transport is added
				throw new Error(`Unknown transport type: ${(config as { transport: string }).transport}`);
			}

			// Connect client to transport
			await client.connect(transport);

			// Enumerate tools
			const toolsResult = await client.listTools();
			const tools = toolsResult.tools || [];

			// Success
			this.servers.set(config.name, {
				config,
				status: "running",
				client,
				tools,
				error: null,
				transport,
			});

			this.logger.info("mcp_server_connected", {
				serverName: config.name,
				transport: config.transport,
				toolCount: tools.length,
			});
		} catch (error) {
			// Cleanup on failure
			try {
				await client.close();
			} catch {
				// Ignore close errors
			}

			const errorMessage = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to connect to MCP server ${config.name}: ${errorMessage}`);
		}
	}

	/**
	 * Terminates all running servers.
	 * AC6.7: sends SIGTERM then SIGKILL after 2s to stdio subprocesses
	 */
	async terminateAll(): Promise<void> {
		const promises: Promise<void>[] = [];

		for (const [serverName, state] of this.servers.entries()) {
			if (state.status === "running" && state.client) {
				promises.push(this.terminateServer(serverName, state));
			}
		}

		await Promise.all(promises);
	}

	/**
	 * Terminate a single server.
	 */
	private async terminateServer(serverName: string, state: McpServerState): Promise<void> {
		try {
			// Close the client (sends SIGTERM for stdio)
			await state.client?.close();

			// For stdio transports, check if process still alive after 2s and send SIGKILL
			if (isStdioTransport(state.transport)) {
				// Note: Accessing StdioClientTransport.process is an internal SDK detail.
				// This implementation verified against @modelcontextprotocol/sdk v1.0+.
				// If the SDK changes this field location, this will need updating.
				const processField = state.transport as {
					process?: {
						pid?: number;
						killed?: boolean;
						kill(signal: string): void;
					};
				};
				const process = processField.process;
				// Wait 2s for graceful shutdown
				await new Promise((resolve) => setTimeout(resolve, 2000));

				// Check if still alive and send SIGKILL
				if (process?.pid && !process.killed) {
					try {
						process.kill("SIGKILL");
					} catch {
						// Process might already be dead
					}
				}
			}

			this.logger.info("mcp_server_terminated", { serverName });
		} catch (error) {
			this.logger.warn("mcp_server_terminate_error", {
				serverName,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			// Update state
			const currentState = this.servers.get(serverName);
			if (currentState) {
				currentState.status = "not-spawned";
				currentState.client = null;
				currentState.tools = [];
				currentState.transport = null;
			}
		}
	}

	/**
	 * Get tools from all running servers.
	 * Returns map of serverName -> Tool[]
	 */
	getRunningTools(): Map<string, Tool[]> {
		const result = new Map<string, Tool[]>();

		for (const [serverName, state] of this.servers.entries()) {
			if (state.status === "running") {
				result.set(serverName, state.tools);
			}
		}

		return result;
	}

	/**
	 * Get full state for all servers (for TUI display).
	 * Returns map of serverName -> McpServerState
	 */
	getServerStates(): Map<string, McpServerState> {
		return new Map(this.servers);
	}

	/**
	 * Get the client for a specific server.
	 * Returns null if server is not running.
	 */
	getClient(serverName: string): Client | null {
		const state = this.servers.get(serverName);
		if (state?.status === "running") {
			return state.client;
		}
		return null;
	}

	/**
	 * Attempt to connect a server config or mark it as failed.
	 * Helper method to reduce duplication in reload() logic.
	 */
	private async tryConnectOrFail(config: McpServerConfig, result: ReloadResult): Promise<void> {
		try {
			await this.connectServer(config);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error("mcp_server_failed", {
				serverName: config.name,
				error: errorMessage,
			});

			this.servers.set(config.name, {
				config,
				status: "failed",
				client: null,
				tools: [],
				error: errorMessage,
				transport: null,
			});

			result.failed.push(config.name);
		}
	}

	/**
	 * Hot-reload: update server configurations and reconcile state.
	 * AC6.8: Diffs old vs new configs by name.
	 * - Added: new server name not in current state → spawn/connect
	 * - Removed: current server not in new configs → terminate
	 * - Changed: config differs (command, url, enabled, etc.) → terminate old, spawn new
	 * - Unchanged: skip
	 * Returns { added, removed, changed, failed } for TUI display.
	 */
	async reload(newConfigs: McpServerConfig[]): Promise<ReloadResult> {
		const result: ReloadResult = {
			added: [],
			removed: [],
			changed: [],
			failed: [],
		};

		// Build map of new configs by name
		const newConfigsByName = new Map<string, McpServerConfig>();
		for (const config of newConfigs) {
			newConfigsByName.set(config.name, config);
		}

		// Handle removed and changed servers
		const currentNames = Array.from(this.servers.keys());
		for (const currentName of currentNames) {
			const currentState = this.servers.get(currentName);
			if (!currentState) continue;

			const newConfig = newConfigsByName.get(currentName);

			if (!newConfig) {
				// Server removed
				result.removed.push(currentName);
				await this.terminateServer(currentName, currentState);
				this.servers.delete(currentName);
			} else if (!configsEqual(currentState.config, newConfig)) {
				// Server config changed
				result.changed.push(currentName);
				await this.terminateServer(currentName, currentState);
				this.servers.delete(currentName);

				// Try to spawn the new config if enabled
				if (newConfig.enabled) {
					await this.tryConnectOrFail(newConfig, result);
				} else {
					// Add disabled server
					this.servers.set(newConfig.name, {
						config: newConfig,
						status: "disabled",
						client: null,
						tools: [],
						error: null,
						transport: null,
					});
				}
			}
		}

		// Handle added and newly enabled servers
		for (const newConfig of newConfigs) {
			if (!this.servers.has(newConfig.name)) {
				// Server added
				result.added.push(newConfig.name);

				if (newConfig.enabled) {
					await this.tryConnectOrFail(newConfig, result);
				} else {
					// Add disabled server
					this.servers.set(newConfig.name, {
						config: newConfig,
						status: "disabled",
						client: null,
						tools: [],
						error: null,
						transport: null,
					});
				}
			} else {
				// Server already exists but unchanged. Check if it was disabled and now enabled.
				const currentState = this.servers.get(newConfig.name);
				if (currentState && currentState.status === "disabled" && newConfig.enabled) {
					// Re-enable the server
					this.servers.delete(newConfig.name);

					await this.tryConnectOrFail(newConfig, result);
				}
			}
		}

		return result;
	}
}
