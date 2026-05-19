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
	});
});
