import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
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

function isStdioTransport(
	transport: StdioClientTransport | StreamableHTTPClientTransport | null,
): transport is StdioClientTransport {
	return transport instanceof StdioClientTransport;
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function configsEqual(a: McpServerConfig, b: McpServerConfig): boolean {
	if (a.name !== b.name || a.transport !== b.transport || a.enabled !== b.enabled) return false;
	if (!sameJson(a.allowTools ?? null, b.allowTools ?? null)) return false;
	if (!sameJson(a.confirm ?? [], b.confirm ?? [])) return false;
	if (a.transport === "stdio" && b.transport === "stdio") {
		return (
			a.command === b.command &&
			sameJson(a.args ?? [], b.args ?? []) &&
			sameJson(a.env ?? {}, b.env ?? {})
		);
	}
	if (a.transport === "http" && b.transport === "http") {
		return a.url === b.url && sameJson(a.headers ?? {}, b.headers ?? {});
	}
	return true;
}

function disabledState(config: McpServerConfig): McpServerState {
	return { config, status: "disabled", client: null, tools: [], error: null, transport: null };
}

/**
 * Upper bound on an MCP server's `initialize` handshake and its first
 * `tools/list`. Without it the SDK's 60s default applies, so a server that
 * spawns but never answers stalls startup for a minute per server, and a
 * server that exits early is only failed once its `close` event is delivered
 * — late on a starved event loop. A timeout turns either into a fast,
 * non-fatal `failed` server.
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;

export interface McpServerManagerOptions {
	/** Per-request timeout for the connect handshake and tool listing. */
	connectTimeoutMs?: number;
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
	private readonly connectTimeoutMs: number;

	constructor(logger: AppLogger, options: McpServerManagerOptions = {}) {
		this.logger = logger;
		this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;
	}

	/**
	 * Ensures all enabled servers are connected and their tools enumerated.
	 * Failures are non-fatal: the server is marked failed and others proceed.
	 */
	async ensureAllEnabled(configs: McpServerConfig[]): Promise<void> {
		for (const config of configs) {
			if (config.enabled) {
				await this.tryConnectOrFail(config);
			} else if (!this.servers.has(config.name)) {
				this.servers.set(config.name, disabledState(config));
			}
		}
	}

	private async connectServer(config: McpServerConfig): Promise<void> {
		const client = new Client({
			name: "boundless",
			version: "0.0.1",
		});

		let transport: StdioClientTransport | StreamableHTTPClientTransport;

		try {
			if (config.transport === "stdio") {
				transport = new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: config.env,
				});
			} else if (config.transport === "http") {
				transport = new StreamableHTTPClientTransport(
					new URL(config.url),
					config.headers ? { requestInit: { headers: config.headers } } : undefined,
				);
			} else {
				throw new Error(`Unknown transport type: ${(config as { transport: string }).transport}`);
			}

			// Both calls are bounded: see DEFAULT_MCP_CONNECT_TIMEOUT_MS.
			const requestOptions = { timeout: this.connectTimeoutMs };
			await client.connect(transport, requestOptions);

			const toolsResult = await client.listTools(undefined, requestOptions);
			const tools = toolsResult.tools || [];

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
	 * Terminates all running servers; stdio subprocesses get SIGTERM, then SIGKILL after 2s.
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

	private async terminateServer(serverName: string, state: McpServerState): Promise<void> {
		try {
			// Closing a stdio client sends SIGTERM; SIGKILL follows after a 2s grace.
			await state.client?.close();

			if (isStdioTransport(state.transport)) {
				// Note: Accessing StdioClientTransport.process is an internal SDK detail.
				// This implementation verified against @modelcontextprotocol/client (SDK v2).
				// If the SDK changes this field location, this will need updating.
				const processField = state.transport as {
					process?: {
						pid?: number;
						killed?: boolean;
						exitCode?: number | null;
						signalCode?: string | null;
						kill(signal: string): void;
					};
				};
				const process = processField.process;
				const hasExited = () =>
					process?.exitCode != null || process?.signalCode != null || process?.killed === true;
				if (process?.pid && !hasExited()) {
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
				if (process?.pid && !hasExited()) {
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
			const currentState = this.servers.get(serverName);
			if (currentState) {
				currentState.status = "not-spawned";
				currentState.client = null;
				currentState.tools = [];
				currentState.transport = null;
			}
		}
	}

	getRunningTools(): Map<string, { tools: Tool[]; config: McpServerConfig }> {
		const result = new Map<string, { tools: Tool[]; config: McpServerConfig }>();

		for (const [serverName, state] of this.servers.entries()) {
			if (state.status === "running") {
				result.set(serverName, { tools: state.tools, config: state.config });
			}
		}

		return result;
	}

	getServerStates(): Map<string, McpServerState> {
		return new Map(this.servers);
	}

	getClient(serverName: string): Client | null {
		const state = this.servers.get(serverName);
		if (state?.status === "running") {
			return state.client;
		}
		return null;
	}

	private async tryConnectOrFail(config: McpServerConfig, result?: ReloadResult): Promise<void> {
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

			result?.failed.push(config.name);
		}
	}

	/**
	 * Hot-reload: diff old vs new configs by name and reconcile state.
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

		const newConfigsByName = new Map<string, McpServerConfig>();
		for (const config of newConfigs) {
			newConfigsByName.set(config.name, config);
		}

		const currentNames = Array.from(this.servers.keys());
		for (const currentName of currentNames) {
			const currentState = this.servers.get(currentName);
			if (!currentState) continue;

			const newConfig = newConfigsByName.get(currentName);

			if (!newConfig) {
				result.removed.push(currentName);
				await this.terminateServer(currentName, currentState);
				this.servers.delete(currentName);
			} else if (!configsEqual(currentState.config, newConfig)) {
				result.changed.push(currentName);
				await this.terminateServer(currentName, currentState);
				this.servers.delete(currentName);

				if (newConfig.enabled) {
					await this.tryConnectOrFail(newConfig, result);
				} else {
					this.servers.set(newConfig.name, disabledState(newConfig));
				}
			}
		}

		for (const newConfig of newConfigs) {
			if (!this.servers.has(newConfig.name)) {
				result.added.push(newConfig.name);

				if (newConfig.enabled) {
					await this.tryConnectOrFail(newConfig, result);
				} else {
					this.servers.set(newConfig.name, disabledState(newConfig));
				}
			} else {
				// Unchanged config: reconnect a server that was disabled and is now enabled.
				const currentState = this.servers.get(newConfig.name);
				if (currentState && currentState.status === "disabled" && newConfig.enabled) {
					this.servers.delete(newConfig.name);

					await this.tryConnectOrFail(newConfig, result);
				}
			}
		}

		return result;
	}
}
