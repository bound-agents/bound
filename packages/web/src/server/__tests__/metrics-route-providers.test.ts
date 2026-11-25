import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { type MetricsResponse, createMetricsRoutes } from "../routes/metrics";

let db: Database;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);
	applyMetricsSchema(db);
});

function seed(
	id: string,
	routeId: string | null,
	opts: { at?: string; tin?: number; tout?: number; cost?: number; status?: string } = {},
): void {
	db.prepare(
		`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
		tokens_cache_read, tokens_cache_write, cost_usd, status, route_id)
		VALUES (?, 't', ?, 'm', ?, ?, 10, 5, ?, ?, ?)`,
	).run(
		id,
		opts.at ?? "2026-05-18T12:00:00Z",
		opts.tin ?? 100,
		opts.tout ?? 50,
		opts.cost ?? 0.01,
		opts.status ?? "ok",
		routeId,
	);
}

async function fetchMetrics(): Promise<MetricsResponse> {
	const app = createMetricsRoutes(db);
	const res = await app.fetch(
		new Request("http://localhost/?from=2026-05-18T00:00:00Z&to=2026-05-19T00:00:00Z"),
	);
	expect(res.status).toBe(200);
	return (await res.json()) as MetricsResponse;
}

describe("metrics routes: byProvider", () => {
	it("groups turns by the provider segment of route_id across sites and backends", async () => {
		seed("a", "site1:bedrock-main:anthropic.claude-opus-5-5", { cost: 0.5 });
		seed("b", "site2:bedrock-main:amazon.nova-lite-v1:0", { cost: 0.25, status: "error" });
		seed("c", "site1:copilot:gpt-6-sol", { tin: 1000, cost: 0.1 });

		const { tokens } = await fetchMetrics();
		const bedrock = tokens.byProvider.find((p) => p.provider === "bedrock-main");
		const copilot = tokens.byProvider.find((p) => p.provider === "copilot");

		expect(tokens.byProvider).toHaveLength(2);
		expect(bedrock).toEqual({
			provider: "bedrock-main",
			tokens_in: 200,
			tokens_out: 100,
			cache_read: 20,
			cache_write: 10,
			cost_usd: 0.75,
			turn_count: 2,
			error_count: 1,
		});
		expect(copilot?.turn_count).toBe(1);
		expect(copilot?.tokens_in).toBe(1000);
	});

	it("puts NULL and malformed route_id turns in the unattributed (null) bucket, listed last", async () => {
		seed("a", null, { tin: 5000, cost: 9 });
		seed("b", "not-a-route-id", { tin: 5000 });
		seed("c", "site1:copilot:gpt-6-sol");

		const { tokens } = await fetchMetrics();

		expect(tokens.byProvider.map((p) => p.provider)).toEqual(["copilot", null]);
		const unattributed = tokens.byProvider[1];
		expect(unattributed?.turn_count).toBe(2);
		expect(unattributed?.tokens_in).toBe(10000);
	});

	it("sorts attributed providers by turn count descending, excluding soft-deleted and out-of-range turns", async () => {
		seed("a", "s:copilot:x");
		seed("b", "s:bedrock-main:y");
		seed("c", "s:bedrock-main:z");
		seed("d", "s:openai:z", { at: "2026-05-20T00:00:00Z" });
		seed("e", "s:anthropic:z");
		db.prepare("UPDATE turns SET deleted = 1 WHERE id = 'e'").run();

		const { tokens } = await fetchMetrics();

		expect(tokens.byProvider.map((p) => [p.provider, p.turn_count])).toEqual([
			["bedrock-main", 2],
			["copilot", 1],
		]);
	});

	it("returns an empty byProvider for an empty range", async () => {
		const { tokens } = await fetchMetrics();
		expect(tokens.byProvider).toEqual([]);
	});
});
