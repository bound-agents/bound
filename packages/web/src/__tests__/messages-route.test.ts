import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createMessagesRoutes } from "../server/routes/messages";

describe("AC1.2: POST /api/threads/:id/messages returns 404 with migration notice", () => {
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up site_id in host_meta
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", "test-site-123"]);

		// Create a test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, platform_ids, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
			[userId, "Test User", null, new Date().toISOString(), new Date().toISOString(), 0],
		);

		// Create a test thread
		threadId = randomUUID();
		db.run(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, summary, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[
				threadId,
				userId,
				"web",
				"test-host",
				0,
				"Test Thread",
				null,
				new Date().toISOString(),
				new Date().toISOString(),
				new Date().toISOString(),
				0,
			],
		);

		eventBus = new TypedEventEmitter();
	});

	afterEach(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("POST to /api/threads/:id/messages returns 404 with migration notice", async () => {
		const app = createMessagesRoutes(db, eventBus);

		const res = await app.request(`/${threadId}/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				content: "Test message",
			}),
		});

		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toContain("POST endpoint removed");
		expect(body.error).toContain("WebSocket");
		expect(body.error).toContain("message:send");
	});

	it("GET /api/threads/:id/messages returns 200", async () => {
		const app = createMessagesRoutes(db, eventBus);

		// Insert a message
		const messageId = randomUUID();
		db.run(
			"INSERT INTO messages (id, thread_id, role, content, created_at, modified_at, deleted, host_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			[
				messageId,
				threadId,
				"user",
				"Test message",
				new Date().toISOString(),
				new Date().toISOString(),
				0,
				"test-host",
			],
		);

		const res = await app.request(`/${threadId}/messages`, {
			method: "GET",
		});

		expect(res.status).toBe(200);

		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(1);
		expect(body[0].id).toBe(messageId);
		expect(body[0].content).toBe("Test message");
	});

	it("GET /api/threads/:id/messages returns 404 for non-existent thread", async () => {
		const app = createMessagesRoutes(db, eventBus);

		const fakeThreadId = randomUUID();
		const res = await app.request(`/${fakeThreadId}/messages`, {
			method: "GET",
		});

		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("Thread not found");
	});
});
