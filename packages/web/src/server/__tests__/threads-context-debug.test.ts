import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, createDatabase, recordTurn } from "@bound/core";
import type { ContextDebugInfo } from "@bound/shared";
import type { Hono } from "hono";
import { createThreadsRoutes } from "../routes/threads";

describe("GET /api/threads/:id/context-debug", () => {
	let db: Database;
	let app: Hono;
	const threadId = "test-thread-1";

	beforeEach(async () => {
		db = createDatabase(":memory:");
		applySchema(db);
		applyMetricsSchema(db);

		// Create app
		app = createThreadsRoutes(db);

		// Insert a test thread
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO threads (id, user_id, interface, host_origin, color, title, created_at, last_message_at, modified_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run(threadId, "default_web_user", "web", "localhost:3000", 0, "", now, now, now);
	});

	describe("AC4.1, AC4.2: Returns array of turn records ordered by created_at", () => {
		it("returns array of 3 turns with context_debug ordered by created_at ASC", async () => {
			const now = new Date().toISOString();
			const baseTime = new Date(now).getTime();

			// Insert 3 turns with debug data
			const debug1: ContextDebugInfo = {
				contextWindow: 200000,
				totalEstimated: 10000,
				model: "claude-3-5-sonnet",
				sections: [{ name: "system", tokens: 500 }],
				budgetPressure: false,
				truncated: 0,
			};

			const debug2: ContextDebugInfo = {
				contextWindow: 200000,
				totalEstimated: 15000,
				model: "claude-3-5-sonnet",
				sections: [{ name: "history", tokens: 14000 }],
				budgetPressure: true,
				truncated: 100,
			};

			const debug3: ContextDebugInfo = {
				contextWindow: 200000,
				totalEstimated: 12000,
				model: "claude-opus",
				sections: [{ name: "tasks", tokens: 11000 }],
				budgetPressure: false,
				truncated: 0,
			};

			// Insert turns with incremented timestamps
			const turn1Id = recordTurn(db, {
				thread_id: threadId,
				model_id: "model1",
				tokens_in: 100,
				tokens_out: 50,
				created_at: new Date(baseTime).toISOString(),
			});

			const turn2Id = recordTurn(db, {
				thread_id: threadId,
				model_id: "model2",
				tokens_in: 150,
				tokens_out: 75,
				created_at: new Date(baseTime + 1000).toISOString(),
			});

			const turn3Id = recordTurn(db, {
				thread_id: threadId,
				model_id: "model3",
				tokens_in: 200,
				tokens_out: 100,
				created_at: new Date(baseTime + 2000).toISOString(),
			});

			// Record context debug data
			const { recordContextDebug } = await import("@bound/core");
			recordContextDebug(db, turn1Id, debug1);
			recordContextDebug(db, turn2Id, debug2);
			recordContextDebug(db, turn3Id, debug3);

			// Fetch via API
			const res = await app.fetch(new Request(`http://localhost/${threadId}/context-debug`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{
				turn_id: number;
				model_id: string;
				tokens_in: number;
				tokens_out: number;
				context_debug: ContextDebugInfo;
				created_at: string;
			}>;

			expect(body.length).toBe(3);
			expect(body[0].turn_id).toBe(turn1Id);
			expect(body[1].turn_id).toBe(turn2Id);
			expect(body[2].turn_id).toBe(turn3Id);

			// Verify AC4.2: each record has required fields
			for (const record of body) {
				expect(record).toHaveProperty("turn_id");
				expect(record).toHaveProperty("model_id");
				expect(record).toHaveProperty("tokens_in");
				expect(record).toHaveProperty("tokens_out");
				expect(record).toHaveProperty("context_debug");
				expect(record).toHaveProperty("created_at");
			}

			// Verify AC4.2: context_debug is parsed object
			expect(body[0].context_debug).toEqual(debug1);
			expect(body[1].context_debug).toEqual(debug2);
			expect(body[2].context_debug).toEqual(debug3);
		});
	});

	describe("AC4.4: Returns empty array for nonexistent thread", () => {
		it("returns empty array (status 200) for nonexistent thread_id", async () => {
			const res = await app.fetch(
				new Request("http://localhost/nonexistent-thread-999/context-debug"),
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<unknown>;

			expect(body).toEqual([]);
		});
	});

	describe("AC4.5: Filters out turns with NULL context_debug", () => {
		it("excludes turns without context_debug from response", async () => {
			const now = new Date().toISOString();

			// Insert 2 turns: one with debug, one without
			const turn1Id = recordTurn(db, {
				thread_id: threadId,
				model_id: "model1",
				tokens_in: 100,
				tokens_out: 50,
				created_at: now,
			});

			// Turn without debug data
			recordTurn(db, {
				thread_id: threadId,
				model_id: "model2",
				tokens_in: 150,
				tokens_out: 75,
				created_at: new Date(new Date(now).getTime() + 1000).toISOString(),
			});

			// Only set debug for turn1
			const { recordContextDebug } = await import("@bound/core");
			const debugInfo: ContextDebugInfo = {
				contextWindow: 200000,
				totalEstimated: 10000,
				model: "claude-3-5-sonnet",
				sections: [{ name: "system", tokens: 500 }],
				budgetPressure: false,
				truncated: 0,
			};
			recordContextDebug(db, turn1Id, debugInfo);
			// Second turn has NULL context_debug

			// Fetch via API
			const res = await app.fetch(new Request(`http://localhost/${threadId}/context-debug`));

			expect(res.status).toBe(200);
			const body = (await res.json()) as Array<{
				turn_id: number;
			}>;

			expect(body.length).toBe(1);
			expect(body[0].turn_id).toBe(turn1Id);
		});
	});
});
