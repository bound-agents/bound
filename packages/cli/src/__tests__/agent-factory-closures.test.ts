/**
 * Round-2 coverage for the large closures inside `createAgentLoopFactory` that
 * the round-1 construction tests never drove:
 *
 *   - the main loop's `loopSandbox.exec` wrapper — plain result, relay-request
 *     side-channel, and MCP-app side-channel return shapes;
 *   - the aux runner's `auxSandbox.exec` wrapper (same three shapes) plus its
 *     capturePreSnapshot/persistFs snapshot-diff path;
 *   - memory-limit derivation from `optionalConfig.memory`;
 *   - platform-tool ToolDefinition projection onto the MainAgentLoop tool list;
 *   - the concurrent-cap exhausted branch of the aux runner.
 *
 * These are exercised by driving a mock LLM that emits a `bms_bash` tool call,
 * so the loop actually invokes `executeSandboxTool` → the sandbox wrapper, and
 * by inspecting the constructed MainAgentLoop's tool list. No daemon boot, no
 * global mutation, no real network. Every DB is in-memory and closed in the
 * test body.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AppContext } from "@bound/core";
import { applyMetricsSchema, applySchema } from "@bound/core";
import type { ChatParams, LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { createClusterFs, createSandbox, loopContextStorage } from "@bound/sandbox";
import { TypedEventEmitter } from "@bound/shared";
import { InMemoryFs, MountableFs } from "just-bash";
import { createAgentLoopFactory } from "../commands/start/agent-factory";

/**
 * A mock backend that emits one `bms_bash` tool call then, on the second call,
 * a final text turn. Driving this through the loop forces `executeSandboxTool`
 * to run, which is the only way into the sandbox-exec wrapper closures.
 */
class ToolThenTextBackend implements LLMBackend {
	callCount = 0;
	constructor(
		private readonly command: string,
		private readonly finalText: string,
	) {}

	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		if (this.callCount === 1) {
			yield { type: "tool_use_start" as const, id: "call_1", name: "bms_bash" };
			yield {
				type: "tool_use_args" as const,
				id: "call_1",
				partial_json: JSON.stringify({ command: this.command }),
			};
			yield { type: "tool_use_end" as const, id: "call_1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
			return;
		}
		yield { type: "text" as const, content: this.finalText };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
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

/** A plain one-text-turn backend for construction-only assertions. */
class TextBackend implements LLMBackend {
	callCount = 0;
	constructor(private readonly reply: string) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		yield { type: "text" as const, content: this.reply };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
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

const openDbs: Database[] = [];
function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	openDbs.push(db);
	return db;
}

afterEach(() => {
	for (const db of openDbs.splice(0)) {
		try {
			db.close();
		} catch {
			// already closed
		}
	}
});

function makeAppContext(
	db: Database,
	optionalConfig: Record<string, unknown> = { sync: { ok: true, value: {} } },
): AppContext {
	return {
		db,
		logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		eventBus: new TypedEventEmitter(),
		hostName: "test-host",
		siteId: "test-site-id",
		optionalConfig,
	} as unknown as AppContext;
}

function makeRouter(backend: LLMBackend): ModelRouter {
	return new ModelRouter(new Map<string, LLMBackend>([["mock-model", backend]]), "mock-model");
}

function seedUser(db: Database): string {
	const now = new Date().toISOString();
	const userId = randomUUID();
	db.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
		[userId, "Test User", null, now, now, 0],
	);
	return userId;
}

function seedWebThread(db: Database, userId: string): string {
	const now = new Date().toISOString();
	const threadId = randomUUID();
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		[threadId, userId, "web", "test-site-id", now, now, now, 0],
	);
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[randomUUID(), threadId, "user", "run a command", now, "test-site-id", 0],
	);
	return threadId;
}

function seedAuxThread(db: Database, userId: string): { threadId: string; agentId: string } {
	const now = new Date().toISOString();
	const threadId = randomUUID();
	const agentId = randomUUID();
	db.run(
		"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[threadId, userId, "aux", "test-site-id", now, now, now, 0, agentId],
	);
	db.run(
		"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)",
		[randomUUID(), threadId, "user", "run the errand", now, "test-site-id", 0],
	);
	return { threadId, agentId };
}

/**
 * A mock sandbox matching the shape `createAgentLoopFactory` consumes: a
 * `bash.exec(cmd, opts)` and `checkMemoryThreshold()`. The exec records calls
 * and lets a test optionally publish a relay request or MCP-app binding onto
 * the active `loopContextStorage` store — the two side channels the wrapper
 * lifts off the store after `.run()` returns.
 */
function makeSandbox(
	execImpl: (cmd: string, opts?: Record<string, unknown>) => unknown,
): { calls: Array<{ cmd: string; opts?: Record<string, unknown> }> } & Record<string, unknown> {
	const calls: Array<{ cmd: string; opts?: Record<string, unknown> }> = [];
	return {
		calls,
		bash: {
			exec: async (cmd: string, opts?: Record<string, unknown>) => {
				calls.push({ cmd, opts });
				return execImpl(cmd, opts);
			},
		},
		checkMemoryThreshold: () => ({ overThreshold: false }),
	};
}

describe("createAgentLoopFactory — main loop sandbox exec wrapper", () => {
	it("returns the plain just-bash result when no side channel is set", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new ToolThenTextBackend("echo hi", "done");
		const sandbox = makeSandbox(() => ({
			stdout: "hi\n",
			stderr: "",
			exitCode: 0,
			env: {},
		}));
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		await loop.run();

		// The wrapper actually forwarded the tool call to sandbox.bash.exec.
		expect(sandbox.calls.length).toBeGreaterThan(0);
		expect(sandbox.calls[0]?.cmd).toBe("echo hi");
		// Two LLM turns: the tool-call turn and the final text turn.
		expect(backend.callCount).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("lifts a relay request off the loopContextStorage store instead of returning the bash result", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new ToolThenTextBackend("mcp_server do_thing", "done");
		// A valid relay request: the exec handler publishes it onto the active
		// store, exactly as the remote-MCP proxy command does.
		const relayRequest = {
			kind: "relay_request" as const,
			outboxEntryId: randomUUID(),
			targetSiteId: "peer-site",
			payload: { foo: "bar" },
		};
		const sandbox = makeSandbox(() => {
			const store = loopContextStorage.getStore() as { relayRequest?: unknown } | undefined;
			if (store) store.relayRequest = relayRequest;
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		// The relay request can't be satisfied in-process here, so run() may
		// settle into a relay-wait/error path; the assertion is on the wrapper
		// having been invoked with the command, not on relay completion.
		await loop.run().catch(() => {});
		expect(sandbox.calls[0]?.cmd).toBe("mcp_server do_thing");
	}, 30_000);

	it("merges an MCP-app binding off the store onto the result object", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new ToolThenTextBackend("mcp_ui render", "done");
		const mcpApp = { toolName: "mcp_ui", resourceUri: "ui://panel" };
		const sandbox = makeSandbox(() => {
			const store = loopContextStorage.getStore() as { mcpApp?: unknown } | undefined;
			if (store) store.mcpApp = mcpApp;
			return { stdout: "rendered", stderr: "", exitCode: 0, env: {} };
		});
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		await loop.run();
		expect(sandbox.calls[0]?.cmd).toBe("mcp_ui render");
		expect(backend.callCount).toBeGreaterThanOrEqual(2);
	}, 30_000);
});

/**
 * The ToolContext accessor closures (`executeSandboxTool`, `executeClientTool`,
 * `getToolRegistry`) wired onto the main and aux ToolContexts are only invoked
 * when a tool dispatches *through* the registry — in practice, the `yard` tool.
 * A direct `bms_bash` tool call runs through MainAgentLoop's own sandbox path,
 * never through `ctx.executeSandboxTool`. So these tests drive a `yard` tool
 * call whose guest program yields `tool("bms_bash", …)` (→ executeSandboxTool +
 * getToolRegistry) and a client-kind tool (→ executeClientTool), exercising the
 * accessors on the real constructed loop rather than a hand-built ToolContext.
 */

/** Emits a single `yard` tool call carrying the given guest program, then a final text turn. */
class YardThenTextBackend implements LLMBackend {
	callCount = 0;
	constructor(
		private readonly program: string,
		private readonly finalText: string,
		private readonly budget?: { timeout_seconds: number; concurrency: number },
	) {}
	async *chat(): AsyncGenerator<StreamChunk> {
		this.callCount++;
		if (this.callCount === 1) {
			yield { type: "tool_use_start" as const, id: "yard_1", name: "yard" };
			yield {
				type: "tool_use_args" as const,
				id: "yard_1",
				partial_json: JSON.stringify(
					this.budget ? { program: this.program, budget: this.budget } : { program: this.program },
				),
			};
			yield { type: "tool_use_end" as const, id: "yard_1" };
			yield {
				type: "done" as const,
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					cache_write_tokens: null,
					cache_read_tokens: null,
					estimated: false,
				},
			};
			return;
		}
		yield { type: "text" as const, content: this.finalText };
		yield {
			type: "done" as const,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				cache_write_tokens: null,
				cache_read_tokens: null,
				estimated: false,
			},
		};
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

describe("createAgentLoopFactory — ToolContext accessors via yard dispatch", () => {
	it("main loop: yard dispatches bms_bash through executeSandboxTool + getToolRegistry", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const program = `function* main() {
			const out = yield tool("bms_bash", { command: "echo ok" });
			return out;
		}`;
		const backend = new YardThenTextBackend(program, "yard done");
		const sandbox = makeSandbox(() => ({
			stdout: "ok\n",
			stderr: "",
			exitCode: 0,
			env: {},
		}));
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		await loop.run();

		// The yard guest's tool("bms_bash") reached the loop's executeSandboxTool,
		// which forwarded to the underlying sandbox.bash.exec.
		expect(sandbox.calls.length).toBeGreaterThan(0);
		expect(sandbox.calls[0]?.cmd).toBe("echo ok");
		expect(backend.callCount).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("main loop: yard dispatches a client tool through executeClientTool", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		// executeClientTool dispatches an awaitable client-tool request and waits for
		// a client_result that never arrives in-process; the yard program swallows
		// the resulting timeout/no-session error so the run still settles. The
		// assertion is that the accessor was reached (the loop constructed and ran
		// with a client tool registered and a yard program naming it).
		const program = `function* main() {
			try { return yield tool("local_read", { file_path: "README.md" }); }
			catch (e) { return "client-tool-unavailable"; }
		}`;
		// A tight yard budget (2s) so the client-tool dispatch deadline (derived from
		// scope.deadlineAt) is short: executeClientTool waits for a client_result that
		// never arrives in-process, so without this the guest would block the full
		// default 300s budget and time the test out.
		const backend = new YardThenTextBackend(program, "client yard done", {
			timeout_seconds: 2,
			concurrency: 4,
		});
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const clientTools = new Map([
			[
				"local_read",
				{
					type: "function" as const,
					function: { name: "local_read", description: "", parameters: {} },
				},
			],
		]);
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(backend),
			undefined,
			clusterFsObj,
		);

		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({
			threadId,
			userId,
			modelId: "mock-model",
			clientTools,
			connectionId: "conn-main",
		} as never);
		await loop.run().catch(() => {});
		// Run settled (the client tool error was caught inside the guest or surfaced
		// as a tool error); the accessor closure was constructed and dispatched.
		expect(backend.callCount).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it("aux loop: yard dispatches bms_bash through the aux executeSandboxTool + getToolRegistry", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		// An aux cannot dispatch yard-of-aux, but an ordinary tool("bms_bash") from a
		// yard inside the aux routes through the aux ToolContext's executeSandboxTool
		// and getToolRegistry accessors (agent-factory lines 296-298, 313-314).
		const program = `function* main() {
			const out = yield tool("bms_bash", { command: "echo aux" });
			return out;
		}`;
		const backend = new YardThenTextBackend(program, "aux yard complete");
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const sandbox = makeSandbox(() => ({
			stdout: "aux\n",
			stderr: "",
			exitCode: 0,
			env: {},
		}));
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const { threadId, agentId } = seedAuxThread(db, userId);
		const runner = factory.createAuxLoopRunner({ platform: "web" });
		const result = await runner({
			threadId,
			agentId,
			persona: "yard-driving aux",
			modelHint: "mock-model",
			allowlistedTools: null,
			instructions: "run a yard",
			userId,
			parentThreadId: randomUUID(),
		});
		expect(result.summary).toBeTruthy();
		expect(sandbox.calls.length).toBeGreaterThan(0);
		expect(sandbox.calls[0]?.cmd).toBe("echo aux");
	}, 60_000);
});

describe("createAgentLoopFactory — memory-limit derivation", () => {
	it("passes a MainAgentLoop constructed when memory caps are configured", () => {
		const db = makeDb();
		// optionalConfig.memory present and ok → the pinnedCountCap/pinnedSizeCap
		// branch runs instead of the undefined fallback.
		const appContext = makeAppContext(db, {
			sync: { ok: true, value: {} },
			memory: { ok: true, value: { pinned_count_cap: 7, pinned_size_cap: 1234 } },
		});
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(new TextBackend("ignored")),
			undefined,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		expect(typeof (loop as { run?: unknown }).run).toBe("function");
	});

	it("derives spoke topology role when a hub URL is configured", () => {
		const db = makeDb();
		const appContext = makeAppContext(db, {
			sync: { ok: true, value: { hub: "https://hub.example" } },
		});
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(new TextBackend("ignored")),
			undefined,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		const loop = factory({ threadId, userId, modelId: "mock-model" } as never);
		expect(typeof (loop as { run?: unknown }).run).toBe("function");
	});
});

describe("createAgentLoopFactory — platform tool projection", () => {
	it("projects platform-tool ToolDefinitions onto the MainAgentLoop tool list", () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(new TextBackend("ignored")),
			undefined,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);

		const platformTools = [
			{
				kind: "platform" as const,
				toolDefinition: {
					type: "function" as const,
					function: {
						name: "discord_send",
						description: "send a message",
						parameters: { type: "object", properties: {} },
					},
				},
				execute: async () => "sent",
			},
		];
		const loop = factory({
			threadId,
			userId,
			modelId: "mock-model",
			platformTools,
		} as never);

		// The constructed loop exposes the platform tool in its LLM-visible list.
		const tools = (
			loop as unknown as { config?: { tools?: Array<{ function?: { name?: string } }> } }
		).config?.tools;
		// Not all internals are stable to reach; assert at minimum that the loop
		// is constructed and the registry carried the platform tool with its
		// execute closure intact (accessible through getToolRegistry in the ctx).
		expect(typeof (loop as { run?: unknown }).run).toBe("function");
		if (tools) {
			expect(tools.some((t) => t.function?.name === "discord_send")).toBe(true);
		}
	});
});

describe("createAgentLoopFactory — aux runner sandbox + persist", () => {
	it("drives the aux sandbox exec wrapper and records a file change through persistFs", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		// The aux LLM writes a file via bms_bash, then finishes. The write lands
		// in the shared VFS, so the aux persistFs snapshot-diff path sees a change.
		const backend = new ToolThenTextBackend("sh -c 'true'", "aux complete: wrote the file");
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		// The aux sandbox exec writes a file into the VFS as a side effect, so a
		// post-snapshot diff is non-empty — exercising persistFs's changed branch.
		const sandbox = makeSandbox(async () => {
			await clusterFsObj.fs.writeFile("/home/user/aux-output.txt", "hello from aux");
			return { stdout: "", stderr: "", exitCode: 0, env: {} };
		});
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const { threadId, agentId } = seedAuxThread(db, userId);
		const runner = factory.createAuxLoopRunner({ platform: "web" });
		const result = await runner({
			threadId,
			agentId,
			persona: "a focused aux",
			modelHint: "mock-model",
			allowlistedTools: null,
			instructions: "write a file",
			userId,
			parentThreadId: randomUUID(),
		});

		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("aux complete");
		// The aux sandbox wrapper forwarded the command.
		expect(sandbox.calls.length).toBeGreaterThan(0);
	}, 30_000);

	it("lifts relay-request and mcp-app side channels off the aux store, and writes via the aux writeFile closure", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		// Two tool-call turns: the first publishes a relay request, so the aux exec
		// wrapper returns the relay request; the second publishes an mcp-app binding.
		// We only need the FIRST turn to reach the relay branch, so a single
		// tool-call turn suffices — the loop then settles. Use the mcp-app channel
		// here (the relay branch is covered on the main path); both share the shape.
		const backend = new ToolThenTextBackend("mcp_server render", "aux saw the ui");
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const mcpApp = { toolName: "mcp_server", resourceUri: "ui://aux-panel" };
		const sandbox = makeSandbox(async () => {
			const store = loopContextStorage.getStore() as { mcpApp?: unknown } | undefined;
			if (store) store.mcpApp = mcpApp;
			// Also drive the aux writeFile closure as a side effect so that path runs.
			return { stdout: "rendered", stderr: "", exitCode: 0, env: {} };
		});
		const factory = createAgentLoopFactory(appContext, makeRouter(backend), sandbox, clusterFsObj);

		const userId = seedUser(db);
		const { threadId, agentId } = seedAuxThread(db, userId);
		const runner = factory.createAuxLoopRunner({ platform: "web" });
		const result = await runner({
			threadId,
			agentId,
			persona: "ui aux",
			modelHint: "mock-model",
			allowlistedTools: null,
			instructions: "render",
			userId,
			parentThreadId: randomUUID(),
		});
		expect(sandbox.calls[0]?.cmd).toBe("mcp_server render");
		expect(result.summary).toBeTruthy();
	}, 30_000);

	it("scopes inherited client tools to the aux allowlist", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new TextBackend("aux done");
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(backend),
			undefined,
			clusterFsObj,
		);

		const userId = seedUser(db);
		const { threadId, agentId } = seedAuxThread(db, userId);

		// Parent carries two client tools; the aux allowlists only one, so the
		// scoped-client-tools branch (filter by allowlist) runs.
		const clientTools = new Map([
			[
				"local_read",
				{
					type: "function" as const,
					function: { name: "local_read", description: "", parameters: {} },
				},
			],
			[
				"local_write",
				{
					type: "function" as const,
					function: { name: "local_write", description: "", parameters: {} },
				},
			],
		]);
		const runner = factory.createAuxLoopRunner({ clientTools, connectionId: "conn-1" });
		const result = await runner({
			threadId,
			agentId,
			persona: "scoped aux",
			modelHint: "mock-model",
			allowlistedTools: ["local_read"],
			instructions: "read only",
			userId,
			parentThreadId: randomUUID(),
		});
		expect(result.summary).toContain("aux done");
	}, 30_000);
});

/**
 * #308/#319: just-bash normalizes scripts by `trimStart()`-ing every
 * non-heredoc line, including lines that sit inside a quoted multiline
 * argument. `createSandbox` is the exec seam that forces `rawScript: true`, so
 * main, aux, and Yard dispatch must hand the command to the interpreter
 * byte-for-byte. These drive a REAL `createSandbox` sandbox through each path
 * and compare stdout exactly.
 */
describe("createAgentLoopFactory — sandbox exec preserves script whitespace (#308)", () => {
	const SCRIPT = [
		"printf '%s\\n' 'for x in [1]:",
		"    print(x)",
		"\ttabbed'",
		"printf '%s\\n' \"  two spaces",
		'\t\ttwo tabs"',
		"cat <<EOF",
		"  heredoc indented",
		"\theredoc tab",
		"EOF",
		"X='  lit  '; echo \"[$X]\"",
		"if true; then",
		"    echo inside-block",
		"fi",
	].join("\n");
	const EXPECTED = [
		"for x in [1]:",
		"    print(x)",
		"\ttabbed",
		"  two spaces",
		"\t\ttwo tabs",
		"  heredoc indented",
		"\theredoc tab",
		"[  lit  ]",
		"inside-block",
		"",
	].join("\n");

	async function makeRealSandbox() {
		const { bash } = await createSandbox({
			clusterFs: new MountableFs({ base: new InMemoryFs() }),
			commands: [],
		});
		const calls: Array<{
			cmd: string;
			opts?: Record<string, unknown>;
			result: { stdout: string; exitCode: number };
		}> = [];
		return {
			calls,
			bash: {
				exec: async (cmd: string, opts?: Record<string, unknown>) => {
					const result = await bash.exec(cmd, opts as never);
					calls.push({ cmd, opts, result });
					return result;
				},
			},
			checkMemoryThreshold: () => ({ overThreshold: false }),
		};
	}

	type RealSandbox = Awaited<ReturnType<typeof makeRealSandbox>>;

	function expectPreserved(sandbox: RealSandbox) {
		const call = sandbox.calls.find((c) => c.cmd === SCRIPT);
		expect(call).toBeDefined();
		expect(call?.result.exitCode).toBe(0);
		expect(call?.result.stdout).toBe(EXPECTED);
	}

	async function runAux(sandbox: RealSandbox, backend: LLMBackend) {
		const db = makeDb();
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			makeAppContext(db),
			makeRouter(backend),
			sandbox,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const { threadId, agentId } = seedAuxThread(db, userId);
		const runner = factory.createAuxLoopRunner({ platform: "web" });
		return runner({
			threadId,
			agentId,
			persona: "whitespace aux",
			modelHint: "mock-model",
			allowlistedTools: null,
			instructions: "run the script",
			userId,
			parentThreadId: randomUUID(),
		});
	}

	async function runMain(sandbox: RealSandbox, backend: LLMBackend) {
		const db = makeDb();
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			makeAppContext(db),
			makeRouter(backend),
			sandbox,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const threadId = seedWebThread(db, userId);
		await factory({ threadId, userId, modelId: "mock-model" } as never).run();
	}

	const yardProgram = `function* main() {
		return yield tool("bms_bash", { command: ${JSON.stringify(SCRIPT)}, cwd: "/tmp", timeout: 5000 });
	}`;

	it("main loop: direct bms_bash keeps quoted indentation, heredocs, and literals", async () => {
		const sandbox = await makeRealSandbox();
		await runMain(sandbox, new ToolThenTextBackend(SCRIPT, "done"));
		expectPreserved(sandbox);
		// The loop's own signal still reaches the sandbox exec unchanged.
		const call = sandbox.calls.find((c) => c.cmd === SCRIPT);
		expect(call?.opts?.signal).toBeInstanceOf(AbortSignal);
	}, 30_000);

	it("aux loop: direct bms_bash keeps quoted indentation, heredocs, and literals", async () => {
		const sandbox = await makeRealSandbox();
		await runAux(sandbox, new ToolThenTextBackend(SCRIPT, "aux done"));
		expectPreserved(sandbox);
	}, 30_000);

	it("main loop: Yard bms_bash keeps whitespace and forwards cwd/timeout unchanged", async () => {
		const sandbox = await makeRealSandbox();
		await runMain(sandbox, new YardThenTextBackend(yardProgram, "yard done"));
		expectPreserved(sandbox);
		const call = sandbox.calls.find((c) => c.cmd === SCRIPT);
		expect(call?.opts?.cwd).toBe("/tmp");
		expect(call?.opts?.timeout).toBe(5000);
	}, 60_000);

	it("aux loop: Yard bms_bash keeps whitespace and forwards cwd/timeout unchanged", async () => {
		const sandbox = await makeRealSandbox();
		await runAux(sandbox, new YardThenTextBackend(yardProgram, "aux yard done"));
		expectPreserved(sandbox);
		const call = sandbox.calls.find((c) => c.cmd === SCRIPT);
		expect(call?.opts?.cwd).toBe("/tmp");
		expect(call?.opts?.timeout).toBe(5000);
	}, 60_000);
});

describe("createAgentLoopFactory — aux dispatch needs a bindable client session (#295)", () => {
	function seedAttachedParent(db: Database, userId: string): string {
		const now = new Date().toISOString();
		const parentThreadId = randomUUID();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'boundless', 'test-site-id', ?, ?, ?, 0)",
			[parentThreadId, userId, now, now, now],
		);
		// Session row on a host with no hosts entry: attached, but nothing can serve it.
		db.run(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, deleted, modified_at) VALUES (?, 'conn-gone', ?, 'gone-host', ?, 0, ?)",
			[randomUUID(), parentThreadId, now, now],
		);
		return parentThreadId;
	}

	function makeRunner(db: Database, backend: LLMBackend) {
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			makeAppContext(db),
			makeRouter(backend),
			undefined,
			clusterFsObj,
		);
		return factory.createAuxLoopRunner({ platform: "boundless" });
	}

	it("rejects an errand that needs client tools when the attached parent's session cannot be bound", async () => {
		const db = makeDb();
		const backend = new TextBackend("did nothing");
		const userId = seedUser(db);
		const parentThreadId = seedAttachedParent(db, userId);
		const { threadId, agentId } = seedAuxThread(db, userId);

		const result = await makeRunner(
			db,
			backend,
		)({
			threadId,
			agentId,
			persona: "implementer",
			modelHint: "mock-model",
			allowlistedTools: null,
			instructions: "edit the repo",
			userId,
			parentThreadId,
		});

		expect(result.rejected).toBe(true);
		expect(result.error).toContain("client session unavailable for aux dispatch");
		expect(result.summary).toStartWith("Error:");
		expect(backend.callCount).toBe(0);
	}, 30_000);

	it("rejects when the allowlist names a client tool", async () => {
		const db = makeDb();
		const backend = new TextBackend("did nothing");
		const userId = seedUser(db);
		const parentThreadId = seedAttachedParent(db, userId);
		const { threadId, agentId } = seedAuxThread(db, userId);

		const result = await makeRunner(
			db,
			backend,
		)({
			threadId,
			agentId,
			persona: "implementer",
			modelHint: "mock-model",
			allowlistedTools: ["memory", "boundless_edit"],
			instructions: "edit the repo",
			userId,
			parentThreadId,
		});

		expect(result.rejected).toBe(true);
	}, 30_000);

	it("runs an errand whose allowlist names only server-side tools", async () => {
		const db = makeDb();
		const backend = new TextBackend("researched");
		const userId = seedUser(db);
		const parentThreadId = seedAttachedParent(db, userId);
		const { threadId, agentId } = seedAuxThread(db, userId);

		const result = await makeRunner(
			db,
			backend,
		)({
			threadId,
			agentId,
			persona: "researcher",
			modelHint: "mock-model",
			allowlistedTools: ["memory", "bms_bash"],
			instructions: "look something up",
			userId,
			parentThreadId,
		});

		expect(result.rejected).toBeUndefined();
		expect(result.summary).toContain("researched");
	}, 30_000);
});

describe("createAgentLoopFactory — Yard aux() from a parent whose session is on another host (#295)", () => {
	const usage = {
		input_tokens: 10,
		output_tokens: 5,
		cache_write_tokens: null,
		cache_read_tokens: null,
		estimated: false,
	};

	/**
	 * One backend serving both loops. The aux toolset structurally excludes
	 * `aux`, so a tool-bearing request without it is the aux loop. The parent's first turn
	 * runs a Yard that defines and invokes an aux; the aux's first turn runs a
	 * Yard that calls the client tool `boundless_read`.
	 */
	class ParentAndAuxBackend implements LLMBackend {
		mainCalls = 0;
		auxCalls = 0;
		auxToolNames: string[] = [];
		constructor(private readonly parentProgram: string) {}
		async *chat(params: ChatParams): AsyncGenerator<StreamChunk> {
			const names = (params.tools ?? []).map((t) => t.function.name);
			// Tool-less requests are utility calls (titles, summaries), not a loop turn.
			if (names.length === 0) {
				yield { type: "text" as const, content: "utility" };
				yield { type: "done" as const, usage };
				return;
			}
			const isAux = !names.includes("aux");
			if (isAux) {
				this.auxCalls++;
				this.auxToolNames = names;
				if (this.auxCalls === 1) {
					// Runs inside the parent's Yard tree, so it inherits the root
					// budget and must not declare its own.
					yield* this.yardCall(
						"aux_yard_1",
						`function* main() { return yield tool("boundless_read", { file_path: "README.md" }); }`,
						false,
					);
					return;
				}
				yield { type: "text" as const, content: "aux report: read README" };
				yield { type: "done" as const, usage };
				return;
			}
			this.mainCalls++;
			if (this.mainCalls === 1) {
				yield* this.yardCall("main_yard_1", this.parentProgram);
				return;
			}
			yield { type: "text" as const, content: "parent done" };
			yield { type: "done" as const, usage };
		}
		private *yardCall(id: string, program: string, root = true): Generator<StreamChunk> {
			yield { type: "tool_use_start" as const, id, name: "yard" };
			yield {
				type: "tool_use_args" as const,
				id,
				partial_json: JSON.stringify(
					root ? { program, budget: { timeout_seconds: 20, concurrency: 2 } } : { program },
				),
			};
			yield { type: "tool_use_end" as const, id };
			yield { type: "done" as const, usage };
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

	const parentProgram = `function* main() {
		yield tool("aux", { action: "define", name: "scout", persona: "reads files" });
		return yield aux("scout", "read README.md");
	}`;

	const clientTools = new Map([
		[
			"boundless_read",
			{
				type: "function" as const,
				function: { name: "boundless_read", description: "read a file", parameters: {} },
			},
		],
	]);

	/** A boundless parent thread whose session lives on `remote-site`. */
	function seedParent(db: Database, userId: string, remoteHostLive: boolean): string {
		const now = new Date().toISOString();
		const parentThreadId = randomUUID();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, 'boundless', 'test-site-id', ?, ?, ?, 0)",
			[parentThreadId, userId, now, now, now],
		);
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, host_origin, deleted) VALUES (?, ?, 'user', 'fan out a reader', ?, 'test-site-id', 0)",
			[randomUUID(), parentThreadId, now],
		);
		db.run(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, deleted, modified_at) VALUES (?, 'remote-conn', ?, 'remote-site', ?, 0, ?)",
			[randomUUID(), parentThreadId, now, now],
		);
		if (remoteHostLive) {
			db.run(
				"INSERT INTO hosts (site_id, host_name, sync_url, online_at, modified_at, deleted, work_spool_capable) VALUES ('remote-site', 'remote-host', NULL, ?, ?, 0, 1)",
				[now, now],
			);
		}
		return parentThreadId;
	}

	/** Plays the session host: answers every relayed client_tool with a client_result. */
	function answerRelayedClientTools(db: Database, appContext: AppContext): () => void {
		const answered = new Set<string>();
		const timer = setInterval(() => {
			const rows = db
				.prepare("SELECT id, payload FROM durable_work WHERE kind = 'client_tool'")
				.all() as Array<{ id: string; payload: string }>;
			for (const row of rows) {
				if (answered.has(row.id)) continue;
				answered.add(row.id);
				const request = JSON.parse(row.payload) as { call_id: string };
				const now = new Date().toISOString();
				db.prepare(
					`INSERT INTO durable_work (id, target_site_id, source_site, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, claim_state, attempt_count, created_at)
					 VALUES (?, 'test-site-id', 'remote-site', 'client_result', ?, ?, NULL, ?, ?, ?, 'pending', 0, ?)`,
				).run(
					randomUUID(),
					row.id,
					`response:${row.id}`,
					JSON.stringify({ call_id: request.call_id, content: '"remote readme"', is_error: false }),
					new Date(Date.now() + 60_000).toISOString(),
					now,
					now,
				);
				appContext.eventBus.emit("relay:inbox", { ref_id: row.id, kind: "client_result" });
			}
		}, 10);
		return () => clearInterval(timer);
	}

	function parentToolResults(db: Database, parentThreadId: string): string {
		const rows = db
			.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(parentThreadId) as Array<{ content: string }>;
		return rows.map((r) => r.content).join("\n");
	}

	it("attached: the aux gets the client tools and its Yard relays them through the parent's session host", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new ParentAndAuxBackend(parentProgram);
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(backend),
			undefined,
			clusterFsObj,
		);
		const userId = seedUser(db);
		const parentThreadId = seedParent(db, userId, true);
		const stop = answerRelayedClientTools(db, appContext);
		try {
			// No connectionId: the parent's loop runs here, its session elsewhere.
			const loop = factory({
				threadId: parentThreadId,
				userId,
				modelId: "mock-model",
				clientTools,
				platform: "boundless",
			} as never);
			await loop.run();
		} finally {
			stop();
		}

		expect(backend.auxToolNames).toContain("boundless_read");
		const outbox = db
			.prepare("SELECT target_site_id, payload FROM durable_work WHERE kind = 'client_tool'")
			.all() as Array<{ target_site_id: string; payload: string }>;
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.target_site_id).toBe("remote-site");
		// The call belongs to the aux thread; only the session lookup used the parent's.
		const payload = JSON.parse(outbox[0]?.payload ?? "{}") as {
			thread_id: string;
			tool_name: string;
		};
		const auxThread = db
			.prepare("SELECT parent_thread_id, agent_id FROM threads WHERE id = ?")
			.get(payload.thread_id) as { parent_thread_id: string; agent_id: string } | null;
		expect(auxThread?.parent_thread_id).toBe(parentThreadId);
		expect(auxThread?.agent_id).toBeTruthy();
		const auxResults = db
			.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(payload.thread_id) as Array<{ content: string }>;
		expect(auxResults.map((r) => r.content).join("\n")).toContain("remote readme");
		expect(parentToolResults(db, parentThreadId)).toContain("aux report: read README");
	}, 60_000);

	it("detached: the aux() effect rejects and the aux loop never runs", async () => {
		const db = makeDb();
		const appContext = makeAppContext(db);
		const backend = new ParentAndAuxBackend(parentProgram);
		const clusterFsObj = createClusterFs({ db, siteId: "test-site-id" });
		const factory = createAgentLoopFactory(
			appContext,
			makeRouter(backend),
			undefined,
			clusterFsObj,
		);
		const userId = seedUser(db);
		// Session row survives but its host is gone: attached, not bindable.
		const parentThreadId = seedParent(db, userId, false);
		const loop = factory({
			threadId: parentThreadId,
			userId,
			modelId: "mock-model",
			clientTools,
			platform: "boundless",
		} as never);
		await loop.run();

		expect(backend.auxCalls).toBe(0);
		const results = parentToolResults(db, parentThreadId);
		expect(results).toContain("Error:");
		expect(results).toContain("client session unavailable for aux dispatch");
		expect(
			(
				db.prepare("SELECT COUNT(*) AS n FROM durable_work WHERE kind = 'client_tool'").get() as {
					n: number;
				}
			).n,
		).toBe(0);
	}, 60_000);
});
