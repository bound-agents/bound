#!/usr/bin/env bun
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.MCP_APP_PORT ?? 8788);
const RESOURCE_URI = "ui://task-board/view.html";

/** Bundle the app-side entry into a single inline IIFE and wrap it in HTML. */
async function buildAppHtml(): Promise<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const built = await Bun.build({
		entrypoints: [join(here, "app.ts")],
		target: "browser",
		format: "iife",
		minify: true,
	});
	if (!built.success) {
		throw new AggregateError(built.logs, "Failed to bundle task-board app");
	}
	let js = await built.outputs[0].text();
	// Bun's `format: "iife"` browser build references its internal `__require`
	// helper for a dynamic-require fallback but does NOT emit the helper
	// definition, so the bundle throws `ReferenceError: __require is not
	// defined` at eval time in the srcdoc. Prepend a browser stub: there is no
	// module system in an opaque-origin srcdoc, so any actual call is a bug we
	// want surfaced, not silenced.
	js = `var __require=function(n){throw new Error('Dynamic require of "'+n+'" is not supported in the MCP app sandbox');};\n${js}`;
	// A literal </script> inside the bundle would close the inline script tag
	// early; neutralize it (standard inline-bundle trick).
	js = js.replaceAll("</script>", "<\\/script>");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Task Board</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font: 14px/1.5 var(--font-sans, system-ui, sans-serif);
    color: var(--color-text-primary, #1a1a1a);
    background: var(--color-background-primary, #fff);
  }
  html.dark body { color: #f0f0f0; background: #1c1c1c; }
  #root { padding: 16px; box-sizing: border-box; }
  .tb-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tb-title { font-size: 18px; margin: 0; }
  .tb-mode { font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--color-border-primary, #ccc); background: transparent; color: inherit; }
  .tb-list { list-style: none; padding: 0; margin: 16px 0; display: flex; flex-direction: column; gap: 6px; }
  .tb-item { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .tb-item input { width: 16px; height: 16px; }
  .tb-done span { text-decoration: line-through; opacity: 0.55; }
  .tb-empty { opacity: 0.6; font-style: italic; }
  .tb-add { display: flex; gap: 8px; margin-bottom: 12px; }
  .tb-input { flex: 1; padding: 8px 10px; border-radius: 6px;
    border: 1px solid var(--color-border-primary, #ccc); background: transparent; color: inherit; }
  .tb-addbtn, .tb-ask { padding: 8px 14px; border-radius: 6px; cursor: pointer; border: none;
    background: var(--color-background-info, #2563eb); color: #fff; }
  .tb-ask { width: 100%; }
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;
}

const APP_HTML = await buildAppHtml();

/** Fresh MCP server per session — registers the tool + its UI resource. */
function makeServer(): McpServer {
	const server = new McpServer({ name: "task-board", version: "1.0.0" });

	registerAppResource(server, "Task Board View", RESOURCE_URI, {}, async (uri) => ({
		contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: APP_HTML }],
	}));

	registerAppTool(
		server,
		"track_tasks",
		{
			title: "Track Tasks",
			description:
				"Render an interactive, multi-turn task checklist in the conversation. " +
				"The user can check items off (which silently updates the model's context " +
				"for the next turn), add new tasks, or ask the assistant about the board " +
				"(both of which send a message back to you). Call again with updated `done` " +
				"flags to re-render the board with progress reflected.",
			inputSchema: {
				title: z.string().describe("Heading shown above the task list."),
				tasks: z
					.array(
						z.object({
							text: z.string().describe("The task description."),
							done: z.boolean().optional().describe("Whether the task is complete."),
						}),
					)
					.describe("The tasks to render as a checklist."),
			},
			_meta: { ui: { resourceUri: RESOURCE_URI } },
		},
		async ({ title, tasks }) => {
			const doneCount = tasks.filter((t) => t.done).length;
			return {
				content: [
					{
						type: "text",
						text: `Rendered task board "${title}" with ${tasks.length} task(s), ${doneCount} done.`,
					},
				],
			};
		},
	);

	return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	if (url.pathname !== "/mcp") {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "Not found. The MCP endpoint is /mcp." }));
		return;
	}

	const body = req.method === "POST" ? await readJsonBody(req) : undefined;

	// Stateless transport: a fresh server+transport pair per POST, so there is
	// no session to track and no standalone SSE stream that can collide. The
	// prior session-mode server returned 409 ("Only one SSE stream is allowed
	// per session") when the browser's MCP client reopened its GET SSE stream
	// on reload against a still-alive session. Stateless removes that class
	// entirely; GET/DELETE carry no useful work here and answer 405, which the
	// browser MCP client already tolerates (same as the Excalidraw server).
	if (req.method !== "POST") {
		res.writeHead(405, { "content-type": "application/json", allow: "POST" });
		res.end(
			JSON.stringify({
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message: "Method not allowed; this stateless MCP endpoint only accepts POST.",
				},
				id: null,
			}),
		);
		return;
	}

	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		void transport.close();
	});
	await makeServer().connect(transport);
	await transport.handleRequest(req, res, body);
});

httpServer.listen(PORT, () => {
	console.log(`task-board MCP App server listening on http://localhost:${PORT}/mcp`);
	console.log("Register it in ~/bound/config/mcp_apps.json, then reload the web UI.");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		httpServer.close();
		process.exit(0);
	});
}
