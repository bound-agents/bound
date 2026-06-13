import { describe, expect, it } from "bun:test";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	MCP_APPS_HOST_CAPABILITIES,
	MCP_UI_EXTENSION_ID,
	McpAppHost,
	callToolResultToContent,
	mcpToolName,
	mcpToolToDefinition,
	sanitizeNamePart,
} from "../mcp-app-host";

/** Minimal fake MCP client capturing the calls it receives. */
class FakeMcpClient {
	public calls: { name: string; arguments?: Record<string, unknown> }[] = [];
	constructor(
		private readonly result: CallToolResult | Error,
		private readonly serverName?: string,
	) {}
	getServerVersion() {
		return this.serverName ? { name: this.serverName, version: "1.0.0" } : undefined;
	}
	async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
		this.calls.push(params);
		if (this.result instanceof Error) throw this.result;
		return this.result;
	}
}

function textTool(name: string, extra?: Partial<Tool>): Tool {
	return {
		name,
		description: `desc for ${name}`,
		inputSchema: { type: "object", properties: { x: { type: "string" } } },
		...extra,
	} as Tool;
}

function uiTool(name: string, resourceUri: string): Tool {
	return {
		name,
		description: `ui ${name}`,
		inputSchema: { type: "object", properties: {} },
		_meta: { "ui.resourceUri": resourceUri, ui: { resourceUri } },
	} as unknown as Tool;
}

function textResult(...texts: string[]): CallToolResult {
	return { content: texts.map((text) => ({ type: "text", text })) } as CallToolResult;
}

describe("sanitizeNamePart", () => {
	it("replaces wire-illegal characters with underscores", () => {
		expect(sanitizeNamePart("my server!")).toBe("my_server_");
		expect(sanitizeNamePart("create.view:1")).toBe("create_view_1");
	});
	it("leaves already-legal names untouched", () => {
		expect(sanitizeNamePart("create_view-2")).toBe("create_view-2");
	});
});

describe("MCP Apps host capability negotiation", () => {
	it("uses the package's canonical UI extension id", () => {
		// Pin our browser-safe literal to ext-apps' own constant so a package
		// rename breaks this test instead of silently breaking negotiation.
		expect(MCP_UI_EXTENSION_ID).toBe(EXTENSION_ID);
		expect(MCP_UI_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
	});

	it("advertises the UI host capability under the extensions field", () => {
		// A server that gates UI bindings on capability negotiation (e.g.
		// github-mcp-server's clientSupportsUI) only emits them when the client
		// declares io.modelcontextprotocol/ui here at initialize.
		const ext = (MCP_APPS_HOST_CAPABILITIES as { extensions?: Record<string, unknown> }).extensions;
		expect(ext).toBeDefined();
		expect(ext?.[MCP_UI_EXTENSION_ID]).toBeDefined();
	});
});

describe("mcpToolName", () => {
	it("namespaces server + tool under an mcp__ prefix", () => {
		expect(mcpToolName("excalidraw", "create_view")).toBe("mcp__excalidraw__create_view");
	});
	it("produces wire-legal output for messy inputs", () => {
		const name = mcpToolName("my server!", "do.it:now");
		expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});

describe("mcpToolToDefinition", () => {
	it("maps an MCP tool to a bound function ToolDefinition", () => {
		const def = mcpToolToDefinition("mcp__s__t", textTool("t"));
		expect(def.type).toBe("function");
		expect(def.function.name).toBe("mcp__s__t");
		expect(def.function.description).toBe("desc for t");
		expect(def.function.parameters).toEqual({
			type: "object",
			properties: { x: { type: "string" } },
		});
	});
	it("defaults description and parameters when absent", () => {
		const def = mcpToolToDefinition("mcp__s__t", { name: "t" } as Tool);
		expect(def.function.description).toBe("");
		expect(def.function.parameters).toEqual({ type: "object", properties: {} });
	});
});

describe("callToolResultToContent", () => {
	it("joins text blocks with newlines", () => {
		expect(callToolResultToContent(textResult("a", "b"))).toBe("a\nb");
	});
	it("summarizes non-text blocks", () => {
		const result = {
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "deadbeef", mimeType: "image/png" },
				{ type: "resource_link", uri: "file:///x" },
			],
		} as CallToolResult;
		const out = callToolResultToContent(result);
		expect(out).toContain("hello");
		expect(out).toContain("[image]");
		expect(out).toContain("file:///x");
	});
	it("falls back to structuredContent when there is no content", () => {
		const result = { content: [], structuredContent: { ok: true } } as unknown as CallToolResult;
		expect(callToolResultToContent(result)).toBe('{"ok":true}');
	});
});

describe("McpAppHost", () => {
	it("registers a server's tools and exposes namespaced definitions", () => {
		const host = new McpAppHost();
		const client = new FakeMcpClient(textResult("ok"));
		const defs = host.registerServer("excalidraw", client, [textTool("create_view")]);
		expect(defs).toHaveLength(1);
		expect(defs[0].function.name).toBe("mcp__excalidraw__create_view");
		expect(host.getToolDefinitions().map((d) => d.function.name)).toEqual([
			"mcp__excalidraw__create_view",
		]);
	});

	it("dispatches a bound tool call to the owning server with the original tool name", async () => {
		const host = new McpAppHost();
		const client = new FakeMcpClient(textResult("rendered"));
		host.registerServer("excalidraw", client, [textTool("create_view")]);
		const res = await host.dispatch({
			call_id: "c1",
			thread_id: "t1",
			tool_name: "mcp__excalidraw__create_view",
			arguments: { x: "1" },
		});
		expect(client.calls).toEqual([{ name: "create_view", arguments: { x: "1" } }]);
		expect(res).toEqual({
			call_id: "c1",
			thread_id: "t1",
			content: "rendered",
			is_error: false,
		});
	});

	it("returns an error result for an unknown tool name", async () => {
		const host = new McpAppHost();
		const res = await host.dispatch({
			call_id: "c2",
			thread_id: "t1",
			tool_name: "mcp__nope__nope",
			arguments: {},
		});
		expect(res.is_error).toBe(true);
		expect(String(res.content)).toContain("mcp__nope__nope");
	});

	it("captures a thrown callTool error as an error result rather than rejecting", async () => {
		const host = new McpAppHost();
		const client = new FakeMcpClient(new Error("boom"));
		host.registerServer("s", client, [textTool("t")]);
		const res = await host.dispatch({
			call_id: "c3",
			thread_id: "t1",
			tool_name: "mcp__s__t",
			arguments: {},
		});
		expect(res.is_error).toBe(true);
		expect(String(res.content)).toContain("boom");
	});

	it("propagates an MCP isError result as is_error", async () => {
		const host = new McpAppHost();
		const errResult = { content: [{ type: "text", text: "bad" }], isError: true } as CallToolResult;
		const client = new FakeMcpClient(errResult);
		host.registerServer("s", client, [textTool("t")]);
		const res = await host.dispatch({
			call_id: "c4",
			thread_id: "t1",
			tool_name: "mcp__s__t",
			arguments: {},
		});
		expect(res.is_error).toBe(true);
		expect(res.content).toBe("bad");
	});

	it("dedupes colliding bound names across servers", () => {
		const host = new McpAppHost();
		host.registerServer("dup", new FakeMcpClient(textResult("a")), [textTool("tool")]);
		host.registerServer("dup", new FakeMcpClient(textResult("b")), [textTool("tool")]);
		const names = host.getToolDefinitions().map((d) => d.function.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toHaveLength(2);
	});

	it("identifies UI-bearing tools via the ext-apps resource-uri binding", () => {
		const host = new McpAppHost();
		host.registerServer("excalidraw", new FakeMcpClient(textResult("x")), [
			uiTool("create_view", "ui://excalidraw/mcp-app.html"),
			textTool("plain"),
		]);
		expect(host.isUiBearing("mcp__excalidraw__create_view")).toBe(true);
		expect(host.isUiBearing("mcp__excalidraw__plain")).toBe(false);
		expect(host.uiResourceUri("mcp__excalidraw__create_view")).toBe("ui://excalidraw/mcp-app.html");
	});

	it("resolves the originating server + tool for a bound name", () => {
		const host = new McpAppHost();
		const client = new FakeMcpClient(textResult("x"));
		host.registerServer("excalidraw", client, [textTool("create_view")]);
		const reg = host.resolve("mcp__excalidraw__create_view");
		expect(reg?.serverName).toBe("excalidraw");
		expect(reg?.originalName).toBe("create_view");
		expect(reg?.client).toBe(client);
	});
});
