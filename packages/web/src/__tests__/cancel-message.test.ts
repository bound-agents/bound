import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase } from "@bound/core";
import { TypedEventEmitter } from "@bound/shared";
import { createApp } from "../server/index";

describe("R-E14: Cancel persists system cancellation message with host name", () => {
	let dbPath: string;
	let db: Database;
	let threadId: string;
	let userId: string;
	let eventBus: TypedEventEmitter;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
		db = createDatabase(dbPath);
		applySchema(db);

		// Set up site_id and host_name in host_meta
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["site_id", "test-site-123"]);
		db.run("INSERT INTO host_meta (key, value) VALUES (?, ?)", ["host_name", "test-host"]);

		// Create a test user
		userId = randomUUID();
		db.run(
			"INSERT INTO users (id, display_name, discord_id, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?)",
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

	it("persists a system message with host name when cancelling", async () => {
		const app = await createApp(db, eventBus);

		// POST to cancel endpoint
		const res = await app.request(`/api/status/cancel/${threadId}`, {
			method: "POST",
			headers: {
				Host: "localhost",
			},
		});

		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.cancelled).toBe(true);
		expect(body.thread_id).toBe(threadId);

		// Query messages table for the cancellation message
		const messages = db
			.query("SELECT * FROM messages WHERE thread_id = ? AND role = 'system'")
			.all(threadId) as Array<{
			id: string;
			thread_id: string;
			role: string;
			content: string;
			host_origin: string;
		}>;

		expect(messages.length).toBe(1);

		const cancelMsg = messages[0];
		expect(cancelMsg.role).toBe("system");
		expect(cancelMsg.content).toContain("cancelled");
		expect(cancelMsg.content).toContain("test-host");
		expect(cancelMsg.host_origin).toBe("test-host");
	});

	it("returns 404 when thread not found", async () => {
		const app = await createApp(db, eventBus);

		const fakeThreadId = randomUUID();
		const res = await app.request(`/api/status/cancel/${fakeThreadId}`, {
			method: "POST",
			headers: {
				Host: "localhost",
			},
		});

		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toBe("Thread not found");
	});

	it("emits agent:cancel event", async () => {
		const app = await createApp(db, eventBus);

		let emittedEvent: { thread_id: string } | null = null;
		eventBus.once("agent:cancel", (payload) => {
			emittedEvent = payload;
		});

		await app.request(`/api/status/cancel/${threadId}`, {
			method: "POST",
			headers: {
				Host: "localhost",
			},
		});

		expect(emittedEvent).not.toBeNull();
		expect(emittedEvent?.thread_id).toBe(threadId);
	});
});
