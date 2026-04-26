/**
 * Cross-host cost/usage observability — turns table sync + status column +
 * UUID primary key.
 *
 * Context: bound_issue:turns-table:observability-gap. The turns table was
 * previously INTEGER AUTOINCREMENT PK and not in the sync replication set,
 * so cross-host cost analysis silently returned partial data. Migration
 * moves to TEXT UUID so rows can replicate via the change_log without PK
 * collisions across hosts.
 */

import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextDebugInfo } from "@bound/shared";
import { applyMetricsSchema, recordContextDebug, recordTurn } from "../metrics-schema";
import { applySchema } from "../schema";

describe("turns-observability — UUID primary key migration", () => {
	let dbPath: string;
	let db: Database;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-turns-obs-${randomBytes(4).toString("hex")}.db`);
		db = new Database(dbPath);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// already gone
		}
	});

	it("id column is TEXT (not INTEGER) after applyMetricsSchema on a fresh DB", () => {
		applyMetricsSchema(db);

		const cols = db.query("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
			pk: number;
		}>;
		const idCol = cols.find((c) => c.name === "id");

		expect(idCol).toBeDefined();
		expect(idCol?.type.toUpperCase()).toBe("TEXT");
		expect(idCol?.pk).toBe(1);
	});

	it("recordTurn returns a UUID string (not an integer)", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 100,
			tokens_out: 50,
			created_at: "2026-04-26T12:00:00.000Z",
		});

		// UUIDv4 shape: 8-4-4-4-12 hex groups
		expect(typeof turnId).toBe("string");
		expect(turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("recordContextDebug accepts string turn ids", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 10,
			tokens_out: 20,
			created_at: "2026-04-26T12:00:00.000Z",
		});

		const debug: ContextDebugInfo = {
			contextWindow: 200000,
			totalEstimated: 1000,
			model: "test-model",
			sections: [{ name: "system", tokens: 500 }],
			budgetPressure: false,
			truncated: 0,
		};

		// Should not throw on a string id
		recordContextDebug(db, turnId, debug);

		const row = db.query("SELECT context_debug FROM turns WHERE id = ?").get(turnId) as {
			context_debug: string | null;
		};
		expect(row.context_debug).toBeTruthy();
		expect(JSON.parse(row.context_debug as string).totalEstimated).toBe(1000);
	});

	it("migrates an existing legacy-INTEGER-id turns table without data loss", () => {
		// Simulate a DB created by a pre-migration version of bound.
		db.run(`
			CREATE TABLE turns (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				thread_id TEXT,
				task_id TEXT,
				dag_root_id TEXT,
				model_id TEXT NOT NULL,
				tokens_in INTEGER NOT NULL,
				tokens_out INTEGER NOT NULL,
				cost_usd REAL,
				created_at TEXT NOT NULL,
				relay_target TEXT,
				relay_latency_ms INTEGER,
				tokens_cache_write INTEGER,
				tokens_cache_read INTEGER,
				context_debug TEXT
			) STRICT
		`);

		// Insert a couple of legacy rows
		db.run(
			`INSERT INTO turns (model_id, tokens_in, tokens_out, cost_usd, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			["opus", 100, 50, 0.003, "2026-04-20T00:00:00.000Z"],
		);
		db.run(
			`INSERT INTO turns (model_id, tokens_in, tokens_out, cost_usd, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			["sonnet", 200, 75, 0.002, "2026-04-20T00:01:00.000Z"],
		);

		// Apply the current schema, which should detect legacy INTEGER id and migrate.
		applyMetricsSchema(db);

		const cols = db.query("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const idCol = cols.find((c) => c.name === "id");
		expect(idCol?.type.toUpperCase()).toBe("TEXT");

		// Data preserved
		const rows = db
			.query("SELECT id, model_id, tokens_in FROM turns ORDER BY created_at")
			.all() as Array<{
			id: string;
			model_id: string;
			tokens_in: number;
		}>;
		expect(rows.length).toBe(2);
		expect(rows[0].model_id).toBe("opus");
		expect(rows[1].model_id).toBe("sonnet");
		// IDs are now strings; original integer values are cast-preserved for stability
		expect(typeof rows[0].id).toBe("string");
		expect(typeof rows[1].id).toBe("string");
		// And distinct
		expect(rows[0].id).not.toBe(rows[1].id);
	});
});

describe("turns-observability — status column", () => {
	let dbPath: string;
	let db: Database;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-turns-status-${randomBytes(4).toString("hex")}.db`);
		db = new Database(dbPath);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// already gone
		}
	});

	it("turns table has a status column", () => {
		applyMetricsSchema(db);

		const cols = db.query("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const statusCol = cols.find((c) => c.name === "status");
		expect(statusCol).toBeDefined();
		expect(statusCol?.type.toUpperCase()).toBe("TEXT");
	});

	it("recordTurn defaults status to 'ok' when not provided", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "opus",
			tokens_in: 100,
			tokens_out: 50,
			created_at: "2026-04-26T12:00:00.000Z",
		});

		const row = db.query("SELECT status FROM turns WHERE id = ?").get(turnId) as {
			status: string;
		};
		expect(row.status).toBe("ok");
	});

	it("recordTurn accepts status='error' for failed inferences", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "nova-pro",
			tokens_in: 0,
			tokens_out: 0,
			status: "error",
			created_at: "2026-04-26T12:00:00.000Z",
		});

		const row = db.query("SELECT status, tokens_in FROM turns WHERE id = ?").get(turnId) as {
			status: string;
			tokens_in: number;
		};
		expect(row.status).toBe("error");
		expect(row.tokens_in).toBe(0);
	});

	it("recordTurn accepts status='aborted' for cancelled streams", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "opus",
			tokens_in: 0,
			tokens_out: 0,
			status: "aborted",
			created_at: "2026-04-26T12:00:00.000Z",
		});

		const row = db.query("SELECT status FROM turns WHERE id = ?").get(turnId) as {
			status: string;
		};
		expect(row.status).toBe("aborted");
	});
});

describe("turns-observability — change_log integration", () => {
	let dbPath: string;
	let db: Database;
	const siteId = "test-site-aaa";

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-turns-sync-${randomBytes(4).toString("hex")}.db`);
		db = new Database(dbPath);
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// already gone
		}
	});

	it("recordTurn with siteId emits a change_log entry for the turns table", () => {
		const turnId = recordTurn(
			db,
			{
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				created_at: "2026-04-26T12:00:00.000Z",
			},
			siteId,
		);

		const entries = db
			.query("SELECT table_name, row_id, row_data FROM change_log WHERE row_id = ?")
			.all(turnId) as Array<{ table_name: string; row_id: string; row_data: string }>;

		expect(entries.length).toBe(1);
		expect(entries[0].table_name).toBe("turns");
		expect(entries[0].row_id).toBe(turnId);

		const rowData = JSON.parse(entries[0].row_data) as Record<string, unknown>;
		expect(rowData.id).toBe(turnId);
		expect(rowData.model_id).toBe("opus");
		expect(rowData.tokens_in).toBe(100);
	});

	it("recordTurn without siteId writes NO change_log entry (backward compat)", () => {
		const turnId = recordTurn(db, {
			model_id: "opus",
			tokens_in: 100,
			tokens_out: 50,
			created_at: "2026-04-26T12:00:00.000Z",
		});

		const entries = db
			.query("SELECT COUNT(*) as n FROM change_log WHERE row_id = ?")
			.get(turnId) as { n: number };
		expect(entries.n).toBe(0);
	});

	it("recordContextDebug with siteId emits a change_log UPDATE carrying context_debug", () => {
		const turnId = recordTurn(
			db,
			{
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				created_at: "2026-04-26T12:00:00.000Z",
			},
			siteId,
		);

		const debug: ContextDebugInfo = {
			contextWindow: 200000,
			totalEstimated: 1000,
			model: "opus",
			sections: [{ name: "system", tokens: 500 }],
			budgetPressure: false,
			truncated: 0,
		};
		recordContextDebug(db, turnId, debug, siteId);

		// Two entries: INSERT from recordTurn, UPDATE from recordContextDebug.
		// The UPDATE carries context_debug so peer hosts can render the
		// context-debug panel for threads that bounced between hosts.
		const entries = db
			.query("SELECT row_data FROM change_log WHERE row_id = ? ORDER BY hlc")
			.all(turnId) as Array<{ row_data: string }>;
		expect(entries.length).toBe(2);
		const latest = JSON.parse(entries[entries.length - 1].row_data) as Record<string, unknown>;
		expect(latest).toHaveProperty("context_debug");
		expect(JSON.parse(latest.context_debug as string).totalEstimated).toBe(1000);
	});

	it("recordContextDebug without siteId is local-only (no change_log entry)", () => {
		const turnId = recordTurn(
			db,
			{
				model_id: "opus",
				tokens_in: 100,
				tokens_out: 50,
				created_at: "2026-04-26T12:00:00.000Z",
			},
			siteId,
		);

		const before = (db.query("SELECT COUNT(*) as n FROM change_log").get() as { n: number }).n;

		const debug: ContextDebugInfo = {
			contextWindow: 200000,
			totalEstimated: 1000,
			model: "opus",
			sections: [{ name: "system", tokens: 500 }],
			budgetPressure: false,
			truncated: 0,
		};
		// No siteId → stays local; matches the test / utility-script path.
		recordContextDebug(db, turnId, debug);

		const after = (db.query("SELECT COUNT(*) as n FROM change_log").get() as { n: number }).n;
		expect(after).toBe(before);
	});
});
