import Database from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	acknowledgeClientToolCall,
	applySchema,
	enqueueToolResult,
	findToolResultByThreadAndCallId,
	insertRow,
} from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { dispatchAwaitableClientTool } from "../client-tool-dispatch";

function seedThread(db: Database, threadId: string, siteId: string) {
	const now = new Date().toISOString();
	insertRow(
		db,
		"threads",
		{
			id: threadId,
			user_id: "user-1",
			interface: "boundless",
			host_origin: siteId,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
		},
		siteId,
	);
}

describe("dispatchAwaitableClientTool", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	const threadId = "thread-1";
	const siteId = "site-1";

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		seedThread(db, threadId, siteId);
	});

	it("dispatches to a local WS connection and resolves the persisted result inline", async () => {
		const events: Array<{ callId: string; entryId: string; connectionId?: string }> = [];
		eventBus.on("client_tool_call:created", (event) => {
			events.push(event);
			setTimeout(() => {
				const now = new Date().toISOString();
				acknowledgeClientToolCall(db, event.entryId);
				enqueueToolResult(db, threadId, event.callId);
				insertRow(
					db,
					"messages",
					{
						id: "result-1",
						thread_id: threadId,
						role: "tool_result",
						content: '"hello"',
						model_id: null,
						tool_name: event.callId,
						created_at: now,
						modified_at: now,
						host_origin: siteId,
						deleted: 0,
						exit_code: 0,
						metadata: null,
					},
					siteId,
				);
				eventBus.emit("message:created", {
					message: {} as never,
					thread_id: threadId,
				});
			}, 5);
		});

		const result = await dispatchAwaitableClientTool({
			db,
			eventBus,
			siteId,
			threadId,
			toolName: "boundless_read",
			args: { file_path: "README.md" },
			connectionId: "conn-1",
			timeoutMs: 1000,
		});

		expect(result).toEqual({ content: '"hello"', isError: false });
		expect(events).toHaveLength(1);
		expect(events[0]?.connectionId).toBeUndefined();
		const dispatchRow = db
			.prepare("SELECT status FROM dispatch_queue WHERE message_id = ?")
			.get(events[0]?.entryId) as { status: string };
		// Inline consumer owns continuation: close the WS handler's re-wake so
		// another agent loop cannot consume the same result.
		expect(dispatchRow.status).toBe("acknowledged");
	});

	it("aborts while awaiting a local client result", async () => {
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 10);
		const result = await dispatchAwaitableClientTool({
			db,
			eventBus,
			siteId,
			threadId,
			toolName: "boundless_bash",
			args: { command: "sleep 10" },
			connectionId: "conn-1",
			timeoutMs: 5000,
			signal: abort.signal,
		});
		expect(result).toBeNull();
	});

	it("does not persist a duplicate result itself", async () => {
		eventBus.on("client_tool_call:created", (event) => {
			setTimeout(() => {
				const now = new Date().toISOString();
				insertRow(
					db,
					"messages",
					{
						id: "only-result",
						thread_id: threadId,
						role: "tool_result",
						content: "ok",
						model_id: null,
						tool_name: event.callId,
						created_at: now,
						modified_at: now,
						host_origin: siteId,
						deleted: 0,
						exit_code: 0,
						metadata: null,
					},
					siteId,
				);
				eventBus.emit("message:created", { message: {} as never, thread_id: threadId });
			}, 5);
		});
		await dispatchAwaitableClientTool({
			db,
			eventBus,
			siteId,
			threadId,
			toolName: "boundless_read",
			args: {},
			connectionId: "conn-1",
			timeoutMs: 1000,
		});
		const row = findToolResultByThreadAndCallId(db, threadId, "yard-client-1");
		// Generated call IDs are opaque; assert total rows instead.
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='tool_result'")
			.get() as { n: number };
		expect(count.n).toBe(1);
		expect(row).toBeNull();
	});

	it("relays to a remote session host and awaits client_result", async () => {
		const now = new Date().toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: "remote-site",
				host_name: "remote-host",
				sync_url: null,
				online_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);
		insertRow(
			db,
			"client_sessions",
			{
				id: "remote-conn::thread-1",
				connection_id: "remote-conn",
				thread_id: threadId,
				site_id: "remote-site",
				created_at: now,
				modified_at: now,
				deleted: 0,
			},
			siteId,
		);

		const pending = dispatchAwaitableClientTool({
			db,
			eventBus,
			siteId,
			threadId,
			toolName: "boundless_read",
			args: { file_path: "README.md" },
			timeoutMs: 1000,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		const outbox = db
			.prepare("SELECT id, target_site_id, kind, payload FROM relay_outbox LIMIT 1")
			.get() as {
			id: string;
			target_site_id: string;
			kind: string;
			payload: string;
		};
		expect(outbox.kind).toBe("client_tool");
		expect(outbox.target_site_id).toBe("remote-site");
		const request = JSON.parse(outbox.payload) as { call_id: string };
		db.prepare(
			`INSERT INTO relay_inbox (id, source_site_id, kind, ref_id, idempotency_key, stream_id, payload, expires_at, received_at, processed)
			 VALUES (?, ?, 'client_result', ?, NULL, NULL, ?, ?, ?, 0)`,
		).run(
			"remote-result",
			"remote-site",
			outbox.id,
			JSON.stringify({ call_id: request.call_id, content: '"remote"', is_error: false }),
			new Date(Date.now() + 60_000).toISOString(),
			new Date().toISOString(),
		);
		eventBus.emit("relay:inbox", { ref_id: outbox.id, kind: "client_result" });

		expect(await pending).toEqual({ content: '"remote"', isError: false });
	});
});
