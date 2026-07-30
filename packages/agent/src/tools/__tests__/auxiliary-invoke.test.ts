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

			expect(out).toBe("aux completed: found 3 files");
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

	function insertPlaceholder(threadId: string, callId: string): string {
		const id = `msg-${callId}`;
		db.run(
			`INSERT INTO messages (id, thread_id, role, content, model_id, tool_name, created_at, modified_at, host_origin, deleted, exit_code, metadata)
			 VALUES (?, ?, 'tool_result', '[Background: running]', NULL, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?, 0, NULL, NULL)`,
			[id, threadId, callId, siteId],
		);
		return id;
	}

	function placeholderOf(id: string): { content: string; exit_code: number | null } | null {
		return db.query("SELECT content, exit_code FROM messages WHERE id = ?").get(id) as {
			content: string;
			exit_code: number | null;
		} | null;
	}

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

	it("resolves the placeholder with the aux summary once the loop finishes", async () => {
		const placeholderId = insertPlaceholder("parent-thread", "call-done");
		let settle: ((v: { summary: string }) => void) | undefined;
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: () =>
					new Promise<{ summary: string }>((resolve) => {
						settle = resolve;
					}),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-done",
		);
		expect(placeholderOf(placeholderId)?.content).toBe("[Background: running]");

		settle?.({ summary: "found 7 matches" });
		await new Promise((r) => setTimeout(r, 10));

		const row = placeholderOf(placeholderId);
		expect(row?.content).toBe("found 7 matches");
		expect(row?.exit_code).toBe(0);
	});

	it("resolves the placeholder as an error when the aux reports one", async () => {
		const placeholderId = insertPlaceholder("parent-thread", "call-err");
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "", error: "model unavailable" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-err",
		);
		await new Promise((r) => setTimeout(r, 10));

		const row = placeholderOf(placeholderId);
		expect(row?.content).toContain("model unavailable");
		expect(row?.exit_code).toBe(1);
	});

	it("resolves the placeholder as an error when the loop runner throws", async () => {
		const placeholderId = insertPlaceholder("parent-thread", "call-throw");
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => {
					throw new Error("nested loop exploded");
				},
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-throw",
		);
		await new Promise((r) => setTimeout(r, 10));

		const row = placeholderOf(placeholderId);
		expect(row?.content).toContain("nested loop exploded");
		expect(row?.exit_code).toBe(1);
	});

	it("enqueues a tool_result dispatch entry to re-wake the parent loop", async () => {
		insertPlaceholder("parent-thread", "call-wake");
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => ({ summary: "done" }),
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		await exec(
			{ action: "invoke", name: "tama", instructions: "work", background: true },
			"call-wake",
		);
		await new Promise((r) => setTimeout(r, 10));

		const pending = db
			.query(
				"SELECT COUNT(*) AS c FROM dispatch_queue WHERE thread_id = ? AND event_type = 'tool_result' AND status = 'pending'",
			)
			.get("parent-thread") as { c: number };
		expect(pending.c).toBe(1);
	});

	// Split/merge consist: three sections leave the junction together and run
	// their own schedules. All three runners must be in flight concurrently.
	it("runs several background invocations concurrently", async () => {
		let inFlight = 0;
		let peak = 0;
		const gates: Array<() => void> = [];
		const exec = getExecute(
			createAuxTool({
				...ctx,
				auxLoopRunner: async () => {
					inFlight++;
					peak = Math.max(peak, inFlight);
					await new Promise<void>((resolve) => gates.push(resolve));
					inFlight--;
					return { summary: "ok" };
				},
			}),
		);
		await exec({ action: "define", name: "tama", persona: "test" });

		for (const callId of ["c1", "c2", "c3"]) {
			const out = await exec(
				{ action: "invoke", name: "tama", instructions: "work", background: true },
				callId,
			);
			expect((out as any).deferred).toBe(true);
		}
		await new Promise((r) => setTimeout(r, 10));

		expect(peak).toBe(3);
		for (const release of gates) release();
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

		expect(out).toBe("sync summary");
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

		expect(out).toBe("blocking summary");
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
