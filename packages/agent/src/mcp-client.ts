/**
 * MCP Client for connecting to and managing external MCP servers.
 * Implements lifecycle management per spec §7.2.
 */

export interface MCPServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	transport: "stdio" | "sse";
	allow_tools?: string[];
	confirm?: string[];
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface ResourceDefinition {
	uri: string;
	name: string;
	description: string;
	mimeType?: string;
}

export interface PromptDefinition {
	name: string;
	description: string;
	arguments?: Array<{ name: string; description?: string }>;
}

export interface ToolResult {
	content: string;
	isError?: boolean;
}

export interface ResourceContent {
	uri: string;
	mimeType?: string;
	content: string;
}

export interface PromptResult {
	messages: Array<{ role: string; content: string }>;
}

/**
 * MCPClient manages connections to external MCP servers.
 * For Phase 4, this is a simplified version with mock support.
 */
export class MCPClient {
	private serverConfig: MCPServerConfig;
	private connected = false;
	private tools: Map<string, ToolDefinition> = new Map();
	private resources: Map<string, ResourceDefinition> = new Map();
	private prompts: Map<string, PromptDefinition> = new Map();

	constructor(serverConfig: MCPServerConfig) {
		this.serverConfig = serverConfig;
	}

	/**
	 * Connect to the MCP server
	 * For Phase 4: stub implementation - mock servers only
	 */
	async connect(): Promise<void> {
		// Phase 4: Simplified - no real connections
		// Real implementation would:
		// 1. Spawn process for stdio transport
		// 2. Connect to SSE URL for sse transport
		// 3. Exchange initialization handshake
		this.connected = true;
	}

	/**
	 * Disconnect from the MCP server
	 */
	async disconnect(): Promise<void> {
		this.connected = false;
		this.tools.clear();
		this.resources.clear();
		this.prompts.clear();
	}

	/**
	 * Discover available tools from the server
	 * Returns synchronously if already connected and loaded, otherwise throws
	 */
	listTools(): ToolDefinition[] {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		return Array.from(this.tools.values());
	}

	/**
	 * Discover available resources from the server
	 * Returns synchronously if already connected and loaded, otherwise throws
	 */
	listResources(): ResourceDefinition[] {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		return Array.from(this.resources.values());
	}

	/**
	 * Discover available prompts from the server
	 * Returns synchronously if already connected and loaded, otherwise throws
	 */
	listPrompts(): PromptDefinition[] {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		return Array.from(this.prompts.values());
	}

	/**
	 * Execute a tool on the MCP server
	 */
	async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const tool = this.tools.get(name);
		if (!tool) {
			return {
				content: `Tool not found: ${name}`,
				isError: true,
			};
		}

		// Phase 4: Stub - real implementation would RPC to the server
		return {
			content: `Tool ${name} called with args: ${JSON.stringify(args)}`,
			isError: false,
		};
	}

	/**
	 * Read a resource from the MCP server
	 */
	async readResource(uri: string): Promise<ResourceContent> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const resource = this.resources.get(uri);
		if (!resource) {
			throw new Error(`Resource not found: ${uri}`);
		}

		// Phase 4: Stub - real implementation would RPC to the server
		return {
			uri,
			content: `Content of ${uri}`,
			mimeType: resource.mimeType,
		};
	}

	/**
	 * Invoke a prompt on the MCP server
	 */
	async invokePrompt(name: string, args: Record<string, string>): Promise<PromptResult> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const prompt = this.prompts.get(name);
		if (!prompt) {
			throw new Error(`Prompt not found: ${name}`);
		}

		// Phase 4: Stub - real implementation would RPC to the server
		return {
			messages: [
				{
					role: "system",
					content: `Prompt ${name} invoked with args: ${JSON.stringify(args)}`,
				},
			],
		};
	}

	/**
	 * Register a tool (for testing/mocking)
	 */
	registerTool(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	/**
	 * Register a resource (for testing/mocking)
	 */
	registerResource(resource: ResourceDefinition): void {
		this.resources.set(resource.uri, resource);
	}

	/**
	 * Register a prompt (for testing/mocking)
	 */
	registerPrompt(prompt: PromptDefinition): void {
		this.prompts.set(prompt.name, prompt);
	}

	/**
	 * Get the server configuration
	 */
	getConfig(): MCPServerConfig {
		return this.serverConfig;
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.connected;
	}
}
