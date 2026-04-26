import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, createDatabase } from "@bound/core";
import type { Hono } from "hono";
import { createThreadsRoutes } from "../routes/threads";

type ListedThread = {
	id: string;
	title: string | null;
	messageCount: number;
	active: boolean;
};

describe("GET /api/threads empty-thread filter", () => {
	let db: Database;
	let app: Hono;
	const operatorId = "test-operator";

	function insertThread(id: string, title: string): void {
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run(id, operatorId, "web", "localhost:3000", 0, title, now, now, now);
	}

	function insertMessage(threadId: string, role: string, opts: { deleted?: boolean } = {}): void {
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, host_origin, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			`${threadId}-msg-${role}-${Math.random()}`,
			threadId,
			role,
			"x",
			now,
			now,
			"localhost:3000",
			opts.deleted ? 1 : 0,
		);
	}

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		app = createThreadsRoutes(db, operatorId);
	});

	it("hides threads whose only messages are non-user roles", async () => {
		insertThread("t-system-only", "system only");
		insertMessage("t-system-only", "system");
		insertMessage("t-system-only", "tool_call");
		insertMessage("t-system-only", "assistant");

		insertThread("t-with-user", "has user msg");
		insertMessage("t-with-user", "user");

		const res = await app.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		const threads = (await res.json()) as ListedThread[];
		const ids = threads.map((t) => t.id);
		expect(ids).toContain("t-with-user");
		expect(ids).not.toContain("t-system-only");
	});

	it("hides threads with zero messages", async () => {
		insertThread("t-empty", "no messages at all");

		const res = await app.fetch(new Request("http://localhost/"));
		const threads = (await res.json()) as ListedThread[];
		expect(threads.map((t) => t.id)).not.toContain("t-empty");
	});

	it("hides a thread whose only user message is soft-deleted", async () => {
		insertThread("t-deleted-user", "deleted user msg");
		insertMessage("t-deleted-user", "user", { deleted: true });
		insertMessage("t-deleted-user", "assistant");

		const res = await app.fetch(new Request("http://localhost/"));
		const threads = (await res.json()) as ListedThread[];
		expect(threads.map((t) => t.id)).not.toContain("t-deleted-user");
	});

	it("includes empty threads when include_empty=true", async () => {
		insertThread("t-system-only", "system only");
		insertMessage("t-system-only", "system");

		insertThread("t-with-user", "has user msg");
		insertMessage("t-with-user", "user");

		const res = await app.fetch(new Request("http://localhost/?include_empty=true"));
		const threads = (await res.json()) as ListedThread[];
		const ids = threads.map((t) => t.id);
		expect(ids).toContain("t-system-only");
		expect(ids).toContain("t-with-user");
	});

	it("still returns messageCount and active fields for visible threads", async () => {
		insertThread("t-visible", "visible");
		insertMessage("t-visible", "user");
		insertMessage("t-visible", "assistant");
		insertMessage("t-visible", "system");

		const res = await app.fetch(new Request("http://localhost/"));
		const threads = (await res.json()) as ListedThread[];
		const visible = threads.find((t) => t.id === "t-visible");
		expect(visible).toBeDefined();
		expect(visible?.messageCount).toBe(3);
		expect(visible?.active).toBe(false);
	});
});
