/**
 * MCP Client for connecting to and managing external MCP servers.
 * Implements lifecycle management per spec §7.2.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Prompt, Resource, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface MCPServerConfig {
	name: string;
	command?: string;
	args?: string[];
	url?: string;
	transport: "stdio" | "http";
	headers?: Record<string, string>;
	allow_tools?: string[];
	confirm?: string[];
}

export type { Tool, Resource, Prompt };

export interface ToolResultImage {
	media_type: string;
	data: string;
}

/**
 * Inline binary resource extracted from an MCP tool result. The MCP `resource`
 * content type carries either text (handled inline) or a base64 blob (handled
 * here). Image-mime blobs are routed into `images` for visual rendering;
 * everything else lands here so the call site can persist the bytes (e.g.
 * write to the files table) and emit a file_ref document block.
 */
export interface ToolResultDocument {
	media_type: string;
	data: string;
	uri?: string;
}

/**
 * MCP `resource_link` content type — a pointer to a resource without
 * inlining its bytes. Passed through as a structured text annotation;
 * the agent loads them on demand via the bash `resource` command.
 */
export interface ToolResultResourceLink {
	uri: string;
	name?: string;
	mimeType?: string;
	description?: string;
}

export interface ToolResult {
	content: string;
	images?: ToolResultImage[];
	documents?: ToolResultDocument[];
	resourceLinks?: ToolResultResourceLink[];
	isError?: boolean;
}

const IMAGE_MIME_PREFIX = "image/";

function isImageMime(mime: string | undefined): boolean {
	return typeof mime === "string" && mime.startsWith(IMAGE_MIME_PREFIX);
}

/**
 * Extract text, image, document, and resource-link content from MCP SDK
 * content blocks.
 *
 * Output channels:
 *   - text: joined into `content` (preserves the legacy text-only contract)
 *   - image content: base64 + mime → `images`
 *   - resource (text): inlined into `content`
 *   - resource (blob, image mime): treated as image → `images`
 *   - resource (blob, other mime): bytes → `documents` for file-table persist
 *   - resource_link: structured pointer → `resourceLinks` for passthrough
 *   - audio: stringified placeholder (out of scope; tracked separately)
 *
 * No silent drops — every recognized MCP content variant lands in some
 * output channel so the call site can decide how to surface it to the model.
 */
export function extractMCPToolResult(
	contentBlocks: Array<Record<string, unknown>>,
): Pick<ToolResult, "content" | "images" | "documents" | "resourceLinks"> {
	const parts: string[] = [];
	const images: ToolResultImage[] = [];
	const documents: ToolResultDocument[] = [];
	const resourceLinks: ToolResultResourceLink[] = [];

	for (const item of contentBlocks) {
		if (item.type === "text") {
			parts.push(item.text as string);
		} else if (item.type === "image") {
			images.push({
				media_type: item.mimeType as string,
				data: item.data as string,
			});
		} else if (item.type === "audio") {
			// TODO: route to documents/files once we support audio-capable
			// backends. For now, keep the legacy text placeholder so behavior
			// doesn't change for audio-only MCP servers.
			parts.push(`[audio: ${item.mimeType}]`);
		} else if (item.type === "resource") {
			const r = item.resource as Record<string, unknown>;
			if ("text" in r && typeof r.text === "string") {
				parts.push(r.text);
			} else if ("blob" in r && typeof r.blob === "string") {
				const mime = (r.mimeType as string | undefined) ?? "application/octet-stream";
				const uri = typeof r.uri === "string" ? r.uri : undefined;
				if (isImageMime(mime)) {
					images.push({ media_type: mime, data: r.blob });
				} else {
					documents.push({ media_type: mime, data: r.blob, uri });
				}
			}
		} else if (item.type === "resource_link") {
			// MCP `resource_link` carries a URI pointing at a resource, plus
			// optional name/mimeType/description metadata. We don't fetch it
			// here — the agent uses the bash `resource <uri>` command on
			// demand. This keeps tool_result payloads small and lets the
			// model decide whether the link is worth dereferencing.
			const uri = typeof item.uri === "string" ? item.uri : undefined;
			if (uri) {
				resourceLinks.push({
					uri,
					name: typeof item.name === "string" ? item.name : undefined,
					mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
					description: typeof item.description === "string" ? item.description : undefined,
				});
			}
		}
	}

	return {
		content: parts.join("\n"),
		images: images.length > 0 ? images : undefined,
		documents: documents.length > 0 ? documents : undefined,
		resourceLinks: resourceLinks.length > 0 ? resourceLinks : undefined,
	};
}

export interface ResourceContent {
	uri: string;
	mimeType?: string;
	/**
	 * The resource payload. For text resources this is the literal UTF-8
	 * text; for binary resources this is base64-encoded bytes (so callers
	 * can persist it directly into the `files` table without a re-encode).
	 * Use `isBinary` to distinguish — the field is collapsed because the
	 * MCP wire shape carries either `text` xor `blob` per content item, and
	 * callers usually only care about one branch at a time.
	 */
	content: string;
	isBinary: boolean;
}

export interface PromptResult {
	messages: Array<{ role: string; content: string }>;
}

/**
 * Escape all non-ASCII UTF-16 code units in a string to `\uXXXX` escape
 * sequences, producing a pure-ASCII result that round-trips faithfully
 * through HTTP proxies or CDNs that mis-classify `application/json` bodies as
 * Latin-1 (the old RFC 2616 default charset). Such proxies corrupt UTF-8
 * multi-byte sequences — the leading byte (0xC2–0xF4) survives as a single
 * Latin-1 character while continuation bytes (0x80–0xBF) are stripped as
 * C1 controls, turning e.g. an em dash (U+2014, UTF-8 E2 80 94) into `â`.
 *
 * Surrogate pairs (U+D800–U+DFFF) are escaped as two consecutive `\uXXXX`
 * sequences — valid JSON per RFC 8259 §7, and correctly decoded by
 * `JSON.parse` back to the original Unicode scalar.
 *
 * @example
 *   escapeNonAscii('hello — world')  // 'hello \\u2014 world'
 *   escapeNonAscii('✓ done')         // '\\u2713 done'
 */
export function escapeNonAscii(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code > 0x7f) {
			out += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			out += s[i];
		}
	}
	return out;
}

/**
 * A `FetchLike` wrapper that escapes all non-ASCII characters in string request
 * bodies before forwarding to the global `fetch`. This prevents character
 * corruption when the JSON body transits a proxy that misinterprets UTF-8 as
 * Latin-1. The resulting ASCII-only payload is semantically identical — any
 * conformant JSON parser decodes `\uXXXX` sequences back to the original
 * characters.
 *
 * Injected as the `fetch` option of `StreamableHTTPClientTransport` for all
 * HTTP-transport MCP connections.
 */
function asciiSafeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	if (init?.body != null && typeof init.body === "string") {
		return fetch(url, { ...init, body: escapeNonAscii(init.body) });
	}
	return fetch(url, init);
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

	async connect(): Promise<void> {
		if (this.serverConfig.transport === "stdio") {
			if (!this.serverConfig.command) {
				throw new Error(
					`Server "${this.serverConfig.name}" requires a command for stdio transport`,
				);
			}
			const transport = new StdioClientTransport({
				command: this.serverConfig.command,
				args: this.serverConfig.args,
			});
			await this.client.connect(transport);
		} else {
			if (!this.serverConfig.url) {
				throw new Error(`Server "${this.serverConfig.name}" requires a url for http transport`);
			}
			const transport = new StreamableHTTPClientTransport(new URL(this.serverConfig.url), {
				requestInit: this.serverConfig.headers ? { headers: this.serverConfig.headers } : undefined,
				fetch: asciiSafeFetch,
			});
			await this.client.connect(transport);
		}
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		if (this.connected) {
			await this.client.close();
			this.connected = false;
		}
	}

	async listTools(): Promise<Tool[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listTools();
		return result.tools;
	}

	async listResources(): Promise<Resource[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listResources();
		return result.resources;
	}

	async listPrompts(): Promise<Prompt[]> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}
		const result = await this.client.listPrompts();
		return result.prompts;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const result = await this.client.callTool({ name, arguments: args });

		const extracted = Array.isArray(result.content)
			? extractMCPToolResult(result.content as Array<Record<string, unknown>>)
			: { content: "", images: undefined, documents: undefined, resourceLinks: undefined };

		return {
			...extracted,
			isError: result.isError === true,
		};
	}

	async readResource(uri: string): Promise<ResourceContent> {
		if (!this.connected) {
			throw new Error(`MCP client not connected to ${this.serverConfig.name}`);
		}

		const result = await this.client.readResource({ uri });

		const first = result.contents[0];
		if (!first) {
			throw new Error(`No content returned for resource: ${uri}`);
		}

		return {
			uri: first.uri,
			mimeType: first.mimeType,
			content: "text" in first ? first.text : first.blob,
			isBinary: !("text" in first),
		};
	}

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

	getConfig(): MCPServerConfig {
		return this.serverConfig;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Get the server's description from its InitializeResult, if available.
	 * Only available after connect().
	 */
	getServerDescription(): string | undefined {
		return this.client.getServerVersion()?.description;
	}

	/**
	 * Get the server's instructions from its InitializeResult, if available.
	 * Only available after connect().
	 */
	getServerInstructions(): string | undefined {
		return this.client.getInstructions();
	}

	/**
	 * Get the server's implementation info (name/title/version) from its
	 * InitializeResult, if available. Only available after connect().
	 */
	getServerInfo(): { name?: string; title?: string; version?: string } | undefined {
		const info = this.client.getServerVersion();
		if (!info) return undefined;
		return {
			name: info.name,
			title: (info as { title?: string }).title,
			version: info.version,
		};
	}
}
