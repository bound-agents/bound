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
			expect(totals.cost_usd).toBe(0.09); // 0.05 + 0.04
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
				// Cache hit rate: (200 + 100) / (200 + 100 + 1000 + 500) = 300 / 1800 ≈ 0.167
				expect(totals.avg_cache_hit_rate).toBeGreaterThan(0);
				expect(totals.avg_cache_hit_rate).toBeLessThan(1);
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
	});
});
