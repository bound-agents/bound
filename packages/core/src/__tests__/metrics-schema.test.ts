import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextDebugInfo } from "@bound/shared";
import { applyMetricsSchema, recordContextDebug, recordTurn } from "../metrics-schema";

describe("metrics-schema — AC4.6 cache token persistence", () => {
	let dbPath: string;
	let db: Database;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-metrics-test-${randomBytes(4).toString("hex")}.db`);
		db = new Database(dbPath);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// File already deleted
		}
	});

	it("should apply metrics schema with cache token columns", () => {
		applyMetricsSchema(db);

		// Verify turns table exists
		const tableInfo = db.prepare("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const columnNames = tableInfo.map((col) => col.name);

		expect(columnNames).toContain("tokens_cache_write");
		expect(columnNames).toContain("tokens_cache_read");
	});

	it("should persist cache token values from recordTurn()", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache_write: 100,
			tokens_cache_read: 50,
			created_at: "2026-03-29T12:00:00Z",
		});

		const row = db
			.prepare("SELECT tokens_cache_write, tokens_cache_read FROM turns WHERE id = ?")
			.get(turnId) as
			| { tokens_cache_write: number | null; tokens_cache_read: number | null }
			| undefined;

		expect(row).toBeDefined();
		expect(row?.tokens_cache_write).toBe(100);
		expect(row?.tokens_cache_read).toBe(50);
	});

	it("should persist NULL cache token values from recordTurn()", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 100,
			tokens_out: 50,
			tokens_cache_write: null,
			tokens_cache_read: null,
			created_at: "2026-03-29T12:00:00Z",
		});

		const row = db
			.prepare("SELECT tokens_cache_write, tokens_cache_read FROM turns WHERE id = ?")
			.get(turnId) as
			| { tokens_cache_write: number | null; tokens_cache_read: number | null }
			| undefined;

		expect(row).toBeDefined();
		expect(row?.tokens_cache_write).toBeNull();
		expect(row?.tokens_cache_read).toBeNull();
	});

	it("should handle idempotent ALTER TABLE for cache columns", () => {
		// Apply schema twice to verify idempotent behavior
		applyMetricsSchema(db);
		applyMetricsSchema(db);

		// Should not throw and should have the columns
		const tableInfo = db.prepare("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const columnNames = tableInfo.map((col) => col.name);

		expect(columnNames).toContain("tokens_cache_write");
		expect(columnNames).toContain("tokens_cache_read");
	});
});

describe("metrics-schema — AC3 context debug persistence", () => {
	let dbPath: string;
	let db: Database;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-metrics-test-${randomBytes(4).toString("hex")}.db`);
		db = new Database(dbPath);
	});

	afterEach(() => {
		db.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// File already deleted
		}
	});

	it("AC3.1: context_debug column exists after ensureMetricsSchema", () => {
		applyMetricsSchema(db);

		const tableInfo = db.prepare("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const columnNames = tableInfo.map((col) => col.name);

		expect(columnNames).toContain("context_debug");
	});

	it("AC3.3: ensureMetricsSchema is idempotent (no error on second call)", () => {
		applyMetricsSchema(db);
		// Second call should not throw
		applyMetricsSchema(db);

		const tableInfo = db.prepare("PRAGMA table_info(turns)").all() as Array<{
			name: string;
			type: string;
		}>;
		const columnNames = tableInfo.map((col) => col.name);

		expect(columnNames).toContain("context_debug");
	});

	it("AC3.4: turns created before migration have NULL context_debug", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 100,
			tokens_out: 50,
			created_at: "2026-03-29T12:00:00Z",
		});

		const row = db.prepare("SELECT context_debug FROM turns WHERE id = ?").get(turnId) as {
			context_debug: null | undefined;
		};

		expect(row).toBeDefined();
		expect(row.context_debug).toBeNull();
	});

	it("AC3.2: recordContextDebug stores valid JSON and is retrievable", () => {
		applyMetricsSchema(db);

		const turnId = recordTurn(db, {
			model_id: "test-model",
			tokens_in: 100,
			tokens_out: 50,
			created_at: "2026-03-29T12:00:00Z",
		});

		const debugInfo: ContextDebugInfo = {
			contextWindow: 200000,
			totalEstimated: 15000,
			model: "claude-3-5-sonnet",
			sections: [
				{ name: "system", tokens: 500 },
				{ name: "history", tokens: 14000 },
			],
			budgetPressure: false,
			truncated: 0,
		};

		recordContextDebug(db, turnId, debugInfo);

		const row = db.prepare("SELECT context_debug FROM turns WHERE id = ?").get(turnId) as {
			context_debug: string;
		};

		expect(row).toBeDefined();
		const parsed = JSON.parse(row.context_debug);
		expect(parsed).toEqual(debugInfo);
	});
});
