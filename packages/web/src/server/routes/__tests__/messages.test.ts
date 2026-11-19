import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, insertRow } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createMessagesRoutes } from "../messages";

// createMessagesRoutes serves the per-thread message list and the redaction
// endpoints. These tests seed threads + messages directly and drive every
// handler branch: the list (with/without limit, 404), the removed POST, and
// the single-message and whole-thread redaction (including the 404 and the
// cascade to source-thread memories).

const SITE = "test-site";

function seedThread(db: Database, id: string, deleted = 0): void {
	const now = "2026-07-04T00:00:00.000Z";
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: "operator",
			interface: "web",
			host_origin: SITE,
			color: 0,
			title: "A thread",
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			model_hint: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted,
		},
		SITE,
	);
}

function seedMessage(
	db: Database,
	id: string,
	threadId: string,
	content: string,
	createdAt: string,
): void {
	insertRow(
		db,
		"messages",
		{
			id,
			thread_id: threadId,
			role: "user",
			content,
			model_id: null,
			tool_name: null,
			created_at: createdAt,
			modified_at: createdAt,
			host_origin: SITE,
			exit_code: null,
			metadata: null,
			deleted: 0,
		},
		SITE,
	);
}

function post(app: ReturnType<typeof createMessagesRoutes>, path: string) {
	return app.request(path, { method: "POST" });
}

describe("messages routes", () => {
	let db: Database;
	let app: ReturnType<typeof createMessagesRoutes>;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", SITE);
		app = createMessagesRoutes(db, new TypedEventEmitter());
	});

	afterEach(() => {
		db.close();
	});

	describe("GET /:threadId/messages", () => {
		it("lists messages in chronological order", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "first", "2026-07-04T00:00:01.000Z");
			seedMessage(db, "m2", "t1", "second", "2026-07-04T00:00:02.000Z");
			const res = await app.request("/t1/messages");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { id: string; content: string }[];
			expect(body.map((m) => m.content)).toEqual(["first", "second"]);
		});

		it("404s an unknown thread", async () => {
			const res = await app.request("/nope/messages");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Thread not found");
		});

		it("returns the newest N messages in chronological order when limit is set", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "oldest", "2026-07-04T00:00:01.000Z");
			seedMessage(db, "m2", "t1", "middle", "2026-07-04T00:00:02.000Z");
			seedMessage(db, "m3", "t1", "newest", "2026-07-04T00:00:03.000Z");
			const res = await app.request("/t1/messages?limit=2");
			expect(res.status).toBe(200);
			const body = (await res.json()) as { content: string }[];
			// Newest 2, returned oldest-first.
			expect(body.map((m) => m.content)).toEqual(["middle", "newest"]);
		});

		it("clamps a non-numeric limit to the default floor and still lists", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "only", "2026-07-04T00:00:01.000Z");
			const res = await app.request("/t1/messages?limit=notnum");
			expect(res.status).toBe(200);
			expect((await res.json()).length).toBe(1);
		});

		it("returns 500 when the query throws", async () => {
			db.close();
			const res = await app.request("/t1/messages");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to list messages");
		});
	});

	describe("POST /:threadId/messages (removed)", () => {
		it("returns 404 directing clients to the WebSocket path", async () => {
			const res = await post(app, "/t1/messages");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toContain("Use WebSocket message:send");
		});
	});

	describe("POST /:threadId/messages/:messageId/redact", () => {
		it("redacts a single message", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "secret", "2026-07-04T00:00:01.000Z");
			const res = await post(app, "/t1/messages/m1/redact");
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ redacted: true, messageId: "m1" });
			const row = db.query("SELECT content FROM messages WHERE id = ?").get("m1") as {
				content: string;
			};
			expect(row.content).toBe("[redacted]");
		});

		it("404s when the thread does not exist", async () => {
			const res = await post(app, "/nope/messages/m1/redact");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Thread not found");
		});

		it("404s when the message does not exist in the thread", async () => {
			seedThread(db, "t1");
			const res = await post(app, "/t1/messages/ghost/redact");
			expect(res.status).toBe(404);
			expect((await res.json()).error).toBe("Message not found");
		});

		it("returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/t1/messages/m1/redact");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to redact message");
		});
	});

	describe("POST /:threadId/redact", () => {
		it("redacts the whole thread and reports counts", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "a", "2026-07-04T00:00:01.000Z");
			seedMessage(db, "m2", "t1", "b", "2026-07-04T00:00:02.000Z");
			const res = await post(app, "/t1/redact");
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				redacted: boolean;
				threadId: string;
				messagesRedacted: number;
				memoriesAffected: number;
			};
			expect(body.redacted).toBe(true);
			expect(body.threadId).toBe("t1");
			expect(body.messagesRedacted).toBe(2);
			expect(body.memoriesAffected).toBe(0);
			const rows = db.query("SELECT content FROM messages WHERE thread_id = ?").all("t1") as {
				content: string;
			}[];
			expect(rows.every((r) => r.content === "[redacted]")).toBe(true);
		});

		it("tombstones source-thread memories in the count", async () => {
			seedThread(db, "t1");
			seedMessage(db, "m1", "t1", "a", "2026-07-04T00:00:01.000Z");
			insertRow(
				db,
				"semantic_memory",
				{
					id: "mem-1",
					key: "from-thread",
					value: "v",
					source: "t1",
					tier: "default",
					created_at: "2026-07-04T00:00:00.000Z",
					modified_at: "2026-07-04T00:00:00.000Z",
					last_accessed_at: null,
					agent_id: null,
					deleted: 0,
				},
				SITE,
			);
			const body = (await (await post(app, "/t1/redact")).json()) as {
				memoriesAffected: number;
			};
			expect(body.memoriesAffected).toBe(1);
		});

		it("404s when the thread does not exist", async () => {
			const res = await post(app, "/nope/redact");
			expect(res.status).toBe(404);
		});

		it("returns 500 when the lookup throws", async () => {
			db.close();
			const res = await post(app, "/t1/redact");
			expect(res.status).toBe(500);
			expect((await res.json()).error).toBe("Failed to redact thread");
		});
	});
});
