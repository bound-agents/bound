import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema } from "@bound/core";
import type { ToolContext } from "../../types";
import { createAuxTool } from "../auxiliary";

function getExecute(tool: ReturnType<typeof createAuxTool>) {
	const execute = tool.execute;
	if (!execute) throw new Error("Tool execute is required");
	return execute;
}

describe("Native Aux Tool (invoke slice)", () => {
	let db: Database;
	const siteId = "test-site";
	let ctx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		// Insert a parent thread so findThreadUserAndInterfaceById succeeds
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted, model_hint, agent_id, parent_thread_id)
			 VALUES ('parent-thread', 'user-123', 'boundless', '${siteId}', 0, 'parent', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, NULL, NULL, NULL)`,
		);
		ctx = {
			db,
			siteId,
			threadId: "parent-thread",
			eventBus: {
				on: () => {},
				off: () => {},
				emit: () => {},
				once: () => {},
			} as any,
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			},
		} as ToolContext;
	});

	afterEach(() => {
		db.close();
	});

	describe("invoke validation", () => {
		it("requires name", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "invoke", instructions: "do something" });
			expect(out).toContain("'name' is required");
		});

		it("requires instructions", async () => {
			// Define the agent first so name validation passes
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test" });
			const out = await exec({ action: "invoke", name: "tama" });
			expect(out).toContain("'instructions' is required");
		});

		it("errors on unknown agent name", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "invoke", name: "ghost", instructions: "do something" });
			expect(out).toContain("no active auxiliary agent named 'ghost'");
		});

		it("errors on retired agent", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test" });
			await exec({ action: "retire", name: "tama" });
			const out = await exec({ action: "invoke", name: "tama", instructions: "do something" });
			expect(out).toContain("no active auxiliary agent named 'tama'");
		});

		it("rejects invalid name format", async () => {
			const exec = getExecute(createAuxTool(ctx));
			const out = await exec({ action: "invoke", name: "Bad Name!", instructions: "do something" });
			expect(out).toContain("Invalid aux name");
		});
	});

	describe("invoke thread creation (no loop runner)", () => {
		it("creates a child thread with agent_id and parent_thread_id", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test persona" });

			const out = await exec({
				action: "invoke",
				name: "tama",
				instructions: "go check the files",
			});

			// Without a loop runner, returns the thread handle
			expect(out).toContain("thread");
			expect(out).toContain("Loop runner not available");

			// Verify the thread was created with correct fields
			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const thread = db
				.query(
					"SELECT id, agent_id, parent_thread_id, interface, title FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.get(agent.id) as {
				id: string;
				agent_id: string;
				parent_thread_id: string;
				interface: string;
				title: string;
			} | null;

			expect(thread).not.toBeNull();
			expect(thread?.agent_id).toBe(agent.id);
			expect(thread?.parent_thread_id).toBe("parent-thread");
			expect(thread?.interface).toBe("aux");
			expect(thread?.title).toBe("aux: tama");
		});

		it("seeds instructions as a user message with sender_role=main", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test" });

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "go check the files",
			});

			// Find the seeded message
			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const thread = db
				.query("SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(agent.id) as { id: string };

			const msg = db
				.query(
					"SELECT role, content, metadata FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
				)
				.get(thread.id) as { role: string; content: string; metadata: string } | null;

			expect(msg).not.toBeNull();
			expect(msg?.content).toBe("go check the files");
			expect(msg?.metadata).toContain('"sender_role":"main"');
		});

		it("uses model override when provided", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test", model_hint: "haiku" });

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "do something",
				model: "sonnet",
			});

			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const thread = db
				.query("SELECT model_hint FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(agent.id) as { model_hint: string } | null;

			expect(thread?.model_hint).toBe("sonnet");
		});

		it("falls back to agent model_hint when no override", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test", model_hint: "haiku" });

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "do something",
			});

			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const thread = db
				.query("SELECT model_hint FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(agent.id) as { model_hint: string } | null;

			expect(thread?.model_hint).toBe("haiku");
		});

		it("inherits the parent thread's user_id", async () => {
			const exec = getExecute(createAuxTool(ctx));
			await exec({ action: "define", name: "tama", persona: "test" });

			// Parent thread already inserted by beforeEach with user_id='user-123'

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "do something",
			});

			const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as any;
			const thread = db
				.query("SELECT user_id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
				.get(agent.id) as { user_id: string } | null;

			expect(thread?.user_id).toBe("user-123");
		});
	});

	describe("invoke with loop runner", () => {
		it("calls auxLoopRunner and returns its summary", async () => {
			const exec = getExecute(
				createAuxTool({
					...ctx,
					auxLoopRunner: async () => ({
						summary: "aux completed: found 3 files",
					}),
				}),
			);
			await exec({ action: "define", name: "tama", persona: "test" });

			const out = await exec({
				action: "invoke",
				name: "tama",
				instructions: "count files",
			});

			// The summary carries a `Thread: <uuid>` trailer — the web chat view
			// parses it to render the aux-invocation card's thread link.
			expect(out).toContain("aux completed: found 3 files");
			expect(out).toMatch(/\n\nThread: [0-9a-f-]{36}$/);
		});

		it("returns error summary when loop runner errors", async () => {
			const exec = getExecute(
				createAuxTool({
					...ctx,
					auxLoopRunner: async () => ({
						summary: "",
						error: "model timeout",
					}),
				}),
			);
			await exec({ action: "define", name: "tama", persona: "test" });

			const out = await exec({
				action: "invoke",
				name: "tama",
				instructions: "count files",
			});

			expect(out).toContain("completed with error");
			expect(out).toContain("model timeout");
		});

		it("passes allowlisted tools from agent definition", async () => {
			let receivedTools: string[] | null = null;
			let receivedPersona = "";
			let receivedModelHint: string | null = null;

			const exec = getExecute(
				createAuxTool({
					...ctx,
					auxLoopRunner: async (params) => {
						receivedTools = params.allowlistedTools;
						receivedPersona = params.persona;
						receivedModelHint = params.modelHint;
						return { summary: "ok" };
					},
				}),
			);
			await exec({
				action: "define",
				name: "tama",
				persona: "methodical scout",
				tools: ["read", "grep", "memory"],
				model_hint: "haiku",
			});

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "search for X",
			});

			expect(receivedTools).toEqual(["read", "grep", "memory"]);
			expect(receivedPersona).toBe("methodical scout");
			expect(receivedModelHint).toBe("haiku");
		});

		it("passes null allowlistedTools when agent has no tool restriction", async () => {
			let receivedTools: string[] | null | undefined;
			const exec = getExecute(
				createAuxTool({
					...ctx,
					auxLoopRunner: async (params) => {
						receivedTools = params.allowlistedTools;
						return { summary: "ok" };
					},
				}),
			);
			await exec({ action: "define", name: "tama", persona: "test" });

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "do something",
			});

			expect(receivedTools).toBeNull();
		});

		it("passes model override to loop runner instead of agent default", async () => {
			let receivedModel: string | null = null;
			const exec = getExecute(
				createAuxTool({
					...ctx,
					auxLoopRunner: async (params) => {
						receivedModel = params.modelHint;
						return { summary: "ok" };
					},
				}),
			);
			await exec({ action: "define", name: "tama", persona: "test", model_hint: "haiku" });

			await exec({
				action: "invoke",
				name: "tama",
				instructions: "do something",
				model: "sonnet",
			});

			expect(receivedModel).toBe("sonnet");
		});
	});

	describe("invoke annotations", () => {
		it("marks invoke as non-idempotent and not read-only", () => {
			const tool = createAuxTool(ctx);
			const resolve = tool.resolveAnnotations;
			if (!resolve) throw new Error("resolveAnnotations expected");
			expect(resolve({ action: "invoke" })).toEqual({ idempotent: false, readOnly: false });
		});
	});
});

// #76 — tool backgrounding. `invoke` with `background: true` returns a
// DeferredToolResult instead of blocking on the nested loop. The loop writes a
// placeholder tool_result; when the aux finishes, resolveDeferredToolResult
// swaps in the real content and re-wakes the parent loop.
describe("invoke with background: true", () => {
	let db: Database;
	const siteId = "test-site";
	let ctx: ToolContext;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.run(
			`INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, summary_through, summary_model_id, extracted_through, created_at, last_message_at, modified_at, deleted, model_hint, agent_id, parent_thread_id)
			 VALUES ('parent-thread', 'user-123', 'boundless', '${siteId}', 0, 'parent', NULL, NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0, NULL, NULL, NULL)`,
		);
		ctx = {
			db,
			siteId,
			threadId: "parent-thread",
			eventBus: { on: () => {}, off: () => {}, emit: () => {}, once: () => {} } as any,
			logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
		} as ToolContext;
	});

	afterEach(() => {
		db.close();
	});

	it("returns a DeferredToolResult rather than the aux summary", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "aux completed: found 3 files" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		const out = await exec(
			{ action: "invoke", name: "tama", instructions: "search", background: true },
			"call-1",
		);

		expect(typeof out).toBe("object");
		expect((out as any).deferred).toBe(true);
		expect((out as any).description).toContain("tama");
		expect((out as any).description).toContain("background");
	});

	// The whole point: the parent loop must not be held at the junction while the
	// nested loop runs. execute() resolves before the runner does.
	it("returns before the nested loop completes", async () => {
		let released: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			released = resolve;
		});
		let runnerFinished = false;
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => {
					await gate;
					runnerFinished = true;
					return { summary: "late result" };
				},
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		const out = await exec(
			{ action: "invoke", name: "tama", instructions: "slow work", background: true },
			"call-slow",
		);

		expect((out as any).deferred).toBe(true);
		expect(runnerFinished).toBe(false);
		released?.();
	});

	it("stamps the parent correlation on the child's seed message", async () => {
		const exec = getExecute(createAuxTool(ctx));
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "dig through the logs", background: true },
			"call-corr",
		);

		const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as { id: string };
		const thread = db
			.query("SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(agent.id) as { id: string };
		const seed = db
			.query(
				"SELECT content, metadata FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
			)
			.get(thread.id) as { content: string; metadata: string };

		const metadata = JSON.parse(seed.metadata);
		expect(seed.content).toBe("dig through the logs");
		expect(metadata.sender_role).toBe("main");
		expect(metadata.background_parent).toEqual({
			thread_id: "parent-thread",
			call_id: "call-corr",
			agent_name: "tama",
		});
	});

	it("enqueues the seed through dispatch_queue for the server dispatcher", async () => {
		const exec = getExecute(createAuxTool(ctx));
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-queue",
		);

		const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as { id: string };
		const thread = db
			.query("SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(agent.id) as { id: string };
		const entry = db
			.query(
				"SELECT status, event_type FROM dispatch_queue WHERE thread_id = ? ORDER BY created_at ASC LIMIT 1",
			)
			.get(thread.id) as { status: string; event_type: string } | null;

		expect(entry).not.toBeNull();
		expect(entry?.status).toBe("pending");
		expect(entry?.event_type).toBe("user_message");
	});

	it("emits notify:enqueued for the child thread so dispatch wakes immediately", async () => {
		const emitted: Array<{ event: string; payload: unknown }> = [];
		const exec = getExecute(
			createAuxTool({
				...ctx,
				eventBus: {
					on: () => {},
					off: () => {},
					emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
					once: () => {},
				} as any,
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-wake",
		);

		const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as { id: string };
		const thread = db
			.query("SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(agent.id) as { id: string };
		const wake = emitted.find((e) => e.event === "notify:enqueued");
		expect(wake).toBeDefined();
		expect((wake?.payload as { thread_id: string }).thread_id).toBe(thread.id);
	});

	it("does not run the in-process loop runner for a background invocation", async () => {
		let runnerCalls = 0;
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => {
					runnerCalls++;
					return { summary: "should not run inline" };
				},
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		const out = await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-noinline",
		);
		await new Promise((r) => setTimeout(r, 10));

		expect((out as any).deferred).toBe(true);
		expect(runnerCalls).toBe(0);
	});

	it("does not stamp foreground invocations with a parent correlation", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "fg done" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec({ action: "invoke", name: "tama", instructions: "fg work" }, "call-fg");

		const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as { id: string };
		const thread = db
			.query("SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1")
			.get(agent.id) as { id: string };
		const seed = db
			.query(
				"SELECT metadata FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
			)
			.get(thread.id) as { metadata: string };

		const metadata = JSON.parse(seed.metadata);
		expect(metadata.sender_role).toBe("main");
		expect(metadata.background_parent).toBeUndefined();

		const queued = db
			.query("SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ?")
			.get(thread.id) as { c: number };
		expect(queued.c).toBe(0);
	});

	it("creates one child thread per background invocation", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "ok" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec({ action: "invoke", name: "tama", instructions: "a", background: true }, "c1");
		await exec({ action: "invoke", name: "tama", instructions: "b", background: true }, "c2");

		const agent = db.query("SELECT id FROM agents WHERE name = ?").get("tama") as { id: string };
		const threads = db
			.query("SELECT COUNT(*) AS c FROM threads WHERE agent_id = ?")
			.get(agent.id) as { c: number };
		expect(threads.c).toBe(2);
	});

	// Without a call_id the loop has nothing to correlate a later result against,
	// so deferral is impossible — fall back to the blocking path rather than
	// stranding the work.
	it("falls back to synchronous execution when no callId is supplied", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "sync summary" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		const out = await exec({
			action: "invoke",
			name: "tama",
			instructions: "work",
			background: true,
		});

		expect(out).toContain("sync summary");
		expect(out).toMatch(/\n\nThread: [0-9a-f-]{36}$/);
	});

	it("still blocks when background is omitted", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "blocking summary" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		const out = await exec({ action: "invoke", name: "tama", instructions: "work" }, "call-sync");

		expect(out).toContain("blocking summary");
		expect(out).toMatch(/\n\nThread: [0-9a-f-]{36}$/);
	});

	it("validates the identity before deferring", async () => {
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "should not run" }),
			}),
		);

		const out = await exec(
			{ action: "invoke", name: "ghost", instructions: "work", background: true },
			"call-ghost",
		);

		expect(typeof out).toBe("string");
		expect(out).toContain("no active auxiliary agent named 'ghost'");
	});

	it("exposes background in the tool's JSON schema", () => {
		const tool = createAuxTool(ctx);
		const params = tool.toolDefinition.function.parameters as {
			properties: Record<string, { type?: string }>;
		};
		expect(params.properties.background).toBeDefined();
		expect(params.properties.background.type).toBe("boolean");
	});
});
