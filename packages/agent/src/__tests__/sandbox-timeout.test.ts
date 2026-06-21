/**
 * bms_bash timeout semantics: the sandbox dispatch derives a wall-clock ceiling
 * from the tool call's optional `timeout` arg (default 300000ms), fires an
 * AbortSignal at the deadline, and surfaces a 124 timeout result rather than
 * hanging. This pins the contract that aligns bms_bash with boundless_bash.
 *
 * Drives the real production path: ScriptedLLM emits a {command, timeout} tool
 * call → AgentLoop "sandbox" dispatch → execSandboxWithTimeout → mock exec that
 * honors opts.signal (mirroring just-bash's cooperative abort).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { AgentLoop } from "../agent-loop";
import type { RegisteredTool } from "../types";

const BASH_REGISTRY: Map<string, RegisteredTool> = new Map([
	[
		"bms_bash",
		{
			kind: "sandbox",
			toolDefinition: {
				type: "function",
				function: {
					name: "bms_bash",
					description: "Execute a command in the sandboxed shell.",
					parameters: {
						type: "object",
						properties: { command: { type: "string" }, timeout: { type: "number" } },
						required: ["command"],
					},
				},
			},
		} as RegisteredTool,
	],
]);

// Scripted LLM: one bms_bash tool call carrying {command, timeout}, then final text.
class ScriptedLLMBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	private idx = 0;

	toolThenText(toolId: string, input: Record<string, unknown>, finalText: string) {
		this.responses = [];
		this.responses.push(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: "bms_bash" };
			yield {
				type: "tool_use_args" as const,
				id: toolId,
				partial_json: JSON.stringify(input),
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

function createMockRouter(backend: LLMBackend): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("claude-opus", backend);
	return new ModelRouter(backends, "claude-opus");
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

/**
 * Mock sandbox exec that honors opts.signal the way just-bash does cooperatively:
 * a "slow" command never resolves on its own — it only settles when the signal
 * aborts (rejecting, as just-bash throws ExecutionAbortedError at the boundary).
 * Any other command resolves immediately.
 */
function makeSandbox(): {
	exec: (cmd: string, opts?: { signal?: AbortSignal }) => Promise<unknown>;
	lastOpts: { signal?: AbortSignal } | undefined;
} {
	const holder: { lastOpts: { signal?: AbortSignal } | undefined } = { lastOpts: undefined };
	return {
		lastOpts: undefined,
		exec: async (cmd: string, opts?: { signal?: AbortSignal }) => {
			holder.lastOpts = opts;
			// reflect back for assertions on signal plumbing
			(makeSandbox as unknown as { _last?: unknown })._last = opts;
			if (cmd === "slow") {
				return await new Promise((_resolve, reject) => {
					const sig = opts?.signal;
					if (sig?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					sig?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			}
			return { stdout: "ok", stderr: "", exitCode: 0 };
		},
	};
}

describe("bms_bash timeout dispatch", () => {
	let db: Database;
	let threadId: string;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[randomUUID(), "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);
		threadId = randomUUID();
	});

	afterEach(() => {
		db.close();
	});

	function firstToolResult(): string {
		const row = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result' ORDER BY created_at ASC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		return row?.content ?? "";
	}

	it("aborts a command that exceeds the provided timeout and reports exit 124", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-1", { command: "slow", timeout: 20 }, "done");
		const sandbox = makeSandbox();

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		const content = firstToolResult();
		expect(content).toContain("timed out after 20ms");
	});

	it("passes a fast command straight through without timing out", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-2", { command: "echo hi", timeout: 20 }, "done");
		const sandbox = makeSandbox();

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		const content = firstToolResult();
		expect(content).toContain("ok");
		expect(content).not.toContain("timed out");
	});

	it("supplies an AbortSignal to exec even when no timeout arg is given", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-3", { command: "echo hi" }, "done");
		let sawSignal = false;
		const sandbox = {
			exec: async (_cmd: string, opts?: { signal?: AbortSignal }) => {
				sawSignal = opts?.signal instanceof AbortSignal;
				return { stdout: "ok", stderr: "", exitCode: 0 };
			},
		};

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		expect(sawSignal).toBe(true);
	});

	it("forwards the cwd arg into exec opts so just-bash scopes the run dir", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-4", { command: "pwd", cwd: "/home/user/pkg" }, "done");
		let sawCwd: unknown;
		const sandbox = {
			exec: async (_cmd: string, opts?: { cwd?: string }) => {
				sawCwd = opts?.cwd;
				return { stdout: "ok", stderr: "", exitCode: 0 };
			},
		};

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		expect(sawCwd).toBe("/home/user/pkg");
	});

	it("omits cwd from exec opts when no cwd arg is given", async () => {
		const backend = new ScriptedLLMBackend();
		backend.toolThenText("call-5", { command: "pwd" }, "done");
		let hadCwdKey = true;
		const sandbox = {
			exec: async (_cmd: string, opts?: Record<string, unknown>) => {
				hadCwdKey = !!opts && "cwd" in opts;
				return { stdout: "ok", stderr: "", exitCode: 0 };
			},
		};

		const loop = new AgentLoop(makeCtx(db), sandbox, createMockRouter(backend), {
			threadId,
			userId: "test-user",
			toolRegistry: BASH_REGISTRY,
		});
		await loop.run();

		expect(hadCwdKey).toBe(false);
	});
});
