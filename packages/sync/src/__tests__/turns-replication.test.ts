/**
 * Cross-host turns replication — the sync side of
 * bound_issue:turns-table:observability-gap.
 *
 * These tests exercise the append-only reducer against the `turns` table:
 * change_log events produced by host A must replay cleanly on host B,
 * preserving token counts, cost, and status. `context_debug` is local-only
 * and must never appear in replicated row_data.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, recordTurn } from "@bound/core";
import type { ChangeLogEntry } from "@bound/shared";
import { TABLE_REDUCER_MAP } from "@bound/shared";
import { replayEvents } from "../reducers.js";

describe("turns-observability — sync replication", () => {
	describe("TABLE_REDUCER_MAP", () => {
		it("turns is registered as append-only", () => {
			// Cast to Record<string, ...> to sidestep the static SyncedTableName
			// check — the point of the test is that the runtime map contains it.
			const map = TABLE_REDUCER_MAP as unknown as Record<string, string>;
			expect(map.turns).toBe("append-only");
		});
	});

	describe("replay across two hosts", () => {
		let hostA: Database;
		let hostB: Database;
		const siteA = "site-aaaaaa";

		beforeEach(() => {
			hostA = new Database(":memory:");
			hostA.run("PRAGMA journal_mode = WAL");
			applySchema(hostA);
			applyMetricsSchema(hostA);

			hostB = new Database(":memory:");
			hostB.run("PRAGMA journal_mode = WAL");
			applySchema(hostB);
			applyMetricsSchema(hostB);
		});

		afterEach(() => {
			hostA.close();
			hostB.close();
		});

		function pullChangeLog(src: Database, tableName: string): ChangeLogEntry[] {
			return src
				.query(
					"SELECT hlc, table_name, row_id, site_id, timestamp, row_data FROM change_log WHERE table_name = ? ORDER BY hlc",
				)
				.all(tableName) as ChangeLogEntry[];
		}

		it("a turn recorded on host A replays as an identical row on host B", () => {
			const turnId = recordTurn(
				hostA,
				{
					thread_id: "thread-1",
					task_id: "task-1",
					model_id: "opus",
					tokens_in: 1000,
					tokens_out: 200,
					tokens_cache_read: 500,
					tokens_cache_write: 100,
					cost_usd: 0.015,
					created_at: "2026-04-26T12:00:00.000Z",
				},
				siteA,
			);

			const events = pullChangeLog(hostA, "turns");
			expect(events.length).toBe(1);
			expect(events[0].row_id).toBe(turnId);

			const result = replayEvents(hostB, events);
			expect(result.applied).toBe(1);
			expect(result.skipped).toBe(0);

			const row = hostB.query("SELECT * FROM turns WHERE id = ?").get(turnId) as Record<
				string,
				unknown
			>;
			expect(row).toBeDefined();
			expect(row.model_id).toBe("opus");
			expect(row.tokens_in).toBe(1000);
			expect(row.tokens_out).toBe(200);
			expect(row.tokens_cache_read).toBe(500);
			expect(row.tokens_cache_write).toBe(100);
			expect(row.cost_usd).toBe(0.015);
			expect(row.status).toBe("ok");
		});

		it("context_debug is NEVER populated on the receiving host (excluded from replication)", () => {
			const turnId = recordTurn(
				hostA,
				{
					thread_id: "thread-1",
					model_id: "opus",
					tokens_in: 100,
					tokens_out: 50,
					created_at: "2026-04-26T12:00:00.000Z",
				},
				siteA,
			);

			// Write context_debug locally on host A after the turn row is created
			// (this is the real-world ordering from agent-loop.ts).
			hostA.run("UPDATE turns SET context_debug = ? WHERE id = ?", [
				JSON.stringify({ local: "debug blob" }),
				turnId,
			]);

			const events = pullChangeLog(hostA, "turns");
			replayEvents(hostB, events);

			const row = hostB.query("SELECT context_debug FROM turns WHERE id = ?").get(turnId) as {
				context_debug: string | null;
			};
			expect(row.context_debug).toBeNull();

			// Host A still has its local debug blob
			const localRow = hostA.query("SELECT context_debug FROM turns WHERE id = ?").get(turnId) as {
				context_debug: string | null;
			};
			expect(localRow.context_debug).toBe(JSON.stringify({ local: "debug blob" }));
		});

		it("status='error' rows also replicate", () => {
			const turnId = recordTurn(
				hostA,
				{
					model_id: "nova-pro",
					tokens_in: 0,
					tokens_out: 0,
					status: "error",
					created_at: "2026-04-26T12:00:00.000Z",
				},
				siteA,
			);

			const events = pullChangeLog(hostA, "turns");
			replayEvents(hostB, events);

			const row = hostB.query("SELECT status, tokens_in FROM turns WHERE id = ?").get(turnId) as {
				status: string;
				tokens_in: number;
			};
			expect(row.status).toBe("error");
			expect(row.tokens_in).toBe(0);
		});

		it("duplicate turn events are idempotent (append-only ON CONFLICT DO NOTHING)", () => {
			const turnId = recordTurn(
				hostA,
				{
					model_id: "opus",
					tokens_in: 100,
					tokens_out: 50,
					created_at: "2026-04-26T12:00:00.000Z",
				},
				siteA,
			);

			const events = pullChangeLog(hostA, "turns");

			const r1 = replayEvents(hostB, events);
			const r2 = replayEvents(hostB, events);

			expect(r1.applied).toBe(1);
			expect(r2.applied).toBe(0); // second pass no-ops

			const count = (hostB.query("SELECT COUNT(*) as n FROM turns").get() as { n: number }).n;
			expect(count).toBe(1);
			expect(turnId).toBeTruthy();
		});
	});
});
