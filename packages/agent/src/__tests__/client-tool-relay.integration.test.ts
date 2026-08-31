import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyMetricsSchema,
	applySchema,
	enqueueToolResult,
	insertInbox,
	insertRow,
	readUnprocessed,
} from "@bound/core";
import type { ChatParams, LLMBackend } from "@bound/llm";
import { ModelRouter } from "@bound/llm";
import {
	type ClientResultPayload,
	type ClientToolPayload,
	type Logger,
	type RelayInboxEntry,
	type RelayOutboxEntry,
	TypedEventEmitter,
} from "@bound/shared";
import { resolveClientSessionHost } from "../delegation";
import type { MCPClient } from "../mcp-client";
import { type ClientToolResolver, RelayProcessor } from "../relay-processor";
import { sleep, waitFor } from "./helpers";

// ---------------------------------------------------------------------------
// Cross-host client-tool relay (R-UD5 / R-UD8 / R-UD12), AC.7a / AC.7b / AC.7c.
//
// The consumer side (`RelayProcessor.handleClientTool`) is exercised directly
// here with a SIMULATED WS session: a fake `ClientToolResolver` stands in for
// the web-layer `ConnectionRegistry`, and the client's `tool:result` is
// simulated by persisting the `tool_result` message + `enqueueToolResult`
// exactly the way `web/src/server/websocket.ts#handleToolResult` does. We
// prefer this over a full `createWsTestCluster` because the cluster harness
// cannot model a live boundless WS client tool without a real socket peer; the
// dispatch/relay-level seam is the meaningful contract for the relay handler
// and is fully deterministic. The producer→consumer wire is covered by the
// resolver tests + the consumer's response-correlation assertions.
// ---------------------------------------------------------------------------

const createMockLogger = (): Logger => ({
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
});

class MockLLMBackend implements LLMBackend {
	// biome-ignore lint/correctness/useYield: mock generator for test
	async *chat(_params: ChatParams) {
		return;
	}
	capabilities() {
		return {
			streaming: true,
			tool_use: true,
			system_prompt: true,
			prompt_caching: false,
			vision: false,
			max_context: 4096,
		};
	}
}

function createMockModelRouter(): ModelRouter {
	const backends = new Map<string, LLMBackend>();
	backends.set("mock-model", new MockLLMBackend());
	return new ModelRouter(backends, "mock-model");
}

/**
 * Fake `ConnectionRegistry`: reports a live local connection for any
 * (thread, tool) pair present in `live`. `getConnectionForTool` returning a
 * truthy id is the "session is live on this host" signal the handler checks.
 */
function makeWsRegistry(live: Set<string>): ClientToolResolver {
	return {
		getClientToolsForThread: () => undefined,
		getConnectionForTool: (threadId, toolName) =>
			live.has(`${threadId}::${toolName}`) ? "conn-1" : undefined,
		getSystemPromptAdditionForThread: () => undefined,
	};
}

function makeProcessor(db: Database, registry?: ClientToolResolver): RelayProcessor {
	const processor = new RelayProcessor(
		db,
		"session-host",
		new Map<string, MCPClient>(),
		createMockModelRouter(),
		createMockLogger(),
		new TypedEventEmitter(),
	);
	if (registry) processor.setWsRegistry(registry);
	return processor;
}

function insertClientToolInbox(
	db: Database,
	id: string,
	sourceSiteId: string,
	payload: ClientToolPayload,
): RelayInboxEntry {
	const now = new Date();
	db.run(
		`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, payload, expires_at, received_at, processed)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			sourceSiteId,
			"client_tool",
			null,
			null,
			JSON.stringify(payload),
			new Date(now.getTime() + 60_000).toISOString(),
			now.toISOString(),
			0,
		],
	);
	return {
		id,
		source_site_id: sourceSiteId,
		kind: "client_tool",
		ref_id: null,
		idempotency_key: null,
		stream_id: null,
		payload: JSON.stringify(payload),
		expires_at: new Date(now.getTime() + 60_000).toISOString(),
		received_at: now.toISOString(),
		processed: 0,
		trace_context: null,
	};
}

/** Simulate websocket.ts#handleToolResult: persist the tool_result + enqueue. */
function simulateClientToolResult(
	db: Database,
	threadId: string,
	callId: string,
	content: string,
	isError: boolean,
): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"messages",
		{
			id: crypto.randomUUID(),
			thread_id: threadId,
			role: "tool_result",
			content: JSON.stringify([{ type: "text", text: content }]),
			model_id: null,
			tool_name: callId,
			created_at: now,
			modified_at: now,
			host_origin: "session-host",
			deleted: 0,
			exit_code: isError ? 1 : 0,
			metadata: null,
		},
		"session-host",
	);
	enqueueToolResult(db, threadId, callId);
}

function readClientResults(db: Database, refId: string): RelayOutboxEntry[] {
	return db
		.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
		.all("client_result", refId) as RelayOutboxEntry[];
}

function readErrors(db: Database, refId: string): RelayOutboxEntry[] {
	return db
		.query("SELECT * FROM relay_outbox WHERE kind = ? AND ref_id = ?")
		.all("error", refId) as RelayOutboxEntry[];
}

let db: Database;

beforeEach(() => {
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// already closed
	}
});

describe("resolveClientSessionHost (producer-side session resolution)", () => {
	const LOCAL = "local-site";
	const REMOTE = "remote-site";

	function insertHost(siteId: string, modifiedAt: string): void {
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: `host-${siteId}`,
				sync_url: `https://${siteId}.example`,
				online_at: modifiedAt,
				modified_at: modifiedAt,
				deleted: 0,
			},
			LOCAL,
		);
	}

	function insertSession(threadId: string, siteId: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"client_sessions",
			{
				id: crypto.randomUUID(),
				connection_id: `conn-${siteId}`,
				thread_id: threadId,
				site_id: siteId,
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			LOCAL,
		);
	}

	it("returns null when the session is local (no relay needed)", () => {
		insertHost(LOCAL, new Date().toISOString());
		insertSession("t1", LOCAL);
		expect(resolveClientSessionHost(db, "t1", LOCAL)).toBeNull();
	});

	it("returns null when there is no session for the thread", () => {
		insertHost(REMOTE, new Date().toISOString());
		expect(resolveClientSessionHost(db, "t1", LOCAL)).toBeNull();
	});

	it("returns null when the only remote session host is stale", () => {
		const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		insertHost(REMOTE, stale);
		insertSession("t1", REMOTE);
		expect(resolveClientSessionHost(db, "t1", LOCAL)).toBeNull();
	});

	it("returns the live remote host holding the session", () => {
		insertHost(REMOTE, new Date().toISOString());
		insertSession("t1", REMOTE);
		const host = resolveClientSessionHost(db, "t1", LOCAL);
		expect(host).not.toBeNull();
		expect(host?.site_id).toBe(REMOTE);
		expect(host?.host_name).toBe("host-remote-site");
	});

	it("picks the freshest live remote host when several hold a session", () => {
		const older = new Date(Date.now() - 60 * 1000).toISOString();
		const newer = new Date().toISOString();
		insertHost("remote-a", older);
		insertHost("remote-b", newer);
		insertSession("t1", "remote-a");
		insertSession("t1", "remote-b");
		const host = resolveClientSessionHost(db, "t1", LOCAL);
		expect(host?.site_id).toBe("remote-b");
	});
});

describe("RelayProcessor.handleClientTool (consumer / session host)", () => {
	const PRODUCER = "producer-site";

	it("AC.7a: relays the call to the live local session and returns the result", async () => {
		const threadId = "thread-7a";
		const callId = "call-7a";
		const registry = makeWsRegistry(new Set([`${threadId}::boundless_read`]));
		const processor = makeProcessor(db, registry);

		// The handler emits client_tool_call:created — simulate the WS client
		// answering by persisting the tool_result once the dispatch row appears.
		const entry = insertClientToolInbox(db, "inbox-7a", PRODUCER, {
			thread_id: threadId,
			call_id: callId,
			tool_name: "boundless_read",
			args: { path: "/etc/hosts" },
			timeout_ms: 5000,
		});

		const handle = processor.start(10);
		// Wait until the call has been enqueued into the local WS dispatch, then
		// simulate the client returning a result.
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
						)
						.get(threadId) as { n: number }
				).n > 0,
			{ message: "client tool call not enqueued" },
		);
		simulateClientToolResult(db, threadId, callId, "file contents here", false);

		await waitFor(() => readClientResults(db, entry.id).length > 0, {
			message: "client_result not relayed back",
		});
		handle.stop();

		const results = readClientResults(db, entry.id);
		expect(results.length).toBe(1);
		const payload = JSON.parse(results[0].payload) as ClientResultPayload;
		expect(payload.call_id).toBe(callId);
		expect(payload.is_error).toBe(false);
		expect(payload.content).toContain("file contents here");
		// No error response was produced.
		expect(readErrors(db, entry.id).length).toBe(0);
	});

	it("AC.7b: relays a retriable error when no live local session holds the tool", async () => {
		const threadId = "thread-nosession";
		// Empty registry → getConnectionForTool returns undefined.
		const processor = makeProcessor(db, makeWsRegistry(new Set()));
		const entry = insertClientToolInbox(db, "inbox-nos", PRODUCER, {
			thread_id: threadId,
			call_id: "call-nos",
			tool_name: "boundless_read",
			args: {},
			timeout_ms: 5000,
		});

		const handle = processor.start(10);
		await waitFor(() => readErrors(db, entry.id).length > 0, {
			message: "error not relayed back",
		});
		handle.stop();

		const errors = readErrors(db, entry.id);
		expect(errors.length).toBe(1);
		const payload = JSON.parse(errors[0].payload) as {
			retriable: boolean;
			definitely_not_executed?: boolean;
		};
		expect(payload.retriable).toBe(true);
		// The session host attests the tool never ran here, so a non-idempotent
		// retry elsewhere is safe.
		expect(payload.definitely_not_executed).toBe(true);
		// No client_result was produced.
		expect(readClientResults(db, entry.id).length).toBe(0);
	});

	it("AC.7b: relays a retriable timeout error when the client never answers", async () => {
		const threadId = "thread-timeout";
		const callId = "call-timeout";
		const registry = makeWsRegistry(new Set([`${threadId}::boundless_read`]));
		const processor = makeProcessor(db, registry);
		// Tiny timeout so the test resolves quickly. The client never returns a
		// tool_result, so awaitClientResult must relay a retriable error.
		const entry = insertClientToolInbox(db, "inbox-to", PRODUCER, {
			thread_id: threadId,
			call_id: callId,
			tool_name: "boundless_read",
			args: {},
			timeout_ms: 150,
		});

		const handle = processor.start(10);
		await waitFor(() => readErrors(db, entry.id).length > 0, {
			timeoutMs: 5000,
			message: "timeout error not relayed back",
		});
		handle.stop();

		const errors = readErrors(db, entry.id);
		expect(errors.length).toBeGreaterThan(0);
		const payload = JSON.parse(errors[0].payload) as { retriable: boolean };
		expect(payload.retriable).toBe(true);
		expect(readClientResults(db, entry.id).length).toBe(0);
	});

	it("AC.7c: a re-driven client_tool with an already-landed result does not double-execute", async () => {
		const threadId = "thread-7c";
		const callId = "call-7c";
		const registry = makeWsRegistry(new Set([`${threadId}::boundless_read`]));

		// First delivery: drive to completion.
		const processor1 = makeProcessor(db, registry);
		const entry1 = insertClientToolInbox(db, "inbox-7c-1", PRODUCER, {
			thread_id: threadId,
			call_id: callId,
			tool_name: "boundless_read",
			args: {},
			timeout_ms: 5000,
		});
		const h1 = processor1.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
						)
						.get(threadId) as { n: number }
				).n > 0,
			{ message: "client tool call not enqueued (first delivery)" },
		);
		simulateClientToolResult(db, threadId, callId, "result-once", false);
		await waitFor(() => readClientResults(db, entry1.id).length > 0, {
			message: "first client_result not relayed",
		});
		h1.stop();

		// Snapshot duplicate-sensitive state before the re-drive.
		const toolResultRowsBefore = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ?",
				)
				.get(threadId, callId) as { n: number }
		).n;
		const toolResultDispatchBefore = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'tool_result'",
				)
				.get(threadId) as { n: number }
		).n;

		// Re-drive: a held/duplicated client_tool for the SAME call_id. The
		// result already landed, so the fast path relays a fresh client_result
		// WITHOUT re-enqueuing the client tool or duplicating the tool_result row.
		const processor2 = makeProcessor(db, registry);
		const entry2 = insertClientToolInbox(db, "inbox-7c-2", PRODUCER, {
			thread_id: threadId,
			call_id: callId,
			tool_name: "boundless_read",
			args: {},
			timeout_ms: 5000,
		});
		const h2 = processor2.start(10);
		await waitFor(() => readClientResults(db, entry2.id).length > 0, {
			message: "re-driven client_result not relayed",
		});
		// Give any erroneous extra side-effects a chance to appear.
		await sleep(100);
		h2.stop();

		const toolResultRowsAfter = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND role = 'tool_result' AND tool_name = ?",
				)
				.get(threadId, callId) as { n: number }
		).n;
		const toolResultDispatchAfter = (
			db
				.query(
					"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'tool_result'",
				)
				.get(threadId) as { n: number }
		).n;

		// No duplicate tool-result message row, no duplicate tool_result dispatch
		// (enqueueToolResult is idempotent on (thread_id, call_id)).
		expect(toolResultRowsAfter).toBe(toolResultRowsBefore);
		expect(toolResultDispatchAfter).toBe(toolResultDispatchBefore);
		// The re-drive still produced a correlated client_result for entry2.
		const payload = JSON.parse(readClientResults(db, entry2.id)[0].payload) as ClientResultPayload;
		expect(payload.call_id).toBe(callId);
		expect(payload.content).toContain("result-once");
		// All inbox entries drained.
		expect(readUnprocessed(db).length).toBe(0);
	});

	it("drops duplicate client_tool relay delivery before the session handler executes", async () => {
		const threadId = "thread-client-tool-dedup";
		const callId = "call-client-tool-dedup";
		const processor = makeProcessor(db, makeWsRegistry(new Set([`${threadId}::boundless_read`])));
		const now = new Date();
		const payload: ClientToolPayload = {
			thread_id: threadId,
			call_id: callId,
			tool_name: "boundless_read",
			args: { path: "/etc/hosts" },
			timeout_ms: 5000,
		};
		const makeEntry = (id: string): RelayInboxEntry => ({
			id,
			source_site_id: PRODUCER,
			kind: "client_tool",
			ref_id: null,
			idempotency_key: `client-tool:${threadId}:${callId}`,
			stream_id: null,
			payload: JSON.stringify(payload),
			expires_at: new Date(now.getTime() + 60_000).toISOString(),
			received_at: now.toISOString(),
			processed: 0,
			trace_context: null,
		});

		const first = makeEntry("inbox-client-tool-dedup-1");
		expect(insertInbox(db, first)).toBe(true);
		expect(insertInbox(db, makeEntry("inbox-client-tool-dedup-2"))).toBe(false);

		const handle = processor.start(10);
		await waitFor(
			() =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
						)
						.get(threadId) as { n: number }
				).n === 1,
			{ message: "client tool handler did not execute exactly once" },
		);
		simulateClientToolResult(db, threadId, callId, "deduplicated", false);
		await waitFor(() => readClientResults(db, first.id).length === 1, {
			message: "client result not relayed",
		});
		handle.stop();

		expect(
			(
				db
					.query(
						"SELECT COUNT(*) AS n FROM dispatch_queue WHERE thread_id = ? AND event_type = 'client_tool_call'",
					)
					.get(threadId) as { n: number }
			).n,
		).toBe(1);
	});
});
