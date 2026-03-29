import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { BOUND_NAMESPACE, TypedEventEmitter, deterministicUUID } from "@bound/shared";
import type { Hono } from "hono";
import { createApp } from "../index";

describe("POST /api/mcp/threads", () => {
	let db: Database;
	let app: Hono;

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		const eventBus = new TypedEventEmitter();
		app = await createApp(db, eventBus);
	});

	it("mcp-server.AC6.1: returns 201 with thread_id", async () => {
		const res = await app.fetch(
			new Request("http://localhost/api/mcp/threads", { method: "POST" }),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { thread_id: string };
		expect(typeof body.thread_id).toBe("string");
		expect(body.thread_id.length).toBeGreaterThan(0);
	});

	it("mcp-server.AC6.2: thread has correct user_id and interface", async () => {
		const res = await app.fetch(
			new Request("http://localhost/api/mcp/threads", { method: "POST" }),
		);
		const body = (await res.json()) as { thread_id: string };
		const thread = db
			.query("SELECT user_id, interface FROM threads WHERE id = ?")
			.get(body.thread_id) as { user_id: string; interface: string } | null;
		expect(thread).not.toBeNull();
		if (thread) {
			expect(thread.user_id).toBe(deterministicUUID(BOUND_NAMESPACE, "mcp"));
			expect(thread.interface).toBe("mcp");
		}
	});

	it("mcp-server.AC6.5: rejects non-localhost Host header with 400", async () => {
		const res = await app.fetch(
			new Request("http://evil.example.com/api/mcp/threads", {
				method: "POST",
				headers: { host: "evil.example.com" },
			}),
		);
		expect(res.status).toBe(400);
	});
});
