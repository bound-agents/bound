import Database from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { applySchema, enqueueClientToolCall, findToolResultByThreadAndCallId } from "@bound/core";
import type { AppContext } from "@bound/core";
import { ModelRouter } from "@bound/llm";
import type { LLMBackend } from "@bound/llm";
import type { LoopToolExecutionBatch, ParsedResponse } from "@bound/loop";
import { TypedEventEmitter } from "@bound/shared";
import { AuxAgentLoop } from "../aux-agent-loop";
import type { BoundPreparedFrame } from "../bound-agent-loop";

/**
 * Drives the real AuxAgentLoop methods — prepareFrame (cold context assembly),
 * afterToolPersistence (both the no-deferred rebuild branch and the inline
 * client-tool resolution branch), and awaitClientToolResultInline — against a
 * real in-memory DB and real event bus. No method bodies are stubbed; only
 * the narrowest protected seams are surfaced.
 */

let openDbs: Database[] = [];
let activeLoops: ProbeAuxLoop[] = [];

afterEach(() => {
	for (const loop of activeLoops) {
		loop.forceAbort();
	}
	activeLoops = [];
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
	openDbs.push(db);
	return db;
}

// Minimal LLMBackend; the frame/tool-resolution methods under test never call
// chat(). It only needs to construct a ModelRouter and advertise caching off.
const stubBackend = {
	chat: async function* () {
		yield { type: "done" as const, usage: null };
	},
	capabilities: () => ({
		streaming: true,
		tool_use: true,
		system_prompt: true,
		prompt_caching: false,
		vision: false,
		max_context: 8000,
	}),
} as unknown as LLMBackend;

interface LoopOpts {
	threadId?: string;
	connectionId?: string;
	personaOverride?: string;
}

/** Surfaces the protected frame/tool seams and lets tests abort the inline wait. */
class ProbeAuxLoop extends AuxAgentLoop {
	callPrepareFrame(resolution: BoundPreparedFrame["resolution"]) {
		return (
			this as unknown as {
				prepareFrame: (input: {
					resolution: BoundPreparedFrame["resolution"];
				}) => Promise<Omit<BoundPreparedFrame, "resolution">>;
			}
		).prepareFrame({ resolution });
	}

	callAfterToolPersistence(batch: LoopToolExecutionBatch, frame: BoundPreparedFrame) {
		return this.afterToolPersistence({} as ParsedResponse, frame, batch);
	}

	awaitInline(callId: string) {
		// The wait also watches the call's dispatch entry, so park a live one.
		const entryId = enqueueClientToolCall(
			this.ctx.db,
			this.config.threadId,
			{ call_id: callId, tool_name: "boundless_read", arguments: {} },
			this.config.connectionId ?? "conn",
		);
		return (
			this as unknown as {
				awaitClientToolResultInline: (
					id: string,
					entryId: string,
					waitMs: number,
				) => Promise<{ kind: string; content?: string; isError?: boolean }>;
			}
		).awaitClientToolResultInline(callId, entryId, 300_000);
	}

	forceAbort() {
		(this as unknown as { aborted: boolean }).aborted = true;
	}

	contextDebug() {
		return (this as unknown as { lastContextDebug?: unknown }).lastContextDebug;
	}
}

function makeLoop(
	db: Database,
	opts: LoopOpts = {},
): { loop: ProbeAuxLoop; bus: TypedEventEmitter } {
	const bus = new TypedEventEmitter();
	const ctx = {
		db,
		eventBus: bus,
		siteId: "aux-site",
		hostName: "aux-host",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as AppContext;
	const router = new ModelRouter(new Map([["test-model", stubBackend]]), "test-model");
	const loop = new ProbeAuxLoop(
		ctx,
		{ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
		router,
		{
			threadId: opts.threadId ?? "aux-thread",
			userId: "user-1",
			modelId: "test-model",
			connectionId: opts.connectionId,
			personaOverride: opts.personaOverride,
		},
	);
	activeLoops.push(loop);
	return { loop, bus };
}

const localResolution: BoundPreparedFrame["resolution"] = {
	kind: "local",
	modelId: "test-model",
	backend: stubBackend,
	max_context: 8000,
} as BoundPreparedFrame["resolution"];

function deferredBatch(toolCall: {
	id: string;
	name: string;
	input: Record<string, unknown>;
}): LoopToolExecutionBatch {
	return {
		deferred: [{ toolCall }],
		results: [],
	} as unknown as LoopToolExecutionBatch;
}

describe("AuxAgentLoop.prepareFrame (cold context assembly)", () => {
	it("assembles a cold frame, records a cold-path context debug, and reuses the derived model inputs", async () => {
		const db = makeDb();
		const { loop } = makeLoop(db, { personaOverride: "You are a focused scout." });

		const frame = await loop.callPrepareFrame(localResolution);

		// The assembled frame exposes the shared model-derived inputs and a
		// messages array built from the (empty) thread history.
		expect(frame.contextWindow).toBe(8000);
		expect(Array.isArray(frame.messages)).toBe(true);
		expect(frame.assembled.messages).toBe(frame.messages);
		expect(frame.cacheTtl).toBeDefined();
		expect(frame.measuredInflation).toBeNull();

		// Cold path is stamped onto the recorded context debug.
		const debug = frame.assembled.debug as { cachePath: string; cachePathReason: string };
		expect(debug.cachePath).toBe("cold");
		expect(debug.cachePathReason).toBe("no-stored-state");
		expect(loop.contextDebug()).toBe(frame.assembled.debug);
	});

	it("carries the persona override through to the assembled system prompt", async () => {
		const db = makeDb();
		const { loop } = makeLoop(db, { personaOverride: "UNIQUE-SCOUT-PERSONA-MARKER" });

		const frame = await loop.callPrepareFrame(localResolution);

		expect(frame.assembled.systemPrompt).toContain("UNIQUE-SCOUT-PERSONA-MARKER");
	});
});

describe("AuxAgentLoop.afterToolPersistence (no deferred calls)", () => {
	it("requests a cold frame rebuild after a completed server-tool round", async () => {
		const db = makeDb();
		const { loop } = makeLoop(db);

		const batch = {
			deferred: [],
			results: [
				{
					toolCall: { id: "call-1", name: "query", input: { sql: "SELECT 1" } },
					result: { content: "1", exitCode: 0 },
				},
			],
		} as unknown as LoopToolExecutionBatch;

		const decision = await loop.callAfterToolPersistence(batch, {
			messages: [],
		} as unknown as BoundPreparedFrame);

		expect(decision).toEqual({ action: "retry", rebuildFrame: true });
	});
});

describe("AuxAgentLoop.afterToolPersistence (deferred client tools)", () => {
	it("fails a deferred client tool immediately when the aux has no inherited WS session", async () => {
		const db = makeDb();
		const threadId = "aux-no-conn";
		const { loop } = makeLoop(db, { threadId }); // no connectionId

		const frame = { messages: [] as unknown[] } as unknown as BoundPreparedFrame;
		const decision = await loop.callAfterToolPersistence(
			deferredBatch({ id: "c-noconn", name: "boundless_read", input: { path: "/x" } }),
			frame,
		);

		expect(decision).toEqual({ action: "retry", rebuildFrame: true });

		// The failure result is persisted so the model reacts instead of stalling.
		// This branch `continue`s before the frame-pairing code, so the dangling
		// tool_call reaches the bridge's orphan repair rather than an in-frame pair.
		const row = findToolResultByThreadAndCallId(db, threadId, "c-noconn");
		expect(row?.content).toContain("needs a live client session");
		expect(row?.exit_code).toBe(1);
		expect(frame.messages).toHaveLength(0);
	});

	it("enqueues the client call, emits client_tool_call:created, resolves inline on the persisted result, and acks the re-wake", async () => {
		const db = makeDb();
		const threadId = "aux-with-conn";
		const { loop, bus } = makeLoop(db, { threadId, connectionId: "conn-live" });

		const created: Array<{ callId: string; toolName: string }> = [];
		bus.on("client_tool_call:created", (e: { callId: string; toolName: string }) => {
			created.push({ callId: e.callId, toolName: e.toolName });
		});

		// Simulate the WS session host landing the tool_result row shortly after
		// the call is enqueued — the inline awaiter must pick it up via the event.
		bus.on("client_tool_call:created", (e: { callId: string }) => {
			setTimeout(() => {
				db.run(
					"INSERT INTO messages (id, thread_id, role, content, tool_name, exit_code, host_origin, created_at, modified_at, deleted) VALUES (?, ?, 'tool_result', ?, ?, 0, 'remote', ?, ?, 0)",
					[
						`m-${e.callId}`,
						threadId,
						"probe file contents",
						e.callId,
						new Date().toISOString(),
						new Date().toISOString(),
					],
				);
				bus.emit("message:created", { thread_id: threadId });
			}, 10);
		});

		const frame = { messages: [] as unknown[] } as unknown as BoundPreparedFrame;
		const decision = await loop.callAfterToolPersistence(
			deferredBatch({ id: "c-live", name: "boundless_read", input: { path: "/probe" } }),
			frame,
		);

		expect(decision).toEqual({ action: "retry", rebuildFrame: true });
		expect(created).toEqual([{ callId: "c-live", toolName: "boundless_read" }]);

		// A dispatch_queue row was enqueued for the live connection.
		const dq = db
			.query("SELECT status, claimed_by FROM dispatch_queue WHERE thread_id = ?")
			.all(threadId) as Array<{ status: string; claimed_by: string }>;
		expect(dq.some((r) => r.claimed_by === "conn-live")).toBe(true);

		// The resolved content was paired into the in-memory frame (not an error).
		expect(frame.messages).toHaveLength(1);
		const paired = (frame.messages as Array<{ role: string; content: unknown }>)[0];
		expect(paired?.role).toBe("tool_result");
	});

	it("persists an aborted failure result when the inline wait is aborted before a result lands", async () => {
		const db = makeDb();
		const threadId = "aux-abort";
		const { loop } = makeLoop(db, { threadId, connectionId: "conn-abort" });

		const frame = { messages: [] as unknown[] } as unknown as BoundPreparedFrame;
		const pending = loop.callAfterToolPersistence(
			deferredBatch({ id: "c-abort", name: "boundless_read", input: { path: "/never" } }),
			frame,
		);

		// No result row will ever be written; abort the loop so the inline wait
		// resolves null and the timeout-failure branch runs.
		await new Promise((r) => setTimeout(r, 20));
		loop.forceAbort();

		const decision = await pending;
		expect(decision).toEqual({ action: "retry", rebuildFrame: true });

		const row = findToolResultByThreadAndCallId(db, threadId, "c-abort");
		expect(row?.content).toContain("aux loop was aborted");
		expect(row?.exit_code).toBe(1);
		expect((frame.messages as Array<{ tool_use_id: string }>)[0]?.tool_use_id).toBe("c-abort");
	});
});

describe("AuxAgentLoop.awaitClientToolResultInline", () => {
	it("returns the already-persisted result synchronously without waiting", async () => {
		const db = makeDb();
		const threadId = "aux-existing";
		const { loop } = makeLoop(db, { threadId, connectionId: "conn-x" });

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, tool_name, exit_code, host_origin, created_at, modified_at, deleted) VALUES (?, ?, 'tool_result', ?, ?, 0, 'remote', ?, ?, 0)",
			[
				"m-existing",
				threadId,
				"already here",
				"c-existing",
				new Date().toISOString(),
				new Date().toISOString(),
			],
		);

		const resolved = await loop.awaitInline("c-existing");
		expect(resolved).toEqual({ kind: "result", content: "already here", isError: false });
	});

	it("surfaces a non-zero exit_code as an error result", async () => {
		const db = makeDb();
		const threadId = "aux-err";
		const { loop } = makeLoop(db, { threadId, connectionId: "conn-e" });

		db.run(
			"INSERT INTO messages (id, thread_id, role, content, tool_name, exit_code, host_origin, created_at, modified_at, deleted) VALUES (?, ?, 'tool_result', ?, ?, 1, 'remote', ?, ?, 0)",
			["m-err", threadId, "boom", "c-err", new Date().toISOString(), new Date().toISOString()],
		);

		const resolved = await loop.awaitInline("c-err");
		expect(resolved).toEqual({ kind: "result", content: "boom", isError: true });
	});

	it("resolves via the message:created event when the result lands after subscription", async () => {
		const db = makeDb();
		const threadId = "aux-wakeup";
		const { loop, bus } = makeLoop(db, { threadId, connectionId: "conn-w" });

		const pending = loop.awaitInline("c-wakeup");

		await new Promise((r) => setTimeout(r, 20));
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, tool_name, exit_code, host_origin, created_at, modified_at, deleted) VALUES (?, ?, 'tool_result', ?, ?, 0, 'remote', ?, ?, 0)",
			[
				"m-wakeup",
				threadId,
				"woke up",
				"c-wakeup",
				new Date().toISOString(),
				new Date().toISOString(),
			],
		);
		bus.emit("message:created", { thread_id: threadId });

		const resolved = await pending;
		expect(resolved).toEqual({ kind: "result", content: "woke up", isError: false });
	});

	it("ignores message:created events for other threads", async () => {
		const db = makeDb();
		const threadId = "aux-scoped";
		const { loop, bus } = makeLoop(db, { threadId, connectionId: "conn-s" });

		const pending = loop.awaitInline("c-scoped");

		await new Promise((r) => setTimeout(r, 20));
		// Event for a DIFFERENT thread must NOT resolve the wait.
		bus.emit("message:created", { thread_id: "some-other-thread" });
		await new Promise((r) => setTimeout(r, 20));

		// Now land the real result for our thread and fire the right event.
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, tool_name, exit_code, host_origin, created_at, modified_at, deleted) VALUES (?, ?, 'tool_result', ?, ?, 0, 'remote', ?, ?, 0)",
			[
				"m-scoped",
				threadId,
				"scoped result",
				"c-scoped",
				new Date().toISOString(),
				new Date().toISOString(),
			],
		);
		bus.emit("message:created", { thread_id: threadId });

		expect(await pending).toEqual({ kind: "result", content: "scoped result", isError: false });
	});

	it("resolves aborted when the loop aborts before any result lands", async () => {
		const db = makeDb();
		const threadId = "aux-aborted-wait";
		const { loop } = makeLoop(db, { threadId, connectionId: "conn-a" });

		const pending = loop.awaitInline("c-aborted");
		await new Promise((r) => setTimeout(r, 20));
		loop.forceAbort();

		expect(await pending).toEqual({ kind: "aborted" });
	});
});
