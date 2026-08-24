import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase } from "@bound/core";
import { createThreadsRoutes } from "../routes/threads";

const USER_ID = "operator";
const THREAD_ID = "thread-rename";

describe("PATCH /api/threads/:id", () => {
	let db: Database;
	let app: ReturnType<typeof createThreadsRoutes>;

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", randomUUID()]);
		const now = new Date().toISOString();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			[THREAD_ID, USER_ID, "web", "test", 0, "Old title", now, now, now],
		);
		app = createThreadsRoutes(db, USER_ID);
	});

	afterEach(() => db.close());

	async function rename(title: unknown) {
		return app.request(`http://localhost/${THREAD_ID}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
	}

	it("renames a live thread through the synced outbox", async () => {
		const response = await rename("New title");
		expect(response.status).toBe(200);
		expect((await response.json()).title).toBe("New title");
		expect(db.query("SELECT title FROM threads WHERE id = ?").get(THREAD_ID)).toEqual({
			title: "New title",
		});
		expect(
			db
				.query(
					"SELECT COUNT(*) AS count FROM change_log WHERE table_name = 'threads' AND row_id = ?",
				)
				.get(THREAD_ID),
		).toEqual({ count: 1 });
	});

	it("rejects empty titles", async () => {
		const response = await rename("   ");
		expect(response.status).toBe(400);
	});

	it("rejects titles longer than 256 characters", async () => {
		const response = await rename("x".repeat(257));
		expect(response.status).toBe(400);
	});

	it("returns 404 for missing or non-operator threads", async () => {
		const response = await app.request("http://localhost/missing", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "New title" }),
		});
		expect(response.status).toBe(404);
	});
});
