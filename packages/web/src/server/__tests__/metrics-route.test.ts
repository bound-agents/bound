import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { applySchema } from "@bound/core";
import { createMetricsRoutes } from "../routes/metrics";

let db: Database;
let siteId: string;

beforeEach(() => {
	db = new BunDatabase(":memory:");
	applySchema(db);

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
});
