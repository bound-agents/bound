import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow } from "@bound/core";
import { createMessagesRoutes } from "../routes/messages";

// Exercises GET /:threadId/provenance on the messages route (2026-11-21-model-
// routing.md §9.1). Each turn names the served model and route; a multi-attempt
// turn carries its per-attempt breakdown parsed out of cost_breakdown.attempts.

let db: Database;

function seedThread(id: string): void {
	const now = "2026-01-01T00:00:00.000Z";
	insertRow(
		db,
		"threads",
		{
			id,
			user_id: "u1",
			interface: "web",
			host_origin: "local",
			color: null,
			title: null,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: now,
			last_message_at: now,
			modified_at: now,
			deleted: 0,
			model_hint: null,
			agent_id: null,
			parent_thread_id: null,
		},
		"site-test",
	);
}

function seedTurn(over: { id: string; thread_id: string } & Record<string, unknown>): void {
	insertRow(
		db,
		"turns",
		{
			task_id: null,
			dag_root_id: null,
			model_id: "opus-4.8",
			tokens_in: 0,
			tokens_out: 0,
			tokens_cache_write: null,
			tokens_cache_read: null,
			cost_usd: null,
			created_at: "2026-01-01T00:00:00.000Z",
			status: null,
			relay_target: null,
			relay_latency_ms: null,
			context_debug: null,
			cost_breakdown: null,
			route_id: null,
			substituted_from: null,
			host_origin: null,
			modified_at: null,
			deleted: 0,
			...over,
		} as never,
		"site-test",
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

describe("GET /:threadId/provenance", () => {
	it("returns per-turn provenance oldest-first with parsed attempts", async () => {
		seedThread("th1");
		seedTurn({
			id: "t1",
			thread_id: "th1",
			created_at: "2026-01-01T00:00:00.000Z",
			model_id: "opus-4.8",
			route_id: "site-a:anthropic:opus",
		});
		seedTurn({
			id: "t2",
			thread_id: "th1",
			created_at: "2026-01-02T00:00:00.000Z",
			model_id: "gpt-5.6-sol",
			route_id: "site-b:codex:sol",
			substituted_from: "opus-4.8",
			cost_breakdown: JSON.stringify({
				input: 0.4,
				output: 0.1,
				cacheRead: 0,
				cacheWrite: 0,
				attempts: [
					{
						model_id: "opus-4.8",
						route_id: "site-a:anthropic:opus",
						outcome: "refusal",
						refusal_category: "safety",
						credit_redeemed: false,
						tokens: { input: 10, output: 0, cache_read: 0, cache_write: 0 },
						cost_usd: 0.01,
					},
					{
						model_id: "gpt-5.6-sol",
						route_id: "site-b:codex:sol",
						outcome: "ok",
						refusal_category: null,
						credit_redeemed: false,
						tokens: { input: 100, output: 20, cache_read: 0, cache_write: 0 },
						cost_usd: 0.4,
					},
				],
			}),
		});

		const app = createMessagesRoutes(db);
		const res = await app.fetch(new Request("http://localhost/th1/provenance"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			turns: Array<{
				id: string;
				model_id: string;
				route_id: string | null;
				substituted_from: string | null;
				attempts: Array<{ model_id: string; outcome: string }> | null;
			}>;
		};
		expect(body.turns.map((t) => t.id)).toEqual(["t1", "t2"]);
		// A single clean turn carries no attempts array.
		expect(body.turns[0].attempts).toBeNull();
		// The substituted turn exposes both attempts, the refusal first.
		expect(body.turns[1].substituted_from).toBe("opus-4.8");
		expect(body.turns[1].attempts).toHaveLength(2);
		expect(body.turns[1].attempts?.[0].outcome).toBe("refusal");
	});

	it("returns 404 for an unknown thread", async () => {
		const app = createMessagesRoutes(db);
		const res = await app.fetch(new Request("http://localhost/missing/provenance"));
		expect(res.status).toBe(404);
	});

	it("tolerates malformed cost_breakdown by omitting attempts", async () => {
		seedThread("th2");
		seedTurn({
			id: "t3",
			thread_id: "th2",
			cost_breakdown: "{not valid json",
		});
		const app = createMessagesRoutes(db);
		const res = await app.fetch(new Request("http://localhost/th2/provenance"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { turns: Array<{ attempts: unknown }> };
		expect(body.turns[0].attempts).toBeNull();
	});
});
