/**
 * High-level guarantee: when the agent loop dispatches an MCP tool call whose
 * tool carries an MCP Apps UI binding (`_meta.ui.resourceUri`), the binding
 * lands on the PERSISTED tool_result row's `messages.metadata.mcp_app` in the
 * exact shape the web renderer consumes — `{ server, tool, uiResourceUri }`.
 *
 * This drives the full production path end-to-end:
 *   ScriptedLLM emits {name:"bash", command:"github get_me"}
 *     → AgentLoop dispatch (sees "bash")
 *     → sandbox.exec → just-bash → the real generateMCPCommands github handler
 *     → handler stashes the binding on the loopContextStorage store
 *     → exec wrapper lifts store.mcpApp onto the result (replicated here, as
 *       relay-mcp-proxy.test.ts replicates the relayRequest wrapper)
 *     → AgentLoop persist seam stamps messages.metadata.mcp_app
 *
 * The renderer is tested manually; the data shape is guaranteed here.
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMetricsSchema, applySchema, createDatabase, readMessageMetadata } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { createDefineCommands, loopContextStorage } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { Bash, InMemoryFs } from "just-bash";
import { AgentLoop } from "../agent-loop";
import { generateMCPCommands } from "../mcp-bridge";
import type { MCPClient, MCPServerConfig, Tool } from "../mcp-client";
import type { RegisteredTool } from "../types";

const UI_RESOURCE_URI = "ui://github-mcp-server/get-me;profile=mcp-app";

// The sandbox bash tool, registered exactly as agent-factory's createToolRegistry
// does — so the loop dispatches "github get_me" through the registry "sandbox"
// case (the production path), not the legacy fallback.
const BASH_REGISTRY: Map<string, RegisteredTool> = new Map([
	[
		"bash",
		{
			kind: "sandbox",
			toolDefinition: {
				type: "function",
				function: {
					name: "bash",
					description: "Execute a command in the sandboxed shell.",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			},
		} as RegisteredTool,
	],
]);

// ─── Scripted LLM: one tool call, then final text ───────────────────
class ScriptedLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private idx = 0;

	toolThenText(toolId: string, command: string, finalText: string) {
		this.responses = [];
		this.responses.push(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: "bash" };
			yield {
				type: "tool_use_args" as const,
				id: toolId,
				partial_json: JSON.stringify({ command }),
			};
			yield { type: "tool_use_end" as const, id: toolId };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 15,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
		this.responses.push(async function* () {
			yield { type: "text" as const, content: finalText };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 20,
					output_tokens: 10,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		});
	}

	async *chat() {
		const gen = this.responses[this.idx];
		this.idx++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
		}
	}

	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 8000,
		};
	}
}

// ─── Fake MCP client: get_me carries a UI binding, list_issues does not ───
function makeFakeGithubClient(): MCPClient {
	const tools: Tool[] = [
		{
			name: "get_me",
			description: "Get the authenticated user",
			inputSchema: { type: "object", properties: {} },
			// MCP Apps UI binding — the renderer keys off this.
			_meta: { ui: { resourceUri: UI_RESOURCE_URI } },
		} as unknown as Tool,
		{
			name: "list_issues",
			description: "List issues (no UI app)",
			inputSchema: { type: "object", properties: {} },
		},
	];
	return {
		getConfig: () => ({ name: "github", transport: "stdio", command: "x" }) as MCPServerConfig,
		isConnected: () => true,
		listTools: async () => tools,
		listResources: async () => [],
		listPrompts: async () => [],
		callTool: async (name: string) => ({
			content: `result of ${name}`,
			isError: false,
		}),
		readResource: async (uri: string) => ({ uri, content: "" }),
		invokePrompt: async () => ({ messages: [] }),
		connect: async () => {},
		disconnect: async () => {},
		getServerDescription: () => "GitHub MCP server",
		getServerInstructions: () => undefined,
		getServerInfo: () => undefined,
	} as unknown as MCPClient;
}

function makeCtx(db: Database): AppContext {
	return {
		db,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		eventBus: { on: () => {}, off: () => {}, emit: () => {} },
		hostName: "test-host",
		siteId: "test-site-id",
	} as unknown as AppContext;
}

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
}

describe("MCP App binding persisted to tool_result metadata", () => {
	let tmpDir: string;
	let db: Database;
	let threadId: string;
	// loopSandbox built from the real github command, mirroring the
	// agent-factory exec wrapper (loopContextStorage.run + side-channel lift).
	let sandbox: { exec: (cmd: string) => Promise<unknown> };

	beforeAll(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "mcp-app-binding-"));
		db = createDatabase(join(tmpDir, "test.db"));
		applySchema(db);
		applyMetricsSchema(db);
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[randomUUID(), "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		const clients = new Map<string, MCPClient>([["github", makeFakeGithubClient()]]);
		const { commands } = await generateMCPCommands(clients);
		const ctx = {
			db,
			siteId: "test-site-id",
			eventBus: new TypedEventEmitter(),
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		};
		const customCommands = createDefineCommands(commands, ctx as never);
		const fs = new InMemoryFs();
		const bash = new Bash({ fs, customCommands });

		// Replicate the production agent-factory exec wrapper: run inside a
		// loopContextStorage scope so command handlers can stash the binding,
		// then lift store.mcpApp onto the returned result.
		sandbox = {
			exec: async (cmd: string) => {
				const store: {
					threadId?: string;
					taskId?: string;
					relayRequest?: unknown;
					mcpApp?: unknown;
				} = { threadId: "test-thread", taskId: undefined };
				const result = await loopContextStorage.run(store, () => bash.exec(cmd));
				if (store.mcpApp) {
					return { ...(result as object), mcpApp: store.mcpApp };
				}
				return result;
			},
		};
	});

	beforeEach(() => {
		threadId = randomUUID();
	});

	afterAll(async () => {
		db.close();
		if (tmpDir) await cleanupTmpDir(tmpDir);
	});

	it("stamps {server, tool, uiResourceUri} on the tool_result row for a UI-bearing tool", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-1", "github get_me", "done");

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		const row = db
			.query(
				"SELECT id FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId) as { id: string } | null;
		expect(row).not.toBeNull();

		const meta = readMessageMetadata(db, (row as { id: string }).id);
		expect(meta?.mcp_app).toEqual({
			server: "github",
			tool: "get_me",
			uiResourceUri: UI_RESOURCE_URI,
		});
	});

	it("does not stamp mcp_app for a tool with no UI binding", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-2", "github list_issues", "done");

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		const row = db
			.query(
				"SELECT id FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId) as { id: string } | null;
		expect(row).not.toBeNull();

		const meta = readMessageMetadata(db, (row as { id: string }).id);
		expect(meta?.mcp_app).toBeUndefined();
	});
});
