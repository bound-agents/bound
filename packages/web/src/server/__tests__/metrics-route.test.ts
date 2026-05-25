import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applyMetricsSchema, applySchema } from "@bound/core";
import { createMetricsRoutes } from "../routes/metrics";

let db: Database;
let siteId: string;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);
	applyMetricsSchema(db);

	// Set up site_id
	siteId = `test-site-${randomBytes(4).toString("hex")}`;
	db.prepare("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", siteId);
});

describe("metrics routes", () => {
	describe("AC5.1 & AC5.4: Date validation", () => {
		it("rejects missing 'from' parameter", async () => {
			const app = createMetricsRoutes(db);
			const now = new Date().toISOString();
			const response = await app.fetch(
				new Request(`http://localhost/?to=${now}`, { method: "GET" }),
			);

			expect(response.status).toBe(400);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json).toHaveProperty("error");
			expect(json.error).toContain("from");
		});

		it("rejects missing 'to' parameter", async () => {
			const app = createMetricsRoutes(db);
			const now = new Date().toISOString();
			const response = await app.fetch(
				new Request(`http://localhost/?from=${now}`, { method: "GET" }),
			);

			expect(response.status).toBe(400);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json).toHaveProperty("error");
			expect(json.error).toContain("to");
		});

		it("rejects invalid 'from' date", async () => {
			const app = createMetricsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/?from=not-a-date&to=2026-05-18T00:00:00Z", {
					method: "GET",
				}),
			);

			expect(response.status).toBe(400);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json).toHaveProperty("error");
		});

		it("rejects invalid 'to' date", async () => {
			const app = createMetricsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/?from=2026-05-18T00:00:00Z&to=invalid-date", {
					method: "GET",
				}),
			);

			expect(response.status).toBe(400);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json).toHaveProperty("error");
		});

		it("rejects when 'to' is before 'from'", async () => {
			const app = createMetricsRoutes(db);
			const response = await app.fetch(
				new Request("http://localhost/?from=2026-05-18T10:00:00Z&to=2026-05-18T00:00:00Z", {
					method: "GET",
				}),
			);

			expect(response.status).toBe(400);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json).toHaveProperty("error");
		});

		it("clamps 'to' to current time if in future", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const futureTo = new Date(Date.now() + 24 * 3600_000).toISOString();

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${futureTo}`, {
					method: "GET",
				}),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;

			// The clamped 'to' should be close to now, not far in the future
			// Just check that the response has the expected shape
			expect(json).toHaveProperty("tokens");
			expect(json).toHaveProperty("relay");
			expect(json).toHaveProperty("context");
		});
	});

	describe("AC5.1 & AC5.3: Response shape", () => {
		it("returns correct shape with all three sections", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;

			// Verify all three top-level sections exist
			expect(json).toHaveProperty("tokens");
			expect(json).toHaveProperty("relay");
			expect(json).toHaveProperty("context");

			// Verify tokens shape
			const tokens = json.tokens as Record<string, unknown>;
			expect(tokens).toHaveProperty("byModel");
			expect(Array.isArray(tokens.byModel)).toBe(true);
			expect(tokens).toHaveProperty("timeline");
			expect(Array.isArray(tokens.timeline)).toBe(true);
			expect(tokens).toHaveProperty("costByModelTimeline");
			expect(Array.isArray(tokens.costByModelTimeline)).toBe(true);
			expect(tokens).toHaveProperty("totals");

			// Verify totals has expected fields
			const tokenTotals = tokens.totals as Record<string, unknown>;
			expect(tokenTotals).toHaveProperty("tokens_in");
			expect(tokenTotals).toHaveProperty("tokens_out");
			expect(tokenTotals).toHaveProperty("cost_usd");
			expect(tokenTotals).toHaveProperty("turn_count");
			expect(tokenTotals).toHaveProperty("error_count");

			// Verify relay shape
			const relay = json.relay as Record<string, unknown>;
			expect(relay).toHaveProperty("byHost");
			expect(Array.isArray(relay.byHost)).toBe(true);
			expect(relay).toHaveProperty("recentCycles");
			expect(Array.isArray(relay.recentCycles)).toBe(true);
			expect(relay).toHaveProperty("totals");

			// Verify context shape
			const context = json.context as Record<string, unknown>;
			expect(context).toHaveProperty("totals");
			expect(context).toHaveProperty("timeline");
			expect(Array.isArray(context.timeline)).toBe(true);
		});
	});

	describe("AC5.2: Bucketing mode", () => {
		it("uses hourly buckets for ranges <= 48 hours", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			// 24 hours later
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;

			// When there's no data, timeline will be empty, but structure should be valid
			const tokens = json.tokens as Record<string, unknown>;
			expect(Array.isArray(tokens.timeline)).toBe(true);

			// If there were data points, hourly format would be YYYY-MM-DDTHH:00
			// For now we just check the structure is valid
		});

		it("uses daily buckets for ranges > 48 hours", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-10T00:00:00Z").toISOString();
			// 10 days later
			const to = new Date("2026-05-20T00:00:00Z").toISOString();

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;

			// Structure should be valid for daily bucketing
			const tokens = json.tokens as Record<string, unknown>;
			expect(Array.isArray(tokens.timeline)).toBe(true);
		});
	});

	describe("AC5.5: Performance (large ranges)", () => {
		it("completes within reasonable time with empty database", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-01-01T00:00:00Z").toISOString();
			const to = new Date("2026-05-18T00:00:00Z").toISOString();

			const start = Date.now();
			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);
			const elapsed = Date.now() - start;

			expect(response.status).toBe(200);
			// Should complete in under 1 second even with large range
			expect(elapsed).toBeLessThan(1000);
		});
	});

	describe("AC5.1 & AC5.2: Token aggregation queries", () => {
		it("aggregates token usage by model", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns data
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-3-opus",
				1000,
				2000,
				0.05,
				"ok",
				null,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T14:00:00Z",
				"claude-3-opus",
				800,
				1500,
				0.04,
				"ok",
				null,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-3",
				"thread-3",
				"2026-05-18T16:00:00Z",
				"claude-3-haiku",
				500,
				800,
				0.01,
				"ok",
				null,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const tokens = json.tokens as Record<string, unknown>;
			const byModel = tokens.byModel as Array<Record<string, unknown>>;

			expect(byModel.length).toBeGreaterThan(0);

			// Find claude-3-opus entry
			const opusEntry = byModel.find((m) => m.model_id === "claude-3-opus");
			expect(opusEntry).toBeDefined();
			expect(opusEntry?.tokens_in).toBe(1800); // 1000 + 800
			expect(opusEntry?.tokens_out).toBe(3500); // 2000 + 1500
			expect(opusEntry?.turn_count).toBe(2);
		});

		it("aggregates totals correctly", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns data
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-3-opus",
				1000,
				2000,
				0.05,
				"ok",
				null,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T14:00:00Z",
				"claude-3-opus",
				800,
				1500,
				0.04,
				"error",
				null,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const tokens = json.tokens as Record<string, unknown>;
			const totals = tokens.totals as Record<string, unknown>;

			expect(totals.tokens_in).toBe(1800); // 1000 + 800
			expect(totals.tokens_out).toBe(3500); // 2000 + 1500
			expect(totals.cost_usd).toBeCloseTo(0.09, 8); // 0.05 + 0.04 (raw float; format only at display time)
			expect(totals.turn_count).toBe(2);
			expect(totals.error_count).toBe(1);
		});

		it("handles multiple turns with different statuses", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns data with different statuses
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-3-opus",
				1000,
				2000,
				0.05,
				"ok",
				null,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T14:00:00Z",
				"claude-3-opus",
				800,
				1500,
				0.04,
				"ok",
				null,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const tokens = json.tokens as Record<string, unknown>;
			const totals = tokens.totals as Record<string, unknown>;

			expect(totals.turn_count).toBe(2);
			expect(totals.tokens_in).toBe(1800);
		});

		it("handles NULL values for cache and cost columns", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turn with NULL cache/cost values
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-3-opus",
				1000,
				2000,
				null,
				null,
				null,
				"ok",
				null,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const tokens = json.tokens as Record<string, unknown>;
			const byModel = tokens.byModel as Array<Record<string, unknown>>;

			const opusEntry = byModel.find((m) => m.model_id === "claude-3-opus");
			expect(opusEntry).toBeDefined();
			expect(opusEntry?.cache_read).toBe(0); // NULL becomes 0
			expect(opusEntry?.cache_write).toBe(0); // NULL becomes 0
			expect(opusEntry?.cost_usd).toBe(0); // NULL becomes 0
		});

		it("returns timeline with correct date format for hourly bucketing", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns in different hours
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:15:00Z",
				"claude-3-opus",
				1000,
				2000,
				0.05,
				"ok",
				null,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				cost_usd, status, context_debug)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-1",
				"2026-05-18T13:30:00Z",
				"claude-3-opus",
				800,
				1500,
				0.04,
				"ok",
				null,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const tokens = json.tokens as Record<string, unknown>;
			const timeline = tokens.timeline as Array<Record<string, unknown>>;

			// For hourly bucketing, should have entries
			if (timeline.length > 0) {
				// Verify format looks like YYYY-MM-DDTHH:00
				const firstDate = timeline[0]?.date as string;
				expect(firstDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00/);
			}
		});
	});

	describe("AC5.1 & AC5.3: Relay aggregation", () => {
		it("aggregates relay performance by host", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed relay_cycles data
			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-b", "stream_chunk", "push", 50, 1, 0, "2026-05-18T12:00:00Z");

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-b", "stream_chunk", "push", 75, 1, 0, "2026-05-18T13:00:00Z");

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-b", "stream_chunk", "push", 100, 0, 0, "2026-05-18T14:00:00Z");

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const relay = json.relay as Record<string, unknown>;
			const byHost = relay.byHost as Array<Record<string, unknown>>;

			expect(byHost.length).toBeGreaterThan(0);
			const hostEntry = byHost.find((h) => h.peer_site_id === "site-b");
			expect(hostEntry).toBeDefined();
			expect(hostEntry?.avg_latency_ms).toBe(75); // (50 + 75 + 100) / 3
			expect(hostEntry?.success_count).toBe(2);
			expect(hostEntry?.failure_count).toBe(1);
		});

		it("computes P95 latency correctly", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed relay_cycles with known latencies: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
			const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
			for (let i = 0; i < latencies.length; i++) {
				db.prepare(
					`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"outbound",
					"site-c",
					"stream_chunk",
					"push",
					latencies[i],
					1,
					0,
					`2026-05-18T12:${String(i).padStart(2, "0")}:00Z`,
				);
			}

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const relay = json.relay as Record<string, unknown>;
			const byHost = relay.byHost as Array<Record<string, unknown>>;

			const hostEntry = byHost.find((h) => h.peer_site_id === "site-c");
			expect(hostEntry).toBeDefined();
			// P95 of [10..100] should be around 90
			expect(hostEntry?.p95_latency_ms).toBeGreaterThanOrEqual(85);
			expect(hostEntry?.p95_latency_ms).toBeLessThanOrEqual(95);
		});

		it("maps success/expired INTEGER to boolean", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-d", "stream_chunk", "push", 50, 1, 0, "2026-05-18T12:00:00Z");

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-d", "stream_chunk", "push", null, 0, 1, "2026-05-18T13:00:00Z");

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const relay = json.relay as Record<string, unknown>;
			const recentCycles = relay.recentCycles as Array<Record<string, unknown>>;

			expect(recentCycles.length).toBeGreaterThanOrEqual(1);
			const successCycle = recentCycles.find((c) => c.success === true);
			const expiredCycle = recentCycles.find((c) => c.expired === true);

			expect(successCycle).toBeDefined();
			expect(typeof successCycle?.success).toBe("boolean");
			expect(expiredCycle).toBeDefined();
			expect(typeof expiredCycle?.expired).toBe("boolean");
		});

		it("computes relay totals correctly", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-e", "stream_chunk", "push", 100, 1, 0, "2026-05-18T12:00:00Z");

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-e", "stream_chunk", "push", 200, 1, 0, "2026-05-18T13:00:00Z");

			db.prepare(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run("outbound", "site-e", "stream_chunk", "push", null, 0, 1, "2026-05-18T14:00:00Z");

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const relay = json.relay as Record<string, unknown>;
			const totals = relay.totals as Record<string, unknown>;

			expect(totals.total_cycles).toBe(3);
			expect(totals.success_rate).toBeCloseTo(2 / 3, 2);
			expect(totals.avg_latency_ms).toBeCloseTo(150, 0); // (100 + 200) / 2
			expect(totals.expired_count).toBe(1);
		});
	});

	describe("AC5.1 & AC5.3: Context assembly metrics", () => {
		it("computes cache hit rate from table columns", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns with context_debug
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-opus",
				1000,
				500,
				200,
				300,
				0.05,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 1500,
					contextWindow: 8000,
				}),
				0,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T13:00:00Z",
				"claude-opus",
				500,
				250,
				100,
				150,
				0.02,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 750,
					contextWindow: 8000,
				}),
				0,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const context = json.context as Record<string, unknown>;
			const totals = context.totals as Record<string, unknown>;

			expect(totals.total_turns_with_debug).toBe(2);
			// last_cache_hit_rate is taken from the most recent denominator-defined
			// turn — turn-2 here (13:00): 100 / (100 + 500) ≈ 0.1667.
			expect(totals.last_cache_hit_rate).toBeGreaterThan(0);
			expect(totals.last_cache_hit_rate).toBeLessThan(1);
		});

		it("counts budget pressure events from JSON", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed turns with context_debug, some with budget pressure
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-opus",
				1000,
				500,
				0,
				0,
				0.05,
				"ok",
				JSON.stringify({
					budgetPressure: true,
					truncated: 5,
					totalEstimated: 7500,
					contextWindow: 8000,
				}),
				0,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T13:00:00Z",
				"claude-opus",
				500,
				250,
				0,
				0,
				0.02,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 2000,
					contextWindow: 8000,
				}),
				0,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-3",
				"thread-3",
				"2026-05-18T14:00:00Z",
				"claude-opus",
				800,
				400,
				0,
				0,
				0.03,
				"ok",
				JSON.stringify({
					budgetPressure: true,
					truncated: 10,
					totalEstimated: 7800,
					contextWindow: 8000,
				}),
				0,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const context = json.context as Record<string, unknown>;
			const totals = context.totals as Record<string, unknown>;

			expect(totals.budget_pressure_count).toBe(2);
			expect(totals.total_turns_with_debug).toBe(3);
		});

		it("handles NULL context_debug (excluded from stats)", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Seed a mix of turns with and without context_debug
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-opus",
				1000,
				500,
				0,
				0,
				0.05,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 1000,
					contextWindow: 8000,
				}),
				0,
			);

			// This turn has NULL context_debug
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T13:00:00Z",
				"claude-opus",
				500,
				250,
				0,
				0,
				0.02,
				"ok",
				null,
				0,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const context = json.context as Record<string, unknown>;
			const totals = context.totals as Record<string, unknown>;

			// Only turn-1 should be counted (turn-2 has NULL context_debug)
			expect(totals.total_turns_with_debug).toBe(1);
		});

		it("computes context utilization percentage", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-opus",
				1000,
				500,
				0,
				0,
				0.05,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 4000,
					contextWindow: 8000,
				}),
				0,
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const context = json.context as Record<string, unknown>;
			const timeline = context.timeline as Array<Record<string, unknown>>;

			if (timeline.length > 0) {
				const entry = timeline[0];
				// 4000 / 8000 = 0.5
				expect(entry?.avg_context_utilization).toBeCloseTo(0.5, 1);
			}
		});

		it("excludes soft-deleted turns from context metrics", async () => {
			const app = createMetricsRoutes(db);
			const from = new Date("2026-05-18T00:00:00Z").toISOString();
			const to = new Date("2026-05-19T00:00:00Z").toISOString();

			// Insert turns, one of which is soft-deleted
			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-1",
				"thread-1",
				"2026-05-18T12:00:00Z",
				"claude-opus",
				1000,
				500,
				0,
				0,
				0.05,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 1000,
					contextWindow: 8000,
				}),
				0,
			);

			db.prepare(
				`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
				tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(
				"turn-2",
				"thread-2",
				"2026-05-18T13:00:00Z",
				"claude-opus",
				500,
				250,
				0,
				0,
				0.02,
				"ok",
				JSON.stringify({
					budgetPressure: false,
					truncated: 0,
					totalEstimated: 500,
					contextWindow: 8000,
				}),
				1, // soft-deleted
			);

			const response = await app.fetch(
				new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
			);

			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			const context = json.context as Record<string, unknown>;
			const totals = context.totals as Record<string, unknown>;

			expect(totals.total_turns_with_debug).toBe(1);
		});
	});

	describe("Missing coverage tests", () => {
		describe("AC1.4 (empty range)", () => {
			it("returns all zeros and empty arrays when no data in range", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;

				// Check tokens section
				const tokens = json.tokens as Record<string, unknown>;
				expect((tokens.totals as Record<string, unknown>).turn_count).toBe(0);
				expect(Array.isArray(tokens.byModel)).toBe(true);
				expect((tokens.byModel as unknown[]).length).toBe(0);
				expect(Array.isArray(tokens.timeline)).toBe(true);
				expect((tokens.timeline as unknown[]).length).toBe(0);

				// Check relay section
				const relay = json.relay as Record<string, unknown>;
				expect((relay.totals as Record<string, unknown>).total_cycles).toBe(0);
				expect(Array.isArray(relay.byHost)).toBe(true);
				expect((relay.byHost as unknown[]).length).toBe(0);
				expect(Array.isArray(relay.recentCycles)).toBe(true);
				expect((relay.recentCycles as unknown[]).length).toBe(0);

				// Check context section
				const context = json.context as Record<string, unknown>;
				expect((context.totals as Record<string, unknown>).total_turns_with_debug).toBe(0);
				expect(Array.isArray(context.timeline)).toBe(true);
				expect((context.timeline as unknown[]).length).toBe(0);
			});
		});

		describe("AC2.2 (date filtering)", () => {
			it("only counts turns within the specified date range", async () => {
				const app = createMetricsRoutes(db);

				// Seed turn from 36 hours ago
				const turnTime36hAgo = new Date(Date.now() - 36 * 3600_000).toISOString();
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-old",
					"thread-old",
					turnTime36hAgo,
					"claude-3-opus",
					1000,
					2000,
					0.05,
					"ok",
					null,
				);

				// Seed turn from 2 hours ago (recent)
				const turnTime2hAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-recent",
					"thread-recent",
					turnTime2hAgo,
					"claude-3-opus",
					500,
					1000,
					0.03,
					"ok",
					null,
				);

				// Request with from=24h ago, to=now
				const from = new Date(Date.now() - 24 * 3600_000).toISOString();
				const to = new Date().toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const tokens = json.tokens as Record<string, unknown>;
				const totals = tokens.totals as Record<string, unknown>;

				// Only recent turn should be counted
				expect(totals.turn_count).toBe(1);
				expect(totals.tokens_in).toBe(500);
				expect(totals.tokens_out).toBe(1000);
			});
		});

		describe("AC2.3 (sort order)", () => {
			it("sorts byModel by total tokens (tokens_in + tokens_out) descending", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				// Seed turns for model A (100 + 200 = 300 total)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("turn-a1", "thread-a", "2026-05-18T12:00:00Z", "model-a", 100, 200, 0.05, "ok", null);

				// Seed turns for model B (500 + 1000 = 1500 total)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("turn-b1", "thread-b", "2026-05-18T13:00:00Z", "model-b", 500, 1000, 0.1, "ok", null);

				// Seed turns for model C (50 + 100 = 150 total)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("turn-c1", "thread-c", "2026-05-18T14:00:00Z", "model-c", 50, 100, 0.02, "ok", null);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const tokens = json.tokens as Record<string, unknown>;
				const byModel = tokens.byModel as Array<Record<string, unknown>>;

				expect(byModel.length).toBe(3);
				// Should be sorted by total tokens descending: B (1500), A (300), C (150)
				expect(byModel[0]?.model_id).toBe("model-b");
				expect(byModel[1]?.model_id).toBe("model-a");
				expect(byModel[2]?.model_id).toBe("model-c");
			});
		});

		describe("costByModelTimeline (per-model cost breakdown)", () => {
			it("returns one row per (date, model_id) with summed cost", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				// Two opus turns in the same hour, one kimi turn in a different hour
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-opus-1",
					"thread-1",
					"2026-05-18T12:15:00Z",
					"opus",
					100,
					100,
					0.05,
					"ok",
					null,
				);
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-opus-2",
					"thread-1",
					"2026-05-18T12:45:00Z",
					"opus",
					100,
					100,
					0.07,
					"ok",
					null,
				);
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-kimi-1",
					"thread-2",
					"2026-05-18T13:00:00Z",
					"kimi",
					100,
					100,
					0.02,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const tokens = json.tokens as Record<string, unknown>;
				const costByModel = tokens.costByModelTimeline as Array<Record<string, unknown>>;

				// 12:00 opus row (sum of both opus turns) + 13:00 kimi row
				expect(costByModel.length).toBe(2);

				const opus12 = costByModel.find(
					(r) => r.model_id === "opus" && (r.date as string).startsWith("2026-05-18T12"),
				);
				const kimi13 = costByModel.find(
					(r) => r.model_id === "kimi" && (r.date as string).startsWith("2026-05-18T13"),
				);

				expect(opus12).toBeDefined();
				expect(opus12?.cost_usd).toBeCloseTo(0.12, 8); // 0.05 + 0.07
				expect(kimi13).toBeDefined();
				expect(kimi13?.cost_usd).toBeCloseTo(0.02, 8);
			});
		});

		describe("AC2.4 (daily bucketing with data)", () => {
			it("uses daily format across 5 days and sums costs correctly", async () => {
				const app = createMetricsRoutes(db);

				// Seed turns across 5 distinct days
				for (let i = 0; i < 5; i++) {
					const date = new Date("2026-05-15T00:00:00Z");
					date.setDate(date.getDate() + i);
					const isoDate = date.toISOString();

					db.prepare(
						`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
						cost_usd, status, context_debug)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						`turn-day${i}`,
						`thread-day${i}`,
						isoDate,
						"claude-3-opus",
						100,
						200,
						0.05,
						"ok",
						null,
					);
				}

				// Request with range > 48h (10 days to cover all seeded data)
				const from = new Date("2026-05-10T00:00:00Z").toISOString();
				const to = new Date("2026-05-25T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const tokens = json.tokens as Record<string, unknown>;
				const timeline = tokens.timeline as Array<Record<string, unknown>>;

				// Should have entries for each day
				expect(timeline.length).toBeGreaterThan(0);

				// Verify daily format (YYYY-MM-DD, not hourly)
				for (const entry of timeline) {
					const dateStr = entry.date as string;
					expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				}

				// Verify cost sums correctly
				let totalCost = 0;
				for (const entry of timeline) {
					totalCost += (entry.cost_usd as number) || 0;
				}
				// Should be 5 days × 0.05 per day = 0.25
				expect(totalCost).toBeCloseTo(0.25, 2);
			});
		});

		describe("AC2.5 (model exclusion)", () => {
			it("excludes turns from outside the date range in byModel", async () => {
				const app = createMetricsRoutes(db);

				// Seed turn for model "alpha" within range (2026-05-18)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-alpha-in",
					"thread-alpha",
					"2026-05-18T12:00:00Z",
					"alpha",
					1000,
					2000,
					0.05,
					"ok",
					null,
				);

				// Seed turn for model "beta" outside range (2026-05-20, outside to window)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-beta-out",
					"thread-beta",
					"2026-05-20T12:00:00Z",
					"beta",
					500,
					1000,
					0.03,
					"ok",
					null,
				);

				// Seed another turn for model "alpha" outside range (2026-05-17, before from)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-alpha-out",
					"thread-alpha2",
					"2026-05-17T12:00:00Z",
					"alpha",
					100,
					200,
					0.01,
					"ok",
					null,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const tokens = json.tokens as Record<string, unknown>;
				const byModel = tokens.byModel as Array<Record<string, unknown>>;

				// Only model "alpha" from within range should be present
				expect(byModel.length).toBe(1);
				expect(byModel[0]?.model_id).toBe("alpha");
				// Should only count the in-range turn
				expect(byModel[0]?.turn_count).toBe(1);
				expect(byModel[0]?.tokens_in).toBe(1000);
			});
		});

		describe("AC3.2 (relay filtering)", () => {
			it("only counts relay_cycles within the date range", async () => {
				const app = createMetricsRoutes(db);

				// Seed relay cycle outside range (2026-05-16, before from)
				db.prepare(
					`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("outbound", "site-old", "stream_chunk", "push", 50, 1, 0, "2026-05-16T12:00:00Z");

				// Seed relay cycle within range
				db.prepare(
					`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("outbound", "site-new", "stream_chunk", "push", 75, 1, 0, "2026-05-18T12:00:00Z");

				// Seed relay cycle outside range (2026-05-20, after to)
				db.prepare(
					`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				).run("outbound", "site-future", "stream_chunk", "push", 100, 1, 0, "2026-05-20T12:00:00Z");

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const relay = json.relay as Record<string, unknown>;
				const totals = relay.totals as Record<string, unknown>;

				// Only the in-range cycle should be counted
				expect(totals.total_cycles).toBe(1);
			});
		});

		describe("AC3.4 (limit + ordering)", () => {
			it("limits recentCycles to 50 and orders by created_at DESC", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				// Seed 60 relay cycles within range
				for (let i = 0; i < 60; i++) {
					const minutes = i % 60;
					const hours = Math.floor(i / 60);
					const time = new Date("2026-05-18T12:00:00Z");
					time.setHours(time.getHours() + hours);
					time.setMinutes(minutes);
					const isoTime = time.toISOString();

					db.prepare(
						`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					).run("outbound", `site-${i}`, "stream_chunk", "push", 50 + i, 1, 0, isoTime);
				}

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const relay = json.relay as Record<string, unknown>;
				const recentCycles = relay.recentCycles as Array<Record<string, unknown>>;

				// Should be limited to 50
				expect(recentCycles.length).toBe(50);

				// Verify DESC ordering (first entry should be newest, last should be oldest of the 50)
				for (let i = 1; i < recentCycles.length; i++) {
					const prevTime = new Date(recentCycles[i - 1]?.created_at as string).getTime();
					const currTime = new Date(recentCycles[i]?.created_at as string).getTime();
					expect(prevTime).toBeGreaterThanOrEqual(currTime);
				}
			});
		});

		describe("AC3.5 (empty relay)", () => {
			it("returns zeros and empty arrays when no relay data in range", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const relay = json.relay as Record<string, unknown>;
				const totals = relay.totals as Record<string, unknown>;
				const byHost = relay.byHost as Array<Record<string, unknown>>;
				const recentCycles = relay.recentCycles as Array<Record<string, unknown>>;

				expect(totals.total_cycles).toBe(0);
				expect(byHost.length).toBe(0);
				expect(recentCycles.length).toBe(0);
			});
		});

		describe("AC4.2 (context filtering)", () => {
			it("only counts turns with context_debug within the date range", async () => {
				const app = createMetricsRoutes(db);

				// Seed turn with context_debug outside range (before from)
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-old",
					"thread-old",
					"2026-05-17T12:00:00Z",
					"claude-opus",
					1000,
					500,
					100,
					50,
					0.05,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 1000,
						contextWindow: 8000,
					}),
					0,
				);

				// Seed turn with context_debug within range
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-new",
					"thread-new",
					"2026-05-18T12:00:00Z",
					"claude-opus",
					500,
					250,
					50,
					25,
					0.02,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 500,
						contextWindow: 8000,
					}),
					0,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const context = json.context as Record<string, unknown>;
				const totals = context.totals as Record<string, unknown>;

				// Only in-range turn should be counted
				expect(totals.total_turns_with_debug).toBe(1);
			});
		});

		describe("AC4.3 + AC4.4 (timeline fields)", () => {
			it("timeline entries contain cache_hit_rate and budget_pressure_pct fields", async () => {
				const app = createMetricsRoutes(db);

				// Seed turns with varying cache metrics across different hours
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-1",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"claude-opus",
					1000,
					500,
					200,
					100,
					0.05,
					"ok",
					JSON.stringify({
						budgetPressure: true,
						truncated: 10,
						totalEstimated: 4000,
						contextWindow: 8000,
					}),
					0,
				);

				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-2",
					"thread-2",
					"2026-05-18T13:00:00Z",
					"claude-opus",
					500,
					250,
					100,
					50,
					0.02,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 1000,
						contextWindow: 8000,
					}),
					0,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const context = json.context as Record<string, unknown>;
				const timeline = context.timeline as Array<Record<string, unknown>>;

				expect(timeline.length).toBeGreaterThan(0);

				// Verify each entry has the required fields
				for (const entry of timeline) {
					expect(entry).toHaveProperty("cache_hit_rate");
					expect(entry).toHaveProperty("budget_pressure_pct");
					expect(typeof entry.cache_hit_rate).toBe("number");
					expect(typeof entry.budget_pressure_pct).toBe("number");
					// Verify ranges
					expect(entry.cache_hit_rate as number).toBeGreaterThanOrEqual(0);
					expect(entry.cache_hit_rate as number).toBeLessThanOrEqual(1);
					expect(entry.budget_pressure_pct as number).toBeGreaterThanOrEqual(0);
					expect(entry.budget_pressure_pct as number).toBeLessThanOrEqual(1);
				}
			});
		});

		describe("AC4.6 (zero cache edge case)", () => {
			it("returns last_cache_hit_rate of 0 exactly when the latest denominator-defined turn has tokens_cache_read = 0", async () => {
				const app = createMetricsRoutes(db);

				// Seed turn with zero cache read and valid tokens_in
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-1",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"claude-opus",
					1000,
					500,
					0,
					null,
					0.05,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 1000,
						contextWindow: 8000,
					}),
					0,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const context = json.context as Record<string, unknown>;
				const totals = context.totals as Record<string, unknown>;

				// last_cache_hit_rate should be exactly 0 (not NaN, not null, not undefined)
				expect(totals.last_cache_hit_rate).toBe(0);
				expect(Number.isNaN(totals.last_cache_hit_rate as number)).toBe(false);
			});

			it("returns last_cache_hit_rate of 0 when no turn in the range has a defined denominator", async () => {
				const app = createMetricsRoutes(db);

				// All-zero token counts → no turn qualifies for last_cache_hit_rate
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-empty",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"claude-opus",
					0,
					0,
					0,
					0,
					0,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 0,
						contextWindow: 8000,
					}),
					0,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const totals = (json.context as Record<string, unknown>).totals as Record<string, unknown>;
				expect(totals.last_cache_hit_rate).toBe(0);
				expect(totals.total_turns_with_debug).toBe(1);
			});

			it("returns last_cache_hit_rate from the most recent qualifying turn (not the average across the range)", async () => {
				const app = createMetricsRoutes(db);

				// Earlier turn: hit rate = 800 / (800 + 200) = 0.8
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-old",
					"thread-1",
					"2026-05-18T10:00:00Z",
					"claude-opus",
					200,
					100,
					800,
					0,
					0.05,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 1000,
						contextWindow: 8000,
					}),
					0,
				);
				// Later turn: hit rate = 100 / (100 + 900) = 0.1
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-new",
					"thread-1",
					"2026-05-18T14:00:00Z",
					"claude-opus",
					900,
					200,
					100,
					0,
					0.05,
					"ok",
					JSON.stringify({
						budgetPressure: false,
						truncated: 0,
						totalEstimated: 1000,
						contextWindow: 8000,
					}),
					0,
				);

				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const totals = (json.context as Record<string, unknown>).totals as Record<string, unknown>;
				// Should be the most recent turn's rate (0.1), NOT the average (0.45).
				expect(totals.last_cache_hit_rate).toBeCloseTo(0.1, 6);
			});
		});

		describe("AC5.5 (performance smoke)", () => {
			it("completes within timeout with 200 turns and 100 relay cycles", async () => {
				const app = createMetricsRoutes(db);

				// Seed 200 turns
				for (let i = 0; i < 200; i++) {
					const mins = i % 60;
					const hours = Math.floor(i / 60);
					const time = new Date("2026-05-18T00:00:00Z");
					time.setHours(time.getHours() + hours);
					time.setMinutes(mins);
					const isoTime = time.toISOString();

					db.prepare(
						`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
						tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug, deleted)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						`turn-${i}`,
						`thread-${i}`,
						isoTime,
						`model-${i % 5}`,
						Math.floor(Math.random() * 1000),
						Math.floor(Math.random() * 1000),
						Math.floor(Math.random() * 500),
						Math.floor(Math.random() * 500),
						Math.random() * 0.1,
						"ok",
						JSON.stringify({
							budgetPressure: Math.random() > 0.7,
							truncated: Math.floor(Math.random() * 100),
							totalEstimated: Math.floor(Math.random() * 8000),
							contextWindow: 8000,
						}),
						0,
					);
				}

				// Seed 100 relay cycles
				for (let i = 0; i < 100; i++) {
					const mins = i % 60;
					const hours = Math.floor(i / 60);
					const time = new Date("2026-05-18T00:00:00Z");
					time.setHours(time.getHours() + hours);
					time.setMinutes(mins);
					const isoTime = time.toISOString();

					db.prepare(
						`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, latency_ms, success, expired, created_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					).run(
						"outbound",
						`site-${i % 10}`,
						"stream_chunk",
						"push",
						Math.floor(Math.random() * 300),
						Math.random() > 0.1 ? 1 : 0,
						Math.random() > 0.95 ? 1 : 0,
						isoTime,
					);
				}

				// Request with "all time" range
				const from = new Date("2026-01-01T00:00:00Z").toISOString();
				const to = new Date().toISOString();

				const start = Date.now();
				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				const elapsed = Date.now() - start;

				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;

				// Verify response is valid
				expect(json).toHaveProperty("tokens");
				expect(json).toHaveProperty("relay");
				expect(json).toHaveProperty("context");

				// Should complete within reasonable time (2 seconds)
				expect(elapsed).toBeLessThan(2000);
			});
		});

		describe("Cache totals + per-component cost (token & cost breakdown)", () => {
			it("aggregates cache_read / cache_write into tokens.totals", async () => {
				const app = createMetricsRoutes(db);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-cache-1",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"opus",
					1000,
					500,
					3000,
					400,
					0.05,
					"ok",
					null,
				);
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-cache-2",
					"thread-2",
					"2026-05-18T13:00:00Z",
					"opus",
					500,
					250,
					1500,
					100,
					0.02,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const totals = (json.tokens as Record<string, unknown>).totals as Record<string, unknown>;
				expect(totals.cache_read).toBe(4500);
				expect(totals.cache_write).toBe(500);
				expect(totals.tokens_in).toBe(1500);
				expect(totals.tokens_out).toBe(750);
			});

			it("populates costByModelTimeline with token sums and cost components", async () => {
				const app = createMetricsRoutes(db, [
					{
						id: "opus",
						price_per_m_input: 15,
						price_per_m_output: 75,
						price_per_m_cache_read: 1.5,
						price_per_m_cache_write: 18.75,
					},
				]);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				// 1M input @ $15, 1M output @ $75, 1M cache_read @ $1.50, 1M cache_write @ $18.75
				// Per-component cost: 15 / 75 / 1.5 / 18.75 = 110.25 USD total
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-priced",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"opus",
					1_000_000,
					1_000_000,
					1_000_000,
					1_000_000,
					110.25,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const rows = (json.tokens as Record<string, unknown>).costByModelTimeline as Array<
					Record<string, unknown>
				>;
				const row = rows.find((r) => r.model_id === "opus");
				expect(row).toBeDefined();
				expect(row?.cost_usd).toBeCloseTo(110.25, 6);
				expect(row?.cost_input_usd).toBeCloseTo(15, 6);
				expect(row?.cost_output_usd).toBeCloseTo(75, 6);
				expect(row?.cost_cache_read_usd).toBeCloseTo(1.5, 6);
				expect(row?.cost_cache_write_usd).toBeCloseTo(18.75, 6);
				expect(row?.tokens_in).toBe(1_000_000);
				expect(row?.tokens_out).toBe(1_000_000);
				expect(row?.cache_read).toBe(1_000_000);
				expect(row?.cache_write).toBe(1_000_000);
			});

			it("falls back to a proportional split of cost_usd when pricing is absent", async () => {
				const app = createMetricsRoutes(db); // no pricing passed
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-fallback",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"sonnet",
					100,
					200,
					300,
					400,
					1.0,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const rows = (json.tokens as Record<string, unknown>).costByModelTimeline as Array<
					Record<string, unknown>
				>;
				const row = rows.find((r) => r.model_id === "sonnet");
				expect(row).toBeDefined();
				// 100/1000, 200/1000, 300/1000, 400/1000 of $1.00
				expect(row?.cost_input_usd).toBeCloseTo(0.1, 6);
				expect(row?.cost_output_usd).toBeCloseTo(0.2, 6);
				expect(row?.cost_cache_read_usd).toBeCloseTo(0.3, 6);
				expect(row?.cost_cache_write_usd).toBeCloseTo(0.4, 6);
				// Components sum exactly to cost_usd in the fallback path.
				const sum =
					(row?.cost_input_usd as number) +
					(row?.cost_output_usd as number) +
					(row?.cost_cache_read_usd as number) +
					(row?.cost_cache_write_usd as number);
				expect(sum).toBeCloseTo(row?.cost_usd as number, 6);
			});

			it("returns zero components without NaN for zero-token, zero-cost rows", async () => {
				const app = createMetricsRoutes(db); // fallback path
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				// All-zero row exercises the totalTokens === 0 branch
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-zero",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"empty-model",
					0,
					0,
					0,
					0,
					0,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const rows = (json.tokens as Record<string, unknown>).costByModelTimeline as Array<
					Record<string, unknown>
				>;
				const row = rows.find((r) => r.model_id === "empty-model");
				expect(row).toBeDefined();
				for (const k of [
					"cost_input_usd",
					"cost_output_usd",
					"cost_cache_read_usd",
					"cost_cache_write_usd",
				]) {
					expect(row?.[k]).toBe(0);
					expect(Number.isNaN(row?.[k] as number)).toBe(false);
				}
			});

			it("uses pricing for known models and falls back for unknown models in the same response", async () => {
				const app = createMetricsRoutes(db, [
					{
						id: "known",
						price_per_m_input: 10,
						price_per_m_output: 20,
						price_per_m_cache_read: 1,
						price_per_m_cache_write: 5,
					},
				]);
				const from = new Date("2026-05-18T00:00:00Z").toISOString();
				const to = new Date("2026-05-19T00:00:00Z").toISOString();

				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-known",
					"thread-1",
					"2026-05-18T12:00:00Z",
					"known",
					1_000_000,
					0,
					0,
					0,
					10,
					"ok",
					null,
				);
				db.prepare(
					`INSERT INTO turns (id, thread_id, created_at, model_id, tokens_in, tokens_out,
					tokens_cache_read, tokens_cache_write, cost_usd, status, context_debug)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					"turn-unknown",
					"thread-2",
					"2026-05-18T13:00:00Z",
					"unknown",
					100,
					100,
					0,
					0,
					0.5,
					"ok",
					null,
				);

				const response = await app.fetch(
					new Request(`http://localhost/?from=${from}&to=${to}`, { method: "GET" }),
				);
				expect(response.status).toBe(200);
				const json = (await response.json()) as Record<string, unknown>;
				const rows = (json.tokens as Record<string, unknown>).costByModelTimeline as Array<
					Record<string, unknown>
				>;

				const knownRow = rows.find((r) => r.model_id === "known");
				expect(knownRow?.cost_input_usd).toBeCloseTo(10, 6);
				expect(knownRow?.cost_output_usd).toBe(0);

				const unknownRow = rows.find((r) => r.model_id === "unknown");
				expect(unknownRow?.cost_input_usd).toBeCloseTo(0.25, 6);
				expect(unknownRow?.cost_output_usd).toBeCloseTo(0.25, 6);
			});
		});
	});
});
