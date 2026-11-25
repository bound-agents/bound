import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveClientSessionHost } from "@bound/agent";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import type { ServerWebSocket } from "bun";
import { createWebSocketHandler, parseClientTools } from "../websocket";

const LOCAL = "site-local";
const REMOTE = "site-remote";

class MockWebSocket {
	readyState = 1;
	messages: unknown[] = [];
	send(message: string) {
		this.messages.push(JSON.parse(message));
	}
}

const tool = (name: string) => ({
	type: "function" as const,
	function: { name, description: name, parameters: { type: "object" } },
});

let db: Database;
let handler: ReturnType<typeof createWebSocketHandler>;

function seedRemoteSession(threadId: string, tools: string): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"hosts",
		{
			site_id: REMOTE,
			host_name: "remote",
			online_at: now,
			modified_at: now,
			work_spool_capable: 0,
			deleted: 0,
		},
		REMOTE,
	);
	insertRow(
		db,
		"client_sessions",
		{
			id: `conn-r::${threadId}`,
			connection_id: "conn-r",
			thread_id: threadId,
			site_id: REMOTE,
			client_tools: tools,
			created_at: now,
			deleted: 0,
			modified_at: now,
		},
		REMOTE,
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	handler = createWebSocketHandler({
		eventBus: new TypedEventEmitter(),
		db,
		siteId: LOCAL,
		defaultUserId: "u",
		hostOrigin: "localhost:3000",
	});
});

afterEach(() => {
	handler.cleanup();
	db.close();
});

describe("cross-host client tool discovery", () => {
	it("returns tools synced from a remote session when no local client holds them", () => {
		seedRemoteSession("t1", JSON.stringify([tool("boundless_read")]));
		const tools = handler.registry.getClientToolsForThread("t1");
		expect([...tools.keys()]).toEqual(["boundless_read"]);
		// No local connection: calls fall through to the session-host relay.
		expect(handler.registry.getConnectionForTool("t1", "boundless_read")).toBeUndefined();
		// ...and the relay resolver targets the host whose tools were offered.
		expect(resolveClientSessionHost(db, "t1", LOCAL)?.site_id).toBe(REMOTE);
	});

	it("prefers local client tools over synced ones", () => {
		seedRemoteSession("t1", JSON.stringify([tool("remote_tool")]));
		const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
		handler.open(ws);
		handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: "t1" }));
		handler.message(ws, JSON.stringify({ type: "session:configure", tools: [tool("local_tool")] }));
		expect([...handler.registry.getClientToolsForThread("t1").keys()]).toEqual(["local_tool"]);
	});

	it("tolerates malformed synced JSON", () => {
		seedRemoteSession("t1", "{not json");
		expect(handler.registry.getClientToolsForThread("t1").size).toBe(0);
		expect(parseClientTools('[{"type":"function"},1]')).toEqual([]);
	});

	it("session:configure persists client_tools through the outbox", () => {
		const ws = new MockWebSocket() as unknown as ServerWebSocket<unknown>;
		handler.open(ws);
		handler.message(ws, JSON.stringify({ type: "thread:subscribe", thread_id: "t2" }));
		handler.message(ws, JSON.stringify({ type: "session:configure", tools: [tool("a")] }));
		const row = db
			.query("SELECT client_tools FROM client_sessions WHERE thread_id = 't2' AND deleted = 0")
			.get() as { client_tools: string };
		expect(parseClientTools(row.client_tools).map((d) => d.function.name)).toEqual(["a"]);
		handler.message(
			ws,
			JSON.stringify({ type: "session:configure", tools: [tool("a"), tool("b")] }),
		);
		const updated = db
			.query("SELECT client_tools FROM client_sessions WHERE thread_id = 't2' AND deleted = 0")
			.get() as { client_tools: string };
		expect(parseClientTools(updated.client_tools)).toHaveLength(2);
		const log = db
			.query("SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'client_sessions'")
			.get() as { n: number };
		expect(log.n).toBeGreaterThanOrEqual(2);
	});
});
