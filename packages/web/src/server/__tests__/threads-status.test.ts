import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { applySchema, createDatabase } from "@bound/core";
import type { StatusForwardPayload } from "@bound/shared";
import { TypedEventEmitter } from "@bound/shared";
import type { Hono } from "hono";
import { createStatusRoutes } from "../routes/status";
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
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
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
			const res = await app.fetch(new Request("http://localhost/non-existent-thread/status"));

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

describe("/api/status/cancel with delegation (AC6.4)", () => {
	let db: Database;
	let eventBus: TypedEventEmitter;
	let app: Hono;
	let activeDelegations: Map<string, { targetSiteId: string; processOutboxId: string }>;
	const _threadId = "test-thread-delegation";
	const delegatedThreadId = "delegated-thread-123";

	beforeEach(() => {
		db = createDatabase(":memory:");
		applySchema(db);
		eventBus = new TypedEventEmitter();
		activeDelegations = new Map();

		// Create status routes app with activeDelegations
		app = createStatusRoutes(db, eventBus, "test-host", "test-site", undefined, activeDelegations);

		// Insert a test thread
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run(delegatedThreadId, "default_web_user", "web", "localhost:3000", 0, "", now, now, now);

		// Insert host_meta for host_name
		db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("host_name", "test-host");

		// Insert site_id
		db.prepare("INSERT INTO cluster_config (key, value, modified_at) VALUES (?, ?, ?)").run(
			"site_id",
			"test-site",
			new Date().toISOString(),
		);
	});

	it("cancel on originating host sends cancel with ref_id matching process outbox entry (AC6.4)", async () => {
		// Set up a delegation for this thread
		const targetSiteId = "remote-site-123";
		const processOutboxId = randomUUID();

		activeDelegations.set(delegatedThreadId, {
			targetSiteId,
			processOutboxId,
		});

		// Call cancel endpoint
		const res = await app.fetch(
			new Request(`http://localhost/cancel/${delegatedThreadId}`, {
				method: "POST",
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as { cancelled: boolean; thread_id: string };
		expect(body.cancelled).toBe(true);
		expect(body.thread_id).toBe(delegatedThreadId);

		// Verify cancel entry was written to relay_outbox with correct ref_id
		const cancelEntry = db
			.query(
				"SELECT kind, ref_id, target_site_id FROM relay_outbox WHERE kind = 'cancel' ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { kind: string; ref_id: string | null; target_site_id: string } | null;

		expect(cancelEntry).toBeDefined();
		expect(cancelEntry?.kind).toBe("cancel");
		expect(cancelEntry?.ref_id).toBe(processOutboxId);
		expect(cancelEntry?.target_site_id).toBe(targetSiteId);
	});

	it("cancel on thread with no delegation does not write relay cancel entry", async () => {
		// Don't set up a delegation for this thread

		// Call cancel endpoint
		const res = await app.fetch(
			new Request(`http://localhost/cancel/${delegatedThreadId}`, {
				method: "POST",
			}),
		);

		expect(res.status).toBe(200);

		// Verify NO cancel entry was written to relay_outbox
		const cancelEntries = db
			.query("SELECT COUNT(*) as cnt FROM relay_outbox WHERE kind = 'cancel'")
			.get() as { cnt: number };

		expect(cancelEntries.cnt).toBe(0);
	});
});
