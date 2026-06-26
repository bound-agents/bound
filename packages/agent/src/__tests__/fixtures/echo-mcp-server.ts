/**
 * Loopback HTTP MCP server fixture for byte-fidelity testing.
 *
 * Stands up a real `Bun.serve` listener speaking the MCP Streamable HTTP
 * protocol via the official SDK server transport. Registered tools record the
 * exact `arguments` object they receive and echo it straight back, so a test
 * can compare what it put on the wire against what the server observed —
 * isolating every byte-handling hop that Bound controls (just-bash tokenizer,
 * the `--key value` parser, MCP arg coercion, JSON serialization, and the real
 * HTTP request body) from anything that happens inside a third-party MCP
 * service.
 *
 * The transport runs stateless (`sessionIdGenerator: undefined`); per the SDK,
 * a stateless transport may not be reused across requests, so a fresh
 * `McpServer` + transport pair is constructed per request. This matches the
 * SDK's documented stateless deployment shape and keeps the fixture free of
 * session bookkeeping.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export interface EchoToolSpec {
	/** Tool name exposed to the client (e.g. "issue_write"). */
	name: string;
	/**
	 * Names of string-typed parameters the tool accepts. Each is declared as an
	 * optional `z.string()` in the tool's input schema, so a test may exercise
	 * any subset of them. The fixture targets byte fidelity, not required-field
	 * validation; declaring params optional keeps a single-flag call from
	 * failing schema validation before it reaches the byte-comparison.
	 */
	stringParams: string[];
	/** Optional description surfaced in listTools. */
	description?: string;
}

export interface EchoMcpServer {
	/** Base URL to pass as an MCP client's `url` (http transport). */
	url: string;
	/**
	 * The most recent `arguments` object each tool received, keyed by tool name.
	 * Populated on every successful tool call. Read after `callTool` returns.
	 */
	lastArgs: Map<string, Record<string, unknown>>;
	/** Shut the listener down. */
	stop: () => void;
}

/**
 * Start a loopback MCP server exposing the given echo tools.
 *
 * Each tool, when called, stores its received arguments in `lastArgs` and
 * returns a text content block containing the JSON-serialized arguments plus a
 * per-string-param hex dump (`<param>=<utf8-hex>`), so callers can assert on
 * either the decoded value or the raw bytes the server observed.
 */
export async function startEchoMcpServer(tools: EchoToolSpec[]): Promise<EchoMcpServer> {
	const lastArgs = new Map<string, Record<string, unknown>>();

	const buildServer = (): McpServer => {
		const server = new McpServer({ name: "echo-mcp", version: "0.0.1" });
		for (const spec of tools) {
			const inputSchema: Record<string, z.ZodType> = {};
			for (const param of spec.stringParams) {
				inputSchema[param] = z.string().optional();
			}
			server.registerTool(
				spec.name,
				{ description: spec.description ?? `echo ${spec.name}`, inputSchema },
				async (args: Record<string, unknown>) => {
					lastArgs.set(spec.name, args);
					const hexDump = spec.stringParams
						.map((p) => {
							const v = args[p];
							const hex =
								typeof v === "string" ? Buffer.from(v, "utf8").toString("hex") : "(non-string)";
							return `${p}=${hex}`;
						})
						.join(" ");
					return {
						content: [{ type: "text", text: `${JSON.stringify(args)}\n${hexDump}` }],
					};
				},
			);
		}
		return server;
	};

	const server = Bun.serve({
		port: 0,
		async fetch(req: Request): Promise<Response> {
			// Stateless transport: construct fresh per request (SDK requirement).
			const mcpServer = buildServer();
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await mcpServer.connect(transport);
			return transport.handleRequest(req);
		},
	});

	return {
		url: `http://localhost:${server.port}/`,
		lastArgs,
		stop: () => server.stop(true),
	};
}
