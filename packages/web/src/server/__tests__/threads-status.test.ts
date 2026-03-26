import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import type { StatusForwardPayload } from "@bound/shared";
import { Hono } from "hono";
import { createThreadsRoutes } from "../routes/threads";

describe("/api/threads/{id}/status with status_forward cache (AC6.3)", () => {
	let db: Database;
	let app: Hono;
	let statusForwardCache: Map<string, StatusForwardPayload>;
	const threadId = "test-thread-1";
	const defaultModel = "claude-3-5-sonnet";

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		statusForwardCache = new Map<string, StatusForwardPayload>();

		// Create app with statusForwardCache
		app = createThreadsRoutes(db, defaultModel, statusForwardCache);

		// Insert a test thread
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
		).run(threadId, "default_web_user", "web", "localhost:3000", 0, "", now, now, now);
	});

	describe("AC6.3: Status forwarding with delegated loops", () => {
		it("returns idle status when no forwarded status and no running tasks", async () => {
			const res = await app.fetch(new Request(`http://localhost/${threadId}/status`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				active: boolean;
				state: string | null;
				detail: string | null;
				tokens: number;
				model: string | null;
			};

			expect(body.active).toBe(false);
			expect(body.state).toBe(null);
			expect(body.detail).toBe(null);
			expect(body.tokens).toBe(0);
			expect(body.model).toBe(defaultModel);
		});

		it("returns thinking status when forwarded status is thinking", async () => {
			const forwardedPayload: StatusForwardPayload = {
				thread_id: threadId,
				status: "thinking",
				detail: null,
				tokens: 150,
			};
			statusForwardCache.set(threadId, forwardedPayload);

			const res = await app.fetch(new Request(`http://localhost/${threadId}/status`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				active: boolean;
				state: string | null;
				detail: string | null;
				tokens: number;
				model: string | null;
			};

			expect(body.active).toBe(true);
			expect(body.state).toBe("thinking");
			expect(body.detail).toBeNull();
			expect(body.tokens).toBe(150);
		});

		it("returns tool_call status when forwarded status is tool_call", async () => {
			const forwardedPayload: StatusForwardPayload = {
				thread_id: threadId,
				status: "tool_call",
				detail: "bash",
				tokens: 300,
			};
			statusForwardCache.set(threadId, forwardedPayload);

			const res = await app.fetch(new Request(`http://localhost/${threadId}/status`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				active: boolean;
				state: string | null;
				detail: string | null;
				tokens: number;
				model: string | null;
			};

			expect(body.active).toBe(true);
			expect(body.state).toBe("tool_call");
			expect(body.detail).toBe("bash");
			expect(body.tokens).toBe(300);
		});

		it("returns idle status when forwarded status is idle", async () => {
			const forwardedPayload: StatusForwardPayload = {
				thread_id: threadId,
				status: "idle",
				detail: null,
				tokens: 0,
			};
			statusForwardCache.set(threadId, forwardedPayload);

			const res = await app.fetch(new Request(`http://localhost/${threadId}/status`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				active: boolean;
				state: string | null;
				detail: string | null;
				tokens: number;
				model: string | null;
			};

			expect(body.active).toBe(false);
			expect(body.state).toBe("idle");
			expect(body.detail).toBeNull();
			expect(body.tokens).toBe(0);
		});

		it("returns 404 for non-existent thread", async () => {
			const res = await app.fetch(
				new Request("http://localhost/non-existent-thread/status")
			);

			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("Thread not found");
		});

		it("clears forwarded status when no longer in cache", async () => {
			// First add forwarded status
			const forwardedPayload: StatusForwardPayload = {
				thread_id: threadId,
				status: "thinking",
				detail: null,
				tokens: 100,
			};
			statusForwardCache.set(threadId, forwardedPayload);

			let res = await app.fetch(new Request(`http://localhost/${threadId}/status`));
			let body = (await res.json()) as { active: boolean; state: string | null };
			expect(body.active).toBe(true);
			expect(body.state).toBe("thinking");

			// Remove forwarded status
			statusForwardCache.delete(threadId);

			res = await app.fetch(new Request(`http://localhost/${threadId}/status`));
			body = (await res.json()) as { active: boolean; state: string | null };
			expect(body.active).toBe(false);
			expect(body.state).toBeNull();
		});
	});
});
