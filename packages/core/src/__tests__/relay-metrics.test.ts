import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../database";
import { applyMetricsSchema } from "../metrics-schema";
import {
	type RelayCycleEntry,
	pruneRelayCycles,
	recordRelayCycle,
	recordTurnRelayMetrics,
} from "../relay-metrics";
import { applySchema } from "../schema";

describe("Relay Metrics", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	describe("Schema", () => {
		it("adds relay_target and relay_latency_ms columns to turns table", () => {
			const db = createDatabase(dbPath);
			applyMetricsSchema(db);

			const columns = db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
			const columnNames = columns.map((c) => c.name);

			expect(columnNames).toContain("relay_target");
			expect(columnNames).toContain("relay_latency_ms");

			db.close();
		});

		it("creates relay_cycles table with all required columns", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const columns = db.query("PRAGMA table_info(relay_cycles)").all() as Array<{
				name: string;
			}>;
			const columnNames = columns.map((c) => c.name);

			expect(columnNames).toContain("id");
			expect(columnNames).toContain("direction");
			expect(columnNames).toContain("peer_site_id");
			expect(columnNames).toContain("kind");
			expect(columnNames).toContain("delivery_method");
			expect(columnNames).toContain("latency_ms");
			expect(columnNames).toContain("expired");
			expect(columnNames).toContain("success");
			expect(columnNames).toContain("created_at");

			db.close();
		});

		it("creates index on relay_cycles created_at column", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const indexes = db
				.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
				.all() as Array<{ name: string }>;

			const indexNames = indexes.map((i) => i.name);
			expect(indexNames).toContain("idx_relay_cycles_created");

			db.close();
		});

		it("allows idempotent application of schema (relay_cycles)", () => {
			const db = createDatabase(dbPath);

			// Apply schema twice
			applySchema(db);
			applySchema(db);

			const tables = db
				.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
				.all() as Array<{ name: string }>;

			// Should still have 17 tables (16 original + relay_cycles)
			expect(tables.length).toBe(17);

			db.close();
		});

		it("applies metrics schema twice without error (idempotent)", () => {
			const db = createDatabase(dbPath);

			applyMetricsSchema(db);
			applyMetricsSchema(db);

			const columns = db.query("PRAGMA table_info(turns)").all() as Array<{ name: string }>;
			const columnNames = columns.map((c) => c.name);

			expect(columnNames).toContain("relay_target");
			expect(columnNames).toContain("relay_latency_ms");

			db.close();
		});
	});

	describe("recordTurnRelayMetrics", () => {
		it("records relay target and latency on turns row (mcp-relay.AC8.1)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);
			applyMetricsSchema(db);

			// Create a turn
			db.run(
				`INSERT INTO turns (model_id, tokens_in, tokens_out, created_at)
				 VALUES (?, ?, ?, ?)`,
				["claude-3-5-sonnet", 100, 50, new Date().toISOString()],
			);

			const turnId = (db.query("SELECT id FROM turns LIMIT 1").get() as { id: number }).id;

			// Record relay metrics
			recordTurnRelayMetrics(db, turnId, "spoke-a", 150);

			const turn = db
				.query("SELECT relay_target, relay_latency_ms FROM turns WHERE id = ?")
				.get(turnId) as {
				relay_target: string;
				relay_latency_ms: number;
			};

			expect(turn.relay_target).toBe("spoke-a");
			expect(turn.relay_latency_ms).toBe(150);

			db.close();
		});

		it("leaves relay_target and relay_latency_ms NULL for local tool calls (mcp-relay.AC8.2)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);
			applyMetricsSchema(db);

			// Create a turn without relay metrics
			db.run(
				`INSERT INTO turns (model_id, tokens_in, tokens_out, created_at)
				 VALUES (?, ?, ?, ?)`,
				["claude-3-5-sonnet", 100, 50, new Date().toISOString()],
			);

			const turn = db.query("SELECT relay_target, relay_latency_ms FROM turns LIMIT 1").get() as {
				relay_target: string | null;
				relay_latency_ms: number | null;
			};

			expect(turn.relay_target).toBeNull();
			expect(turn.relay_latency_ms).toBeNull();

			db.close();
		});
	});

	describe("recordRelayCycle", () => {
		it("records outbound relay cycle (mcp-relay.AC8.3)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const entry: RelayCycleEntry = {
				direction: "outbound",
				peer_site_id: "peer-1",
				kind: "tool_call",
				delivery_method: "sync",
				latency_ms: null,
				expired: false,
				success: true,
			};

			recordRelayCycle(db, entry);

			const cycle = db.query("SELECT * FROM relay_cycles LIMIT 1").get() as {
				direction: string;
				peer_site_id: string;
				kind: string;
				delivery_method: string;
				latency_ms: number | null;
				expired: number;
				success: number;
				created_at: string;
			};

			expect(cycle.direction).toBe("outbound");
			expect(cycle.peer_site_id).toBe("peer-1");
			expect(cycle.kind).toBe("tool_call");
			expect(cycle.delivery_method).toBe("sync");
			expect(cycle.latency_ms).toBeNull();
			expect(cycle.expired).toBe(0);
			expect(cycle.success).toBe(1);
			expect(cycle.created_at).toBeTruthy();

			db.close();
		});

		it("records inbound relay cycle (mcp-relay.AC8.3)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const entry: RelayCycleEntry = {
				direction: "inbound",
				peer_site_id: "peer-2",
				kind: "tool_result",
				delivery_method: "eager_push",
				latency_ms: 250,
				expired: false,
				success: true,
			};

			recordRelayCycle(db, entry);

			const cycle = db.query("SELECT * FROM relay_cycles LIMIT 1").get() as {
				direction: string;
				peer_site_id: string;
				kind: string;
				delivery_method: string;
				latency_ms: number | null;
				expired: number;
				success: number;
			};

			expect(cycle.direction).toBe("inbound");
			expect(cycle.peer_site_id).toBe("peer-2");
			expect(cycle.kind).toBe("tool_result");
			expect(cycle.delivery_method).toBe("eager_push");
			expect(cycle.latency_ms).toBe(250);
			expect(cycle.success).toBe(1);

			db.close();
		});

		it("records failed relay cycle", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const entry: RelayCycleEntry = {
				direction: "outbound",
				peer_site_id: "peer-1",
				kind: "tool_call",
				delivery_method: "sync",
				latency_ms: 5000,
				expired: true,
				success: false,
			};

			recordRelayCycle(db, entry);

			const cycle = db.query("SELECT * FROM relay_cycles LIMIT 1").get() as {
				expired: number;
				success: number;
			};

			expect(cycle.expired).toBe(1);
			expect(cycle.success).toBe(0);

			db.close();
		});

		it("records multiple relay cycles", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const entries: RelayCycleEntry[] = [
				{
					direction: "outbound",
					peer_site_id: "peer-1",
					kind: "tool_call",
					delivery_method: "sync",
					latency_ms: null,
					expired: false,
					success: true,
				},
				{
					direction: "inbound",
					peer_site_id: "peer-1",
					kind: "tool_result",
					delivery_method: "sync",
					latency_ms: 100,
					expired: false,
					success: true,
				},
			];

			for (const entry of entries) {
				recordRelayCycle(db, entry);
			}

			const cycles = db.query("SELECT COUNT(*) as count FROM relay_cycles").get() as {
				count: number;
			};

			expect(cycles.count).toBe(2);

			db.close();
		});
	});

	describe("pruneRelayCycles", () => {
		it("deletes relay_cycles older than 30 days (mcp-relay.AC8.4)", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const thirtyTwoDaysAgo = new Date(now.getTime() - 32 * 24 * 60 * 60 * 1000);
			const twentyEightDaysAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

			// Insert old entry (should be pruned - 32 days old)
			db.run(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["outbound", "peer-1", "tool_call", "sync", 0, 1, thirtyTwoDaysAgo.toISOString()],
			);

			// Insert recent entry (should NOT be pruned - 28 days old)
			db.run(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["outbound", "peer-1", "tool_call", "sync", 0, 1, twentyEightDaysAgo.toISOString()],
			);

			// Insert very recent entry (should NOT be pruned - today)
			db.run(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["outbound", "peer-1", "tool_call", "sync", 0, 1, now.toISOString()],
			);

			const beforeCount = (
				db.query("SELECT COUNT(*) as count FROM relay_cycles").get() as {
					count: number;
				}
			).count;
			expect(beforeCount).toBe(3);

			// Prune
			const deleted = pruneRelayCycles(db, 30);

			expect(deleted).toBe(1);

			const afterCount = (
				db.query("SELECT COUNT(*) as count FROM relay_cycles").get() as {
					count: number;
				}
			).count;
			expect(afterCount).toBe(2);

			// Verify old entry was deleted
			const oldEntries = db
				.query("SELECT COUNT(*) as count FROM relay_cycles WHERE created_at = ?")
				.get(thirtyTwoDaysAgo.toISOString()) as { count: number };

			expect(oldEntries.count).toBe(0);

			db.close();
		});

		it("returns number of deleted entries", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const thirtyTwoDaysAgo = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString();

			// Insert 3 old entries
			for (let i = 0; i < 3; i++) {
				db.run(
					`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					["outbound", "peer-1", "tool_call", "sync", 0, 1, thirtyTwoDaysAgo],
				);
			}

			const deleted = pruneRelayCycles(db, 30);
			expect(deleted).toBe(3);

			db.close();
		});

		it("does not delete entries with custom retention days", () => {
			const db = createDatabase(dbPath);
			applySchema(db);

			const now = new Date();
			const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
			const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

			// Insert entry that's 15 days old
			db.run(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["outbound", "peer-1", "tool_call", "sync", 0, 1, fifteenDaysAgo.toISOString()],
			);

			// Insert entry that's 60 days old
			db.run(
				`INSERT INTO relay_cycles (direction, peer_site_id, kind, delivery_method, expired, success, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				["outbound", "peer-1", "tool_call", "sync", 0, 1, sixtyDaysAgo.toISOString()],
			);

			// Prune with 30-day retention
			const deleted30 = pruneRelayCycles(db, 30);
			expect(deleted30).toBe(1); // Only 60-day-old entry

			// Verify 15-day-old entry still exists
			const remaining = (
				db.query("SELECT COUNT(*) as count FROM relay_cycles").get() as {
					count: number;
				}
			).count;
			expect(remaining).toBe(1);

			db.close();
		});
	});
});
