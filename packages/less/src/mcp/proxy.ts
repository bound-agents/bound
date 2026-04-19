/**
 * MCP tool call proxy — maps MCP results to ContentBlock[].
 * Implements AC6.3: Tool call proxied via client.callTool(), MCP result mapped to ContentBlock[] with MCP provenance
 */

import type { ContentBlock } from "@bound/llm";
import { formatMcpProvenance } from "../tools/provenance";
import type { ToolNameMapping } from "../tools/registry";
import type { McpServerManager } from "./manager";

/**
 * Proxy an MCP tool call through the server manager.
 *
 * @param manager - McpServerManager instance
 * @param prefixedName - Namespaced tool name (e.g., "boundless_mcp_server_tool")
 * @param args - Tool arguments
 * @param signal - AbortSignal for cancellation
 * @param hostname - Hostname for provenance metadata
 * @param toolNameMapping - Map from prefixed name to {serverName, toolName}
 * @returns ContentBlock[] with provenance and mapped MCP result
 */
export async function proxyToolCall(
	manager: McpServerManager,
	prefixedName: string,
	args: Record<string, unknown>,
	_signal: AbortSignal,
	hostname: string,
	toolNameMapping: Map<string, ToolNameMapping>,
): Promise<ContentBlock[]> {
	// Step 1: Lookup prefixed name in mapping
	const mapping = toolNameMapping.get(prefixedName);
	if (!mapping) {
		return [
			{
				type: "text",
				text: `Unknown tool: ${prefixedName}`,
			},
		];
	}

	const { serverName, toolName } = mapping;

	// Step 2: Lookup server client
	const client = manager.getClient(serverName);
	if (!client) {
		return [
			{
				type: "text",
				text: `MCP server '${serverName}' is not running`,
			},
		];
	}

	try {
		// Step 3: Call tool via MCP client
		const result = await client.callTool({
			name: toolName,
			arguments: args,
		});

		// Step 4: Map MCP result to ContentBlock[]
		const blocks: ContentBlock[] = [];

		// Prepend provenance block
		blocks.push(formatMcpProvenance(hostname, serverName, toolName));

		// Map content blocks
		if (result.content && Array.isArray(result.content)) {
			for (const item of result.content) {
				// Type assertion needed because MCP SDK types are loosely typed
				const mcpItem = item as Record<string, unknown>;
				if (item.type === "text" && typeof mcpItem.text === "string") {
					blocks.push({
						type: "text",
						text: mcpItem.text,
					});
				} else if (
					item.type === "image" &&
					typeof mcpItem.mimeType === "string" &&
					typeof mcpItem.data === "string"
				) {
					blocks.push({
						type: "image",
						source: {
							type: "base64",
							media_type: mcpItem.mimeType,
							data: mcpItem.data,
						},
					});
				} else {
					// Graceful degradation for unsupported types
					blocks.push({
						type: "text",
						text: `[unsupported MCP content type: ${String(mcpItem.type)}]`,
					});
				}
			}
		}

		// Step 5: Handle isError flag
		if (result.isError) {
			// If no content blocks were added, create an error block
			if (blocks.length === 1) {
				// Only provenance block exists
				blocks.push({
					type: "text",
					text: "MCP tool returned an error",
				});
			}
			// Mark the result as error by convention (caller will handle)
			// For now, just return the blocks with error content
		}

		return blocks;
	} catch (error) {
		// Handle MCP client errors
		const errorMessage = error instanceof Error ? error.message : String(error);
		return [
			formatMcpProvenance(hostname, serverName, toolName),
			{
				type: "text",
				text: `Error calling MCP tool: ${errorMessage}`,
			},
		];
	}
}
