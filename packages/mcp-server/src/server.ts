import { BoundClient } from "@bound/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBoundChatHandler } from "./handler";

function getBaseUrl(): string {
	const args = process.argv.slice(2);
	const urlIdx = args.indexOf("--url");
	if (urlIdx !== -1 && args[urlIdx + 1]) {
		return args[urlIdx + 1];
	}
	return process.env.BOUND_URL ?? "http://localhost:3001";
}

async function main(): Promise<void> {
	const baseUrl = getBaseUrl();
	const client = new BoundClient(baseUrl);
	client.connect();

	const server = new McpServer({
		name: "bound-mcp",
		version: "0.0.1",
	});

	server.registerTool(
		"bound_chat",
		{
			description:
				"Send a message to a running bound agent and receive the assistant's reply. Optionally continue an existing conversation by supplying a thread_id.",
			inputSchema: {
				message: z.string().describe("The message to send to the bound agent"),
				thread_id: z
					.string()
					.optional()
					.describe("Optional thread ID to continue an existing conversation"),
			},
		},
		createBoundChatHandler(client),
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("[bound-mcp] MCP server running on stdio (bound at %s)", baseUrl);

	// Cleanup on process exit
	process.on("SIGINT", () => {
		client.disconnect();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		client.disconnect();
		process.exit(0);
	});
}

main().catch((error: unknown) => {
	console.error("[bound-mcp] Fatal error:", error);
	process.exit(1);
});
