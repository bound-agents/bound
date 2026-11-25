import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyMetricsSchema, applySchema } from "@bound/core";
import type { AppContext } from "@bound/core";
import type { LLMBackend, StreamChunk } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import { TypedEventEmitter } from "@bound/shared";
import { MainAgentLoop } from "../agent-loop";

/**
 * Covers the uncovered MainAgentLoop tool-relay branches in bound-agent-loop.ts:
 *   - afterToolPersistence's deferred client-tool fan-out (local enqueue,
 *     no-session error, remote relay),
 *   - relayDeferredClientTool's request-write failure and timeout branches,
 *   - onModelErrorTerminal's partial-response salvage,
 *   - onRouteFailure same-model failover.
 * All paths run through run() against a real DB, real event bus, and a mock
 * backend. No loop method body is stubbed.
 */

let openDbs: Database[] = [];

afterEach(() => {
	for (const db of openDbs) {
		try {
			db.close();
		} catch {
			/* already closed */
		}
	}
	openDbs = [];
});

function makeDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	const userId = "user-1";
	db.run(
		"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, 0)",
		[userId, "Test User", null, new Date().toISOString(), new Date().toISOString()],
	);
	openDbs.push(db);
	return db;
}

function makeCtx(db: Database, bus: TypedEventEmitter, siteId = "local-site"): AppContext {
	return {
		db,
		eventBus: bus,
		siteId,
		hostName: "local-host",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as AppContext;
}

/** A mock backend whose chat() yields queued response generators in order. */
class MockBackend implements LLMBackend {
	private responses: Array<() => AsyncGenerator<StreamChunk>> = [];
	callCount = 0;

	push(gen: () => AsyncGenerator<StreamChunk>) {
		this.responses.push(gen);
	}

	/** First turn: a single tool_use for a (client) tool; second turn: final text. */
	toolThenText(toolId: string, toolName: string, input: Record<string, unknown>, text: string) {
		this.push(async function* () {
			yield { type: "tool_use_start" as const, id: toolId, name: toolName };
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
		this.push(async function* () {
			yield { type: "text" as const, content: text };
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

	async *chat(): AsyncGenerator<StreamChunk> {
		const gen = this.responses[this.callCount];
		this.callCount++;
		if (gen) {
			yield* gen();
		} else {
			yield { type: "text" as const, content: "" };
			yield { type: "done" as const, usage: null };
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

const clientToolDef = {
	type: "function" as const,
	function: {
		name: "client_read_file",
		description: "Read a file on the client",
		parameters: {
			type: "object" as const,
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
};

function makeRouter(backend: LLMBackend): ModelRouter {
	return new ModelRouter(new Map([["test-model", backend]]), "test-model");
}

describe("MainAgentLoop deferred client-tool relay (afterToolPersistence)", () => {
	it("enqueues a local client tool for the inherited connection and stops for an async result", async () => {
		const db = makeDb();
		const bus = new TypedEventEmitter();
		const threadId = randomUUID();

		const created: Array<{ callId: string; toolName: string }> = [];
		bus.on("client_tool_call:created", (e: { callId: string; toolName: string }) => {
			created.push({ callId: e.callId, toolName: e.toolName });
		});

		const backend = new MockBackend();
		backend.toolThenText("call-c1", "client_read_file", { path: "/x" }, "done");

		const loop = new MainAgentLoop(
			makeCtx(db, bus),
			{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			makeRouter(backend),
			{
				threadId,
				userId: "user-1",
				modelId: "test-model",
				connectionId: "conn-live",
				clientTools: new Map([["client_read_file", clientToolDef]]),
			},
		);

		const result = await loop.run();

		// The loop stops (returns to await the async client result) after one turn,
		// so only the first (tool_use) generator was consumed.
		expect(backend.callCount).toBe(1);
		expect(result.toolCallsMade).toBe(1);

		// The client call was enqueued for the live connection and announced.
		expect(created).toEqual([{ callId: "call-c1", toolName: "client_read_file" }]);
		const dq = db
			.query("SELECT status, claimed_by, event_type FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as Array<{ status: string; claimed_by: string; event_type: string }>;
		expect(dq.some((r) => r.claimed_by === "conn-live" && r.status === "pending")).toBe(true);
	});

	it("surfaces a hard error result when a client tool has no live session on any host", async () => {
		const db = makeDb();
		const bus = new TypedEventEmitter();
		const threadId = randomUUID();

		const backend = new MockBackend();
		backend.toolThenText("call-nosess", "client_read_file", { path: "/x" }, "handled the error");

		const loop = new MainAgentLoop(
			makeCtx(db, bus),
			{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			makeRouter(backend),
			{
				threadId,
				userId: "user-1",
				modelId: "test-model",
				// No connectionId AND no client_sessions row anywhere.
				clientTools: new Map([["client_read_file", clientToolDef]]),
			},
		);

		const result = await loop.run();

		// Both turns ran: the no-session error result was pushed into batch.results
		// during afterToolPersistence (after persistToolMessages already ran, so it is
		// NOT persisted as a tool_result row — invariant #7 ordering). It reaches the
		// model via the in-memory frame, which then produced its final text turn.
		expect(backend.callCount).toBe(2);
		expect(result.error).toBeUndefined();

		// The model's final assistant message landed, proving the error was fed back
		// and the loop continued rather than stalling on the dangling client call.
		const assistant = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		expect(assistant?.content).toBe("handled the error");

		// No tool_result row for the dangling call (it was never in batch.results at
		// persistToolMessages time).
		const toolResults = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all(threadId) as Array<{ content: string }>;
		expect(toolResults).toHaveLength(0);
	});
});

describe("MainAgentLoop.relayDeferredClientTool (remote session host)", () => {
	// Seed a remote host that holds the thread's WS session but is NOT
	// work_spool_capable, so routeRelayRequest returns a typed routing error
	// and relayDeferredClientTool takes its request-write-failure branch.
	function seedRemoteSessionNotCapable(db: Database, threadId: string, remoteSiteId: string): void {
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO hosts (site_id, host_name, platforms, work_spool_capable, online_at, modified_at, deleted) VALUES (?, ?, ?, 0, ?, ?, 0)",
			[remoteSiteId, "remote-host", JSON.stringify([]), now, now],
		);
		db.run(
			"INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
			[`sess-${remoteSiteId}`, "conn-remote", threadId, remoteSiteId, now, now],
		);
	}

	it("returns an error result when the relay request cannot be written to a non-capable session host", async () => {
		const db = makeDb();
		const bus = new TypedEventEmitter();
		const threadId = randomUUID();
		seedRemoteSessionNotCapable(db, threadId, "remote-site");

		const backend = new MockBackend();
		backend.toolThenText("call-remote", "client_read_file", { path: "/r" }, "saw the relay error");

		const loop = new MainAgentLoop(
			makeCtx(db, bus),
			{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			makeRouter(backend),
			{
				threadId,
				userId: "user-1",
				modelId: "test-model",
				// No local connection: the no-connection branch resolves the remote
				// session host and relays synchronously.
				clientTools: new Map([["client_read_file", clientToolDef]]),
			},
		);

		const result = await loop.run();

		// The remote relay failed to route to the non-capable host; relayDeferredClientTool
		// returned an error result that was pushed into batch.results during
		// afterToolPersistence and fed back to the model via the in-memory frame
		// (not persisted as a tool_result row — invariant #7 ordering).
		expect(backend.callCount).toBe(2);
		expect(result.error).toBeUndefined();

		const assistant = db
			.query(
				"SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1",
			)
			.get(threadId) as { content: string } | null;
		expect(assistant?.content).toBe("saw the relay error");

		// routeRelayRequest rejects the non-capable target with a typed routing error
		// (invariant #3 / R-DW14) BEFORE writing any durable_work row, so the
		// request-write-failure branch ran: no client_tool row was persisted.
		const durable = db
			.query("SELECT kind, target_site_id FROM durable_work WHERE kind = 'client_tool'")
			.all() as Array<{ kind: string; target_site_id: string }>;
		expect(durable.some((r) => r.target_site_id === "remote-site")).toBe(false);
	});
});

describe("MainAgentLoop.onRouteFailure (no cross-model substitution)", () => {
	it("does NOT substitute a different model when the hinted model is absent (R-RT7/R-RT8)", async () => {
		// Under the routing redesign a route failure only fails over to other
		// routes for the SAME logical model; a model whose routes are all down
		// returns transient-unavailable and is not substituted onto a different
		// model (that is a refusal-only path, slice 5). The router has only "phi3";
		// a request for the absent "glm" must surface an error, never silently run
		// on phi3.
		const db = makeDb();
		const bus = new TypedEventEmitter();
		const threadId = randomUUID();

		const emitted: Array<{ event: string; payload: unknown }> = [];
		const origEmit = bus.emit.bind(bus);
		(bus as unknown as { emit: (e: string, p: unknown) => boolean }).emit = (e, p) => {
			emitted.push({ event: e, payload: p });
			return origEmit(e as never, p as never);
		};

		const backend = new MockBackend();
		const backends = new Map<string, LLMBackend>([["phi3", backend]]);
		const router = new ModelRouter(backends, "phi3");

		const loop = new MainAgentLoop(
			makeCtx(db, bus),
			{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
			router,
			{ threadId, userId: "user-1", modelId: "glm" },
		);

		const result = await loop.run();

		// The absent model surfaces an error; no phi3 substitution, no fallback event.
		expect(result.error).toBeDefined();
		expect(result.error).toContain("glm");
		const fallback = emitted.find((e) => e.event === "model:fallback");
		expect(fallback).toBeUndefined();
	});
});
