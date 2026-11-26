import type { ContentBlock } from "@bound/llm";
import { formatMcpProvenance } from "../tools/provenance";
import { type ToolResult, isImageMediaType } from "../tools/types";
import type { McpServerManager } from "./manager";

export interface ToolNameMapping {
	serverName: string;
	toolName: string;
}

function mapMcpContentItem(item: Record<string, unknown>): ContentBlock {
	if (item.type === "text" && typeof item.text === "string") {
		return { type: "text", text: item.text };
	}
	if (item.type === "image" && typeof item.mimeType === "string" && typeof item.data === "string") {
		if (isImageMediaType(item.mimeType)) {
			return {
				type: "image",
				source: { type: "base64", media_type: item.mimeType, data: item.data },
			};
		}
		return { type: "text", text: `[unsupported image media type: ${item.mimeType}]` };
	}
	if (item.type === "resource" && item.resource && typeof item.resource === "object") {
		// Several servers (e.g. github get_file_contents) return the actual payload
		// as an embedded resource; surface its bytes instead of an "[unsupported]" stub.
		const resource = item.resource as Record<string, unknown>;
		const uri = typeof resource.uri === "string" ? resource.uri : "";
		const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "";
		const mimeSuffix = mimeType ? ` (${mimeType})` : "";
		if (typeof resource.text === "string") {
			const provenanceSuffix = uri ? ` [resource: ${uri}${mimeSuffix}]` : "";
			return { type: "text", text: `${resource.text}${provenanceSuffix}` };
		}
		if (typeof resource.blob === "string" && isImageMediaType(mimeType)) {
			return {
				type: "image",
				source: { type: "base64", media_type: mimeType, data: resource.blob },
			};
		}
		return {
			type: "text",
			text: `[embedded resource: ${uri || "(no uri)"}${mimeSuffix}, ${typeof resource.blob === "string" ? "binary" : "no"} content]`,
		};
	}
	return { type: "text", text: `[unsupported MCP content type: ${String(item.type)}]` };
}

/**
 * Proxy an MCP tool call through the server manager, prefixing an MCP
 * provenance block and carrying the server's `isError` flag through.
 */
export async function proxyToolCall(
	manager: McpServerManager,
	mapping: ToolNameMapping,
	args: Record<string, unknown>,
	hostname: string,
): Promise<ToolResult> {
	const { serverName, toolName } = mapping;
	const client = manager.getClient(serverName);
	if (!client) {
		return {
			content: [{ type: "text", text: `MCP server '${serverName}' is not running` }],
			isError: true,
		};
	}

	const provenance = formatMcpProvenance(hostname, serverName, toolName);
	try {
		const result = await client.callTool({ name: toolName, arguments: args });
		const blocks: ContentBlock[] = [provenance];
		if (Array.isArray(result.content)) {
			for (const item of result.content) {
				blocks.push(mapMcpContentItem(item as Record<string, unknown>));
			}
		}
		if (result.isError) {
			if (blocks.length === 1) blocks.push({ type: "text", text: "MCP tool returned an error" });
			return { content: blocks, isError: true };
		}
		return { content: blocks };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			content: [provenance, { type: "text", text: `Error calling MCP tool: ${errorMessage}` }],
			isError: true,
		};
	}
}
