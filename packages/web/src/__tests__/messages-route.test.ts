import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createMessagesRoutes } from "../server/routes/messages";

describe("POST /api/threads/:threadId/messages — model_id handling", () => {
	let dbPath: string;
	let db: Database;
	const siteId = "test-site";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Seed host_meta with site_id for getSiteId()
		db.run("INSERT OR REPLACE INTO host_meta (key, value) VALUES ('site_id', ?)", [siteId]);

		// Seed a user
		insertRow(
			db,
			"users",
			{
				id: "u1",
				display_name: "Test",
				platform_ids: null,
				first_seen_at: new Date().toISOString(),
				modified_at: new Date().toISOString(),
				deleted: 0,
			},
			siteId,
		);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	function makeThread(modelHint: string | null = null): string {
		const id = randomUUID();
		const now = new Date().toISOString();
		insertRow(
			db,
			"threads",
			{
				id,
				user_id: "u1",
				interface: "web",
				host_origin: "test",
				color: 0,
				title: null,
				summary: null,
				summary_through: null,
				summary_model_id: null,
				extracted_through: null,
				created_at: now,
				last_message_at: now,
				modified_at: now,
				deleted: 0,
				model_hint: modelHint,
			},
			siteId,
		);
		return id;
	}

	it("updates threads.model_hint when model_id is provided in POST body", async () => {
		const threadId = makeThread(null);
		const eventBus = new TypedEventEmitter();
		const app = createMessagesRoutes(db, eventBus);

		const res = await app.request(`/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hello", model_id: "opus" }),
		});

		expect(res.status).toBe(201);

		// threads.model_hint should be updated
		const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
			model_hint: string | null;
		};
		expect(thread.model_hint).toBe("opus");
	});

	it("does not store model_id on the user message row", async () => {
		const threadId = makeThread(null);
		const eventBus = new TypedEventEmitter();
		const app = createMessagesRoutes(db, eventBus);

		const res = await app.request(`/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hello", model_id: "opus" }),
		});

		expect(res.status).toBe(201);

		// User message should NOT have model_id set
		const msg = db
			.query("SELECT model_id FROM messages WHERE thread_id = ? AND role = 'user' LIMIT 1")
			.get(threadId) as { model_id: string | null };
		expect(msg.model_id).toBeNull();
	});

	it("does not touch threads.model_hint when model_id is omitted", async () => {
		const threadId = makeThread("opus");
		const eventBus = new TypedEventEmitter();
		const app = createMessagesRoutes(db, eventBus);

		const res = await app.request(`/${threadId}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "hello" }),
		});

		expect(res.status).toBe(201);

		// threads.model_hint should remain unchanged
		const thread = db.query("SELECT model_hint FROM threads WHERE id = ?").get(threadId) as {
			model_hint: string | null;
		};
		expect(thread.model_hint).toBe("opus");
	});
});
