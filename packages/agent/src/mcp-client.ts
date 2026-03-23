/**
 * MCP Client for connecting to and managing external MCP servers.
 * Implements lifecycle management per spec §7.2.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, Resource, Prompt } from "@modelcontextprotocol/sdk/types.js";

export interface MCPServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	transport: "stdio" | "sse";
	allow_tools?: string[];
	confirm?: string[];
}

export type { Tool, Resource, Prompt };

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
 * MCPClient manages connections to external MCP servers using the real MCP SDK.
 */
export class MCPClient {
	private serverConfig: MCPServerConfig;
	private client: Client;
	private connected = false;

	constructor(serverConfig: MCPServerConfig) {
		this.serverConfig = serverConfig;
		this.client = new Client({ name: "bound", version: "0.0.1" });
	}

	/**
	 * Connect to the MCP server via stdio transport.
	 */
	async connect(): Promise<void> {
		if (this.serverConfig.transport !== "stdio") {
			throw new Error(`Transport "${this.serverConfig.transport}" is not yet supported`);
		}

		if (!this.serverConfig.command) {
			throw new Error(`Server "${this.serverConfig.name}" requires a command for stdio transport`);
		}

		const transport = new StdioClientTransport({
			command: this.serverConfig.command,
			args: this.serverConfig.args,
		});

		await this.client.connect(transport);
		this.connected = true;
	}

	/**
	 * Disconnect from the MCP server.
	 */
	async disconnect(): Promise<void> {
		if (this.connected) {
			await this.client.close();
			this.connected = false;
		}
	}

	/**
	 * Discover available tools from the server.
	 */
	async listTools(): Promise<Tool[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listTools();
		return result.tools;
	}

	/**
	 * Discover available resources from the server.
	 */
	async listResources(): Promise<Resource[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listResources();
		return result.resources;
	}

	/**
	 * Discover available prompts from the server.
	 */
	async listPrompts(): Promise<Prompt[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listPrompts();
		return result.prompts;
	}

	/**
	 * Execute a tool on the MCP server.
	 */
	async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const result = await this.client.callTool({ name, arguments: args });

		// Extract text content from the result's content array
		const parts: string[] = [];
		if (Array.isArray(result.content)) {
			for (const item of result.content) {
				if (item.type === "text") {
					parts.push(item.text);
				} else if (item.type === "image") {
					parts.push(`[image: ${item.mimeType}]`);
				} else if (item.type === "audio") {
					parts.push(`[audio: ${item.mimeType}]`);
				} else if (item.type === "resource") {
					const r = item.resource;
					parts.push("text" in r ? r.text : `[blob: ${r.mimeType ?? "unknown"}]`);
				}
			}
		}

		return {
			content: parts.join("\n"),
			isError: result.isError === true,
		};
	}

	/**
	 * Read a resource from the MCP server.
	 */
	async readResource(uri: string): Promise<ResourceContent> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const result = await this.client.readResource({ uri });

		// Use the first content item
		const first = result.contents[0];
		if (!first) {
			throw new Error(`No content returned for resource: ${uri}`);
		}

		return {
			uri: first.uri,
			mimeType: first.mimeType,
			content: "text" in first ? first.text : first.blob,
		};
	}

	/**
	 * Invoke a prompt on the MCP server.
	 */
	async invokePrompt(name: string, args: Record<string, string>): Promise<PromptResult> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const result = await this.client.getPrompt({ name, arguments: args });

		return {
			messages: result.messages.map((m) => {
				let content: string;
				if (m.content.type === "text") {
					content = m.content.text;
				} else if (m.content.type === "resource") {
					const r = m.content.resource;
					content = "text" in r ? r.text : `[blob: ${r.mimeType ?? "unknown"}]`;
				} else {
					content = `[${m.content.type}]`;
				}
				return { role: m.role, content };
			}),
		};
	}

	/**
	 * Get the server configuration.
	 */
	getConfig(): MCPServerConfig {
		return this.serverConfig;
	}

	/**
	 * Check if connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}
}
