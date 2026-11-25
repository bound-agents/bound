import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyMetricsSchema,
	applySchema,
	enqueueClientToolCall,
	expireClientToolCallIfInFlight,
	getPendingClientToolCalls,
	insertRow,
	setChangelogEventBus,
} from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { MAX_TOOL_RESULT_BYTES } from "@bound/shared/strings";
import { type WebSocketConfig, createWebSocketHandler } from "../websocket";

// Drives the real WS protocol handler through Bun.serve on an OS-assigned port
// with a real WebSocket client. This exercises the wire path the mock-ws unit
// tests can't: the Bun ServerWebSocket is the live socket, so send/readyState,
// buffering, and disconnect fire for real. Every server, DB, and listener is
// stopped in afterEach so nothing leaks into the sibling files the commit hook
// runs in the same process.

const SITE_ID = "test-site";
const USER_ID = "test-user";

interface TestServer {
	url: string;
	eventBus: TypedEventEmitter;
	handler: WebSocketConfig & ReturnType<typeof createWebSocketHandler>;
	db: Database;
	stop(): void;
}

function seedThread(db: Database, threadId: string): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: USER_ID,
			interface: "web",
			host_origin: "localhost:3000",
			color: 0,
			title: "t",
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			model_hint: null,
			deleted: 0,
		},
		SITE_ID,
	);
}

function seedUser(db: Database): void {
	const now = new Date().toISOString();
	insertRow(
		db,
		"users",
		{
			id: USER_ID,
			display_name: "Tester",
			first_seen_at: now,
			modified_at: now,
			deleted: 0,
			platform_ids: null,
		},
		SITE_ID,
	);
}

function startServer(): TestServer {
	const db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
	seedUser(db);
	const eventBus = new TypedEventEmitter();
	const handler = createWebSocketHandler({
		eventBus,
		db,
		siteId: SITE_ID,
		defaultUserId: USER_ID,
		hostOrigin: "localhost:3000",
	});

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			if (srv.upgrade(req)) return undefined;
			return new Response("no upgrade", { status: 400 });
		},
		websocket: {
			open(ws) {
				handler.open(ws);
			},
			message(ws, message) {
				handler.message(ws, message);
			},
			close(ws) {
				handler.close(ws);
			},
		},
	});

	return {
		url: `ws://127.0.0.1:${server.port}`,
		eventBus,
		handler,
		db,
		stop() {
			handler.cleanup();
			server.stop(true);
			db.close();
		},
	};
}

type Frame = Record<string, unknown>;

/** A real client socket that records every JSON frame the server sends. */
class TestClient {
	readonly ws: WebSocket;
	readonly frames: Frame[] = [];

	private constructor(ws: WebSocket) {
		this.ws = ws;
	}

	static async connect(url: string): Promise<TestClient> {
		const ws = new WebSocket(url);
		const client = new TestClient(ws);
		ws.addEventListener("message", (ev) => {
			try {
				client.frames.push(JSON.parse(String(ev.data)) as Frame);
			} catch {
				// non-JSON frames are not part of this protocol; ignore
			}
		});
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
		});
		return client;
	}

	send(frame: Frame): void {
		this.ws.send(JSON.stringify(frame));
	}

	async waitFor(
		predicate: (f: Frame) => boolean,
		description: string,
		timeoutMs = 2000,
	): Promise<Frame> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const found = this.frames.find(predicate);
			if (found) return found;
			await Bun.sleep(2);
		}
		throw new Error(`timed out waiting for ${description}; got ${JSON.stringify(this.frames)}`);
	}

	async expectQuiet(description: string, quietMs = 40): Promise<void> {
		const before = this.frames.length;
		await Bun.sleep(quietMs);
		if (this.frames.length > before) {
			throw new Error(
				`expected no ${description}; got ${JSON.stringify(this.frames.slice(before))}`,
			);
		}
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// already closing
		}
	}
}

describe("websocket real-server protocol", () => {
	let srv: TestServer;
	const clients: TestClient[] = [];

	beforeEach(() => {
		srv = startServer();
	});

	afterEach(() => {
		for (const c of clients) c.close();
		clients.length = 0;
		srv.stop();
	});

	async function connect(): Promise<TestClient> {
		const c = await TestClient.connect(srv.url);
		clients.push(c);
		return c;
	}

	it("delivers message:created only to clients subscribed to the thread", async () => {
		seedThread(srv.db, "thread-1");
		const subscribed = await connect();
		const other = await connect();
		subscribed.send({ type: "thread:subscribe", thread_id: "thread-1" });
		other.send({ type: "thread:subscribe", thread_id: "thread-2" });
		await Bun.sleep(10);

		srv.eventBus.emit("message:created", {
			message: { id: "m1", content: "hi", role: "user" },
			thread_id: "thread-1",
		});

		const got = await subscribed.waitFor((f) => f.type === "message:created", "message:created");
		expect((got.data as Frame).role).toBe("user");
		await other.expectQuiet("cross-thread leakage");
	});

	it("echoes a pong for an application heartbeat ping", async () => {
		const c = await connect();
		c.send({ type: "ping" });
		const pong = await c.waitFor((f) => f.type === "pong", "pong");
		expect(pong.type).toBe("pong");
	});

	it("rejects a schema-invalid frame with an invalid_message error", async () => {
		const c = await connect();
		// right shape for the discriminator, wrong field types
		c.send({ type: "thread:subscribe", thread_id: 42 as unknown as string });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("invalid_message");
	});

	it("rejects non-JSON text with an invalid_json error", async () => {
		const c = await connect();
		c.ws.send("definitely not json");
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("invalid_json");
	});

	it("persists a user message on message:send and emits message:created", async () => {
		seedThread(srv.db, "thread-send");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-send" });
		await Bun.sleep(10);

		let emitted: { thread_id: string } | undefined;
		srv.eventBus.on("message:created", (d) => {
			emitted = d as { thread_id: string };
		});

		c.send({ type: "message:send", thread_id: "thread-send", content: "hello there" });
		await c.waitFor((f) => f.type === "message:created", "echoed message:created");

		const rows = srv.db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND deleted = 0")
			.all("thread-send") as Array<{ role: string; content: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("user");
		expect(rows[0]?.content).toBe("hello there");
		expect(emitted?.thread_id).toBe("thread-send");
	});

	it("rejects an empty message:send with invalid_content and persists nothing", async () => {
		seedThread(srv.db, "thread-empty");
		const c = await connect();
		c.send({ type: "message:send", thread_id: "thread-empty", content: "   " });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("invalid_content");

		const rows = srv.db
			.query("SELECT id FROM messages WHERE thread_id = ?")
			.all("thread-empty") as unknown[];
		expect(rows).toHaveLength(0);
	});

	it("rejects message:send to an unknown thread with thread_not_found", async () => {
		const c = await connect();
		c.send({ type: "message:send", thread_id: "ghost", content: "hello" });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("thread_not_found");
	});

	it("stages a developer context message WITHOUT firing a turn", async () => {
		seedThread(srv.db, "thread-stage");
		const c = await connect();

		let fired = false;
		srv.eventBus.on("message:created", () => {
			fired = true;
		});

		c.send({ type: "context:stage", thread_id: "thread-stage", content: "remember X" });
		// no response frame on success, so settle then inspect the DB
		await Bun.sleep(40);

		const rows = srv.db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND deleted = 0")
			.all("thread-stage") as Array<{ role: string; content: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("developer");
		expect(rows[0]?.content).toBe("remember X");
		expect(fired).toBe(false);
	});

	it("delivers a client tool:call to the registered connection on session:configure", async () => {
		seedThread(srv.db, "thread-tool");
		const c = await connect();
		c.send({
			type: "session:configure",
			tools: [
				{
					type: "function",
					function: { name: "my_tool", description: "d", parameters: { type: "object" } },
				},
			],
		});
		c.send({ type: "thread:subscribe", thread_id: "thread-tool" });
		await Bun.sleep(20);

		// Seed a pending client-tool-call row so the configure-time redelivery
		// finds it (it walks getPendingClientToolCalls for subscribed threads).
		enqueueClientToolCall(
			srv.db,
			"thread-tool",
			{ call_id: "call-1", tool_name: "my_tool", arguments: { a: 1 } },
			"not-this-connection",
		);

		// Re-configure to trigger redeliverPendingToolCalls for the subscription.
		c.send({
			type: "session:configure",
			tools: [
				{
					type: "function",
					function: { name: "my_tool", description: "d", parameters: { type: "object" } },
				},
			],
		});

		const call = await c.waitFor((f) => f.type === "tool:call", "tool:call delivery");
		expect(call.call_id).toBe("call-1");
		expect(call.tool_name).toBe("my_tool");
		expect(call.arguments).toEqual({ a: 1 });
	});

	it("persists a client tool:result, caps it at 256 KiB, and acknowledges the dispatch", async () => {
		seedThread(srv.db, "thread-res");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-res" });
		await Bun.sleep(10);

		const messageId = enqueueClientToolCall(
			srv.db,
			"thread-res",
			{ call_id: "call-cap", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		// Oversized text content — well past the 256 KiB cap.
		const huge = "x".repeat(MAX_TOOL_RESULT_BYTES + 50_000);
		c.send({ type: "tool:result", call_id: "call-cap", thread_id: "thread-res", content: huge });

		await c.waitFor((f) => f.type === "message:created", "resumed message:created");

		const row = srv.db
			.query(
				"SELECT content, role, exit_code FROM messages WHERE thread_id = ? AND role = 'tool_result'",
			)
			.get("thread-res") as { content: string; role: string; exit_code: number } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no tool_result row");
		expect(row.role).toBe("tool_result");
		expect(row.exit_code).toBe(0);
		// Persisted content is the capped string — strictly smaller than input,
		// within the byte cap, and carries the truncation marker.
		expect(Buffer.byteLength(row.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES);
		expect(row.content).toContain("truncated");

		// The matching dispatch entry is no longer pending (acknowledged).
		const stillPending = getPendingClientToolCalls(srv.db, "thread-res").some(
			(e) => e.message_id === messageId,
		);
		expect(stillPending).toBe(false);
	});

	it("emits the tool result's changelog:written only after the persist transaction commits", async () => {
		seedThread(srv.db, "thread-commit");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-commit" });
		await Bun.sleep(10);
		enqueueClientToolCall(
			srv.db,
			"thread-commit",
			{ call_id: "call-commit", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		// Invariant #6: a changelog:written listener must never observe an open
		// transaction. A plain db.transaction() around insertRow demotes its inner
		// transaction to a savepoint and fires the event before the outer COMMIT.
		const inTxAtEmit: boolean[] = [];
		const onWritten = () => inTxAtEmit.push(srv.db.inTransaction);
		srv.eventBus.on("changelog:written", onWritten);
		setChangelogEventBus(srv.eventBus);
		try {
			c.send({
				type: "tool:result",
				call_id: "call-commit",
				thread_id: "thread-commit",
				content: "ok",
			});
			await c.waitFor((f) => f.type === "message:created", "resumed message:created");
		} finally {
			setChangelogEventBus(null);
			srv.eventBus.off("changelog:written", onWritten);
		}

		expect(inTxAtEmit.length).toBeGreaterThan(0);
		expect(inTxAtEmit.every((open) => open === false)).toBe(true);
	});

	it("marks an is_error tool:result with exit_code 1 and an Error-prefixed body", async () => {
		seedThread(srv.db, "thread-err");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-err" });
		await Bun.sleep(10);

		enqueueClientToolCall(
			srv.db,
			"thread-err",
			{ call_id: "call-err", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		c.send({
			type: "tool:result",
			call_id: "call-err",
			thread_id: "thread-err",
			content: "boom",
			is_error: true,
		});
		await c.waitFor((f) => f.type === "message:created", "resumed message:created");

		const row = srv.db
			.query("SELECT content, exit_code FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.get("thread-err") as { content: string; exit_code: number } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no tool_result row");
		expect(row.exit_code).toBe(1);
		expect(row.content).toContain("Error: boom");
	});

	it("rejects a tool:result for an unknown call_id with unknown_call_id", async () => {
		seedThread(srv.db, "thread-unknown");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-unknown" });
		await Bun.sleep(10);

		c.send({
			type: "tool:result",
			call_id: "never-dispatched",
			thread_id: "thread-unknown",
			content: "ignored",
		});
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("unknown_call_id");
		expect(err.call_id).toBe("never-dispatched");
	});

	it("silently discards a late tool:result for an expired (canceled) call", async () => {
		seedThread(srv.db, "thread-expired");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-expired" });
		await Bun.sleep(10);

		// Seed an expired client_tool_call row directly: cancellation marks the
		// dispatch 'expired', and a result arriving after that is accepted but
		// never persisted (AC3.4) with no error frame.
		const now = new Date().toISOString();
		srv.db
			.prepare(
				`INSERT INTO dispatch_queue (message_id, thread_id, status, event_type, event_payload, created_at, modified_at)
				 VALUES (?, ?, 'expired', 'client_tool_call', ?, ?, ?)`,
			)
			.run(
				crypto.randomUUID(),
				"thread-expired",
				JSON.stringify({ call_id: "call-late", tool_name: "my_tool", arguments: {} }),
				now,
				now,
			);

		c.send({
			type: "tool:result",
			call_id: "call-late",
			thread_id: "thread-expired",
			content: "too late",
		});
		await c.expectQuiet("any response to a late result");

		const rows = srv.db
			.query("SELECT id FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all("thread-expired") as unknown[];
		expect(rows).toHaveLength(0);
	});

	it("keeps the aux's single result when the call expires between lookup and persist (#278)", async () => {
		seedThread(srv.db, "thread-race");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-race" });
		await Bun.sleep(10);
		const entryId = enqueueClientToolCall(
			srv.db,
			"thread-race",
			{ call_id: "call-race", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		// The handler finds the entry in flight, then an aux loop gives up on the
		// call before the persist transaction opens: the aux wins the expiry and
		// writes the call's one result. The late client result must not add a
		// second tool_result row for the same call.
		const db = srv.db;
		const originalTransaction = db.transaction.bind(db);
		let raced = false;
		db.transaction = ((fn: Parameters<Database["transaction"]>[0]) => {
			if (!raced) {
				raced = true;
				db.transaction = originalTransaction;
				expect(expireClientToolCallIfInFlight(db, entryId)).toBe(true);
				const now = new Date().toISOString();
				insertRow(
					db,
					"messages",
					{
						id: crypto.randomUUID(),
						thread_id: "thread-race",
						role: "tool_result",
						content: JSON.stringify([{ type: "text", text: "Error: aux gave up" }]),
						model_id: null,
						tool_name: "call-race",
						created_at: now,
						modified_at: now,
						host_origin: "localhost:3000",
						deleted: 0,
						exit_code: 1,
						metadata: null,
					},
					SITE_ID,
				);
			}
			return originalTransaction(fn);
		}) as Database["transaction"];

		try {
			c.send({
				type: "tool:result",
				call_id: "call-race",
				thread_id: "thread-race",
				content: "real result, too late",
			});
			await c.expectQuiet("an error frame for the late result");
		} finally {
			db.transaction = originalTransaction;
		}

		expect(raced).toBe(true);
		const rows = db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.all("thread-race") as Array<{ content: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content).toContain("aux gave up");
		const status = db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { status: string } | null;
		expect(status?.status).toBe("expired");
	});

	it("cleans up connection state on client disconnect", async () => {
		seedThread(srv.db, "thread-close");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-close" });
		await Bun.sleep(10);

		c.close();
		await Bun.sleep(30);

		// After close, a message for the (now gone) subscription must not throw
		// inside the handler and reaches nobody. The server stays healthy for a
		// fresh client.
		srv.eventBus.emit("message:created", {
			message: { id: "mz", content: "after close", role: "user" },
			thread_id: "thread-close",
		});
		const fresh = await connect();
		fresh.send({ type: "ping" });
		const pong = await fresh.waitFor((f) => f.type === "pong", "pong after a prior disconnect");
		expect(pong.type).toBe("pong");
	});

	it("rewrites an inline base64 image on message:send into a file_ref and persists it as blocks", async () => {
		seedThread(srv.db, "thread-img");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-img" });
		await Bun.sleep(10);

		// 1x1 transparent PNG, base64.
		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		c.send({
			type: "message:send",
			thread_id: "thread-img",
			content: [
				{ type: "text", text: "look at this" },
				{
					type: "image",
					source: { type: "base64", media_type: "image/png", data: pngBase64 },
				},
			],
		});
		await c.waitFor((f) => f.type === "message:created", "echoed message:created");

		const row = srv.db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'user'")
			.get("thread-img") as { content: string } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no user row");
		// Persisted as a JSON ContentBlock[] because a non-text block is present.
		const blocks = JSON.parse(row.content) as Array<Record<string, unknown>>;
		const image = blocks.find((b) => b.type === "image") as
			{ source: { type: string; file_id?: string; data?: string } } | undefined;
		expect(image).toBeDefined();
		// The inline base64 was lifted out to a file_ref; the raw bytes are gone.
		expect(image?.source.type).toBe("file_ref");
		expect(typeof image?.source.file_id).toBe("string");
		expect(image?.source.data).toBeUndefined();
		// And the referenced file row exists.
		const fileRow = srv.db
			.query("SELECT id FROM files WHERE id = ? AND deleted = 0")
			.get(image?.source.file_id ?? "") as { id: string } | null;
		expect(fileRow).not.toBeNull();
	});

	it("rejects a message:send image attachment over the 10 MB cap with content_too_large", async () => {
		seedThread(srv.db, "thread-big");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-big" });
		await Bun.sleep(10);

		// 11 MB of zero bytes, base64-encoded, exceeds MAX_ATTACHMENT_BYTES (10 MB).
		const oversized = Buffer.alloc(11 * 1024 * 1024).toString("base64");
		c.send({
			type: "message:send",
			thread_id: "thread-big",
			content: [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: oversized } },
			],
		});
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("content_too_large");

		const rows = srv.db
			.query("SELECT id FROM messages WHERE thread_id = ?")
			.all("thread-big") as unknown[];
		expect(rows).toHaveLength(0);
	});

	it("updates the thread model_hint when message:send carries a model_id", async () => {
		seedThread(srv.db, "thread-model");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-model" });
		await Bun.sleep(10);

		c.send({
			type: "message:send",
			thread_id: "thread-model",
			content: "pick a model",
			model_id: "opus-4.8",
		});
		await c.waitFor((f) => f.type === "message:created", "echoed message:created");

		const row = srv.db.query("SELECT model_hint FROM threads WHERE id = ?").get("thread-model") as {
			model_hint: string | null;
		} | null;
		expect(row?.model_hint).toBe("opus-4.8");
	});

	it("persists a ContentBlock-array tool:result verbatim after lightening image blocks", async () => {
		seedThread(srv.db, "thread-blockres");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-blockres" });
		await Bun.sleep(10);

		enqueueClientToolCall(
			srv.db,
			"thread-blockres",
			{ call_id: "call-block", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		const pngBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
		c.send({
			type: "tool:result",
			call_id: "call-block",
			thread_id: "thread-blockres",
			content: [
				{ type: "text", text: "here is the screenshot" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: pngBase64 } },
			],
		});
		await c.waitFor((f) => f.type === "message:created", "resumed message:created");

		const row = srv.db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.get("thread-blockres") as { content: string } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no tool_result row");
		const blocks = JSON.parse(row.content) as Array<Record<string, unknown>>;
		expect(blocks.some((b) => b.type === "text")).toBe(true);
		const image = blocks.find((b) => b.type === "image") as
			{ source: { type: string; data?: string } } | undefined;
		expect(image).toBeDefined();
		// The screenshot-sized base64 was lightened to a file_ref, not left inline.
		expect(image?.source.type).toBe("file_ref");
		expect(image?.source.data).toBeUndefined();
	});

	it("appends file_ids as a text attachment on a text message:send", async () => {
		seedThread(srv.db, "thread-fileids");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-fileids" });
		await Bun.sleep(10);

		// Seed a files-table row the message will reference by id.
		const now = new Date().toISOString();
		insertRow(
			srv.db,
			"files",
			{
				id: "file-xyz",
				path: "/home/user/uploads/report.txt",
				content: "hello",
				is_binary: 0,
				size_bytes: 5,
				created_at: now,
				modified_at: now,
				deleted: 0,
				created_by: USER_ID,
				host_origin: "localhost:3000",
			},
			SITE_ID,
		);

		c.send({
			type: "message:send",
			thread_id: "thread-fileids",
			content: "see attached",
			file_ids: ["file-xyz"],
		});
		await c.waitFor((f) => f.type === "message:created", "echoed message:created");

		const row = srv.db
			.query("SELECT content FROM messages WHERE thread_id = ? AND role = 'user'")
			.get("thread-fileids") as { content: string } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no user row");
		expect(row.content).toContain("see attached");
		expect(row.content).toContain("report.txt");
		expect(row.content).toContain("/home/user/uploads/report.txt");
	});

	it("removes a subscription on thread:unsubscribe so later events are not delivered", async () => {
		seedThread(srv.db, "thread-unsub");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-unsub" });
		await Bun.sleep(10);

		srv.eventBus.emit("message:created", {
			message: { id: "before", content: "before", role: "user" },
			thread_id: "thread-unsub",
		});
		await c.waitFor((f) => f.type === "message:created", "first delivery");

		c.send({ type: "thread:unsubscribe", thread_id: "thread-unsub" });
		await Bun.sleep(10);
		const countBefore = c.frames.length;

		srv.eventBus.emit("message:created", {
			message: { id: "after", content: "after", role: "user" },
			thread_id: "thread-unsub",
		});
		await Bun.sleep(40);
		expect(c.frames.length).toBe(countBefore);
	});

	it("delivers alert:created only to clients subscribed to the alert thread", async () => {
		seedThread(srv.db, "thread-alert");
		const subscribed = await connect();
		const other = await connect();
		subscribed.send({ type: "thread:subscribe", thread_id: "thread-alert" });
		other.send({ type: "thread:subscribe", thread_id: "thread-other" });
		await Bun.sleep(10);

		srv.eventBus.emit("alert:created", {
			message: { id: "a1", content: "heads up", role: "assistant" } as never,
			thread_id: "thread-alert",
		});
		const got = await subscribed.waitFor((f) => f.type === "alert", "alert frame");
		expect((got.data as Frame).id).toBe("a1");
		await other.expectQuiet("cross-thread alert leakage");
	});

	it("broadcasts background:count to subscribed clients", async () => {
		seedThread(srv.db, "thread-bg");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-bg" });
		// Subscribe itself seeds a background:count frame (count 0, to clear any
		// stale cached value on reconnect); wait that out before emitting.
		await c.waitFor((f) => f.type === "background:count", "subscribe-seeded count");
		srv.eventBus.emit("background:count", { thread_id: "thread-bg", count: 3 });
		const got = await c.waitFor(
			(f) => f.type === "background:count" && f.count === 3,
			"background:count=3",
		);
		expect(got.count).toBe(3);
		expect(got.thread_id).toBe("thread-bg");
	});

	it("broadcasts stream:chunk to subscribed clients only", async () => {
		seedThread(srv.db, "thread-stream");
		const subscribed = await connect();
		const other = await connect();
		subscribed.send({ type: "thread:subscribe", thread_id: "thread-stream" });
		other.send({ type: "thread:subscribe", thread_id: "thread-stream-2" });
		await Bun.sleep(10);

		srv.eventBus.emit("stream:chunk", {
			thread_id: "thread-stream",
			chunk: { type: "text", content: "partial" },
		});
		const got = await subscribed.waitFor((f) => f.type === "stream:chunk", "stream:chunk");
		expect(got.thread_id).toBe("thread-stream");
		expect((got.chunk as Frame).content).toBe("partial");
		await other.expectQuiet("cross-thread stream leakage");
	});

	it("broadcasts yard:execution to subscribed clients", async () => {
		seedThread(srv.db, "thread-yard");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-yard" });
		await Bun.sleep(10);
		srv.eventBus.emit("yard:execution", {
			thread_id: "thread-yard",
			trace_id: "tr-1",
			run_id: "run-1",
			node_id: "node-1",
			parent_id: null,
			seq: 0,
			phase: "started",
			node: { kind: "run", depth: 0 },
		});
		const got = await c.waitFor((f) => f.type === "yard:execution", "yard:execution");
		expect(got.node_id).toBe("node-1");
		expect(got.phase).toBe("started");
	});

	it("delivers a tool:call on client_tool_call:created to the connection holding the tool", async () => {
		seedThread(srv.db, "thread-ctc");
		const c = await connect();
		c.send({
			type: "session:configure",
			tools: [
				{
					type: "function",
					function: { name: "live_tool", description: "d", parameters: { type: "object" } },
				},
			],
		});
		c.send({ type: "thread:subscribe", thread_id: "thread-ctc" });
		await Bun.sleep(20);

		// Seed the dispatch row the agent loop would have written, then fire the
		// same event the loop emits when a client tool is dispatched.
		const entryId = enqueueClientToolCall(
			srv.db,
			"thread-ctc",
			{ call_id: "live-1", tool_name: "live_tool", arguments: { q: "x" } },
			"placeholder",
		);
		srv.eventBus.emit("client_tool_call:created", {
			threadId: "thread-ctc",
			callId: "live-1",
			entryId,
			toolName: "live_tool",
			arguments: { q: "x" },
		});

		const call = await c.waitFor((f) => f.type === "tool:call", "tool:call delivery");
		expect(call.call_id).toBe("live-1");
		expect(call.tool_name).toBe("live_tool");
		expect(call.arguments).toEqual({ q: "x" });

		// Delivery claims the dispatch row for this connection ('processing').
		const claimed = srv.db
			.query("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { status: string } | null;
		expect(claimed?.status).toBe("processing");
	});

	it("synthesizes an error tool_result and resumes the loop when a connection holding an in-flight tool disconnects", async () => {
		seedThread(srv.db, "thread-disc");
		const c = await connect();
		c.send({
			type: "session:configure",
			tools: [
				{
					type: "function",
					function: { name: "slow_tool", description: "d", parameters: { type: "object" } },
				},
			],
		});
		c.send({ type: "thread:subscribe", thread_id: "thread-disc" });
		await Bun.sleep(20);

		// Dispatch a client tool and deliver it so the dispatch row is claimed by
		// this connection and sits 'processing' (an in-flight call).
		const entryId = enqueueClientToolCall(
			srv.db,
			"thread-disc",
			{ call_id: "inflight-1", tool_name: "slow_tool", arguments: {} },
			"placeholder",
		);
		srv.eventBus.emit("client_tool_call:created", {
			threadId: "thread-disc",
			callId: "inflight-1",
			entryId,
			toolName: "slow_tool",
			arguments: {},
		});
		await c.waitFor((f) => f.type === "tool:call", "tool:call delivery");

		let resumed = false;
		srv.eventBus.on("message:created", () => {
			resumed = true;
		});

		// The client vanishes mid-call. closeConnection expires the in-flight call,
		// synthesizes a paired error tool_result, and emits message:created to
		// re-drive the loop.
		c.close();
		await Bun.sleep(60);

		const errRow = srv.db
			.query("SELECT content, tool_name FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.get("thread-disc") as { content: string; tool_name: string } | null;
		expect(errRow).not.toBeNull();
		if (!errRow) throw new Error("no synthesized error tool_result");
		expect(errRow.tool_name).toBe("inflight-1");
		expect(errRow.content).toContain("session_reset");
		expect(resumed).toBe(true);
	});

	it("surfaces a tool_result_failed error frame when persistence throws mid-handler", async () => {
		seedThread(srv.db, "thread-dberr");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-dberr" });
		await Bun.sleep(10);

		enqueueClientToolCall(
			srv.db,
			"thread-dberr",
			{ call_id: "call-dberr", tool_name: "my_tool", arguments: {} },
			"conn",
		);

		// Drop the messages table so the insert inside handleToolResult throws
		// after the matching dispatch entry is found — exercising the catch path
		// that returns a tool_result_failed error frame.
		srv.db.run("DROP TABLE messages");

		c.send({
			type: "tool:result",
			call_id: "call-dberr",
			thread_id: "thread-dberr",
			content: "result",
		});
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("tool_result_failed");
		expect(typeof err.message).toBe("string");
	});

	it("enriches an assistant message:created with cache_usage when the thread's latest turn read/wrote cache", async () => {
		seedThread(srv.db, "thread-cache");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-cache" });
		await Bun.sleep(10);

		// Seed a turns row for this thread with a positive cache-read count so the
		// handleMessageCreated enrichment branch fires for an assistant message.
		const now = new Date().toISOString();
		insertRow(
			srv.db,
			"turns",
			{
				id: crypto.randomUUID(),
				thread_id: "thread-cache",
				task_id: null,
				dag_root_id: null,
				model_id: "opus-4.8",
				tokens_in: 100,
				tokens_out: 20,
				cost_usd: null,
				created_at: now,
				relay_target: null,
				relay_latency_ms: null,
				tokens_cache_write: 0,
				tokens_cache_read: 512,
				context_debug: null,
				status: null,
				host_origin: "localhost:3000",
				modified_at: now,
			},
			SITE_ID,
		);

		srv.eventBus.emit("message:created", {
			message: {
				id: "asst-1",
				thread_id: "thread-cache",
				role: "assistant",
				content: "an answer",
				metadata: JSON.stringify({ existing: "kept" }),
			},
			thread_id: "thread-cache",
		});

		const got = await c.waitFor((f) => f.type === "message:created", "assistant message:created");
		const delivered = got.data as { role: string; metadata: string };
		expect(delivered.role).toBe("assistant");
		const meta = JSON.parse(delivered.metadata) as Record<string, unknown>;
		// Pre-existing metadata survives, cache_usage is layered on.
		expect(meta.existing).toBe("kept");
		expect(meta.cache_usage).toEqual({ read: 512, write: 0 });
	});

	it("rejects a context:stage with empty staged text as invalid_content", async () => {
		seedThread(srv.db, "thread-stage-empty");
		const c = await connect();
		c.send({ type: "context:stage", thread_id: "thread-stage-empty", content: "   " });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("invalid_content");

		const rows = srv.db
			.query("SELECT id FROM messages WHERE thread_id = ?")
			.all("thread-stage-empty") as unknown[];
		expect(rows).toHaveLength(0);
	});

	it("rejects a context:stage to an unknown thread with thread_not_found", async () => {
		const c = await connect();
		c.send({ type: "context:stage", thread_id: "ghost-stage", content: "remember Y" });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("thread_not_found");
	});

	it("flattens a block-form context:stage to joined text and persists it as a developer row", async () => {
		seedThread(srv.db, "thread-stage-block");
		const c = await connect();
		c.send({
			type: "context:stage",
			thread_id: "thread-stage-block",
			content: [
				{ type: "text", text: "first line" },
				{ type: "text", text: "second line" },
			],
		});
		// No success frame; settle then read the DB.
		await Bun.sleep(40);

		const row = srv.db
			.query("SELECT role, content FROM messages WHERE thread_id = ? AND deleted = 0")
			.get("thread-stage-block") as { role: string; content: string } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no developer row");
		expect(row.role).toBe("developer");
		expect(row.content).toBe("first line\n\nsecond line");
	});

	it("surfaces a context_stage_failed error frame when persistence throws mid-handler", async () => {
		seedThread(srv.db, "thread-stage-dberr");
		const c = await connect();
		// Drop the messages table so the insert inside handleContextStage throws
		// after validation and thread lookup succeed — exercising the catch path.
		srv.db.run("DROP TABLE messages");
		c.send({ type: "context:stage", thread_id: "thread-stage-dberr", content: "stage me" });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("context_stage_failed");
		expect(typeof err.message).toBe("string");
	});

	it("surfaces a message_send_failed error frame when persistence throws mid-handler", async () => {
		seedThread(srv.db, "thread-send-dberr");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-send-dberr" });
		await Bun.sleep(10);

		// Drop the messages table so the insert inside handleMessageSend throws
		// after the thread lookup passes — exercising the catch that returns a
		// message_send_failed error frame.
		srv.db.run("DROP TABLE messages");
		c.send({ type: "message:send", thread_id: "thread-send-dberr", content: "hello" });
		const err = await c.waitFor((f) => f.type === "error", "error frame");
		expect(err.code).toBe("message_send_failed");
		expect(typeof err.message).toBe("string");
	});

	it("broadcasts aux:started only to clients subscribed to the parent thread", async () => {
		seedThread(srv.db, "thread-parent");
		const subscribed = await connect();
		const other = await connect();
		subscribed.send({ type: "thread:subscribe", thread_id: "thread-parent" });
		other.send({ type: "thread:subscribe", thread_id: "thread-elsewhere" });
		await Bun.sleep(10);

		srv.eventBus.emit("aux:started", {
			parent_thread_id: "thread-parent",
			aux_thread_id: "aux-1",
			name: "implementer",
		} as never);
		const got = await subscribed.waitFor((f) => f.type === "aux:started", "aux:started");
		expect((got.data as Frame).aux_thread_id).toBe("aux-1");
		await other.expectQuiet("cross-thread aux leakage");
	});

	it("broadcasts aux:completed to a client subscribed to the parent thread", async () => {
		seedThread(srv.db, "thread-parent-done");
		const c = await connect();
		c.send({ type: "thread:subscribe", thread_id: "thread-parent-done" });
		await Bun.sleep(10);

		srv.eventBus.emit("aux:completed", {
			parent_thread_id: "thread-parent-done",
			aux_thread_id: "aux-2",
			name: "implementer",
		} as never);
		const got = await c.waitFor((f) => f.type === "aux:completed", "aux:completed");
		expect((got.data as Frame).aux_thread_id).toBe("aux-2");
	});

	it("reaps client_sessions rows whose connection is no longer live", async () => {
		// Seed a client_sessions row for a connection id that is not among the
		// live sockets, plus one for a live-looking id we also won't connect — both
		// are stale, so reapStaleSessions soft-deletes them and returns the count.
		const now = new Date().toISOString();
		insertRow(
			srv.db,
			"client_sessions",
			{
				id: "sess-stale",
				connection_id: "gone-conn",
				thread_id: "thread-reap",
				site_id: SITE_ID,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			SITE_ID,
		);

		const reaped = srv.handler.reapStaleSessions();
		expect(reaped).toBeGreaterThanOrEqual(1);

		const row = srv.db
			.query("SELECT deleted FROM client_sessions WHERE id = ?")
			.get("sess-stale") as { deleted: number } | null;
		expect(row).not.toBeNull();
		expect(row?.deleted).toBe(1);
	});

	it("resolves the cancel target via the entry.claimed_by branch and synthesizes a tool_result", async () => {
		seedThread(srv.db, "thread-claimedby");
		// A live connection holds the tool and is subscribed. We drive
		// emitToolCancel directly with reason 'dispatch_expired' and NO
		// claimedByConnectionId (the thread-cancel / TTL-expiry call shape, as
		// opposed to the connection-close shape which always passes one). With no
		// claimedByConnectionId, target resolution falls to the entry.claimed_by
		// branch, which matches the holder's connectionId and sends it a cancel.
		const holder = await connect();
		holder.send({
			type: "session:configure",
			tools: [
				{
					type: "function",
					function: { name: "held_tool", description: "d", parameters: { type: "object" } },
				},
			],
		});
		holder.send({ type: "thread:subscribe", thread_id: "thread-claimedby" });
		await Bun.sleep(20);

		// Deliver a client tool call to the holder through the real event path so
		// the dispatch row is claimed ('processing') by the holder's connection id
		// — that id is the value the entry.claimed_by branch must match.
		const entryId = enqueueClientToolCall(
			srv.db,
			"thread-claimedby",
			{ call_id: "claimed-1", tool_name: "held_tool", arguments: {} },
			"placeholder",
		);
		srv.eventBus.emit("client_tool_call:created", {
			threadId: "thread-claimedby",
			callId: "claimed-1",
			entryId,
			toolName: "held_tool",
			arguments: {},
		});
		await holder.waitFor((f) => f.type === "tool:call", "tool:call delivery");

		// Read back the connection id the delivery claimed the dispatch row for.
		const claimed = srv.db
			.query("SELECT claimed_by FROM dispatch_queue WHERE message_id = ?")
			.get(entryId) as { claimed_by: string | null } | null;
		const holderConnId = claimed?.claimed_by;
		expect(typeof holderConnId).toBe("string");
		if (!holderConnId) throw new Error("dispatch row not claimed by the holder");

		// Drive emitToolCancel directly with reason 'dispatch_expired' and NO
		// claimedByConnectionId (the thread-cancel / TTL-expiry call shape, as
		// opposed to the connection-close shape which always passes one). With no
		// claimedByConnectionId, target resolution falls to the entry.claimed_by
		// branch, which matches the holder's connectionId and sends it a cancel.
		srv.handler.emitToolCancel(
			[
				{
					event_payload: JSON.stringify({ call_id: "claimed-1", tool_name: "held_tool" }),
					claimed_by: holderConnId,
					message_id: crypto.randomUUID(),
				},
			],
			"thread-claimedby",
			"dispatch_expired",
		);

		// The holder receives a tool:cancel frame for the claimed call.
		const cancel = await holder.waitFor(
			(f) => f.type === "tool:cancel" && f.call_id === "claimed-1",
			"tool:cancel to the claiming connection",
		);
		expect(cancel.reason).toBe("dispatch_expired");

		// dispatch_expired synthesizes a paired error tool_result row.
		await Bun.sleep(20);
		const row = srv.db
			.query("SELECT content, tool_name FROM messages WHERE thread_id = ? AND role = 'tool_result'")
			.get("thread-claimedby") as { content: string; tool_name: string } | null;
		expect(row).not.toBeNull();
		if (!row) throw new Error("no synthesized tool_result");
		expect(row.tool_name).toBe("claimed-1");
		expect(row.content).toContain("dispatch_expired");
	});
});
