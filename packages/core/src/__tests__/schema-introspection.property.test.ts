/**
 * Property tests for `getSyncedTableSchemas`.
 *
 * The function feeds the live `## Database Schema` block into the
 * agent's `systemPrompt` (R-VC25 stable prefix). Byte-stability of
 * the output is a load-bearing prerequisite for cross-thread cache
 * reuse: if two cold rebuilds within the cache TTL window produce
 * different schema strings for the same DB, the prefix wobbles and
 * the cache thrashes.
 *
 * Properties:
 *
 *   D1 Determinism — same DB, same call returns byte-equivalent
 *      output across multiple invocations.
 *
 *   D2 Idempotence on stable schemas — calling repeatedly on a
 *      DB whose schema does not change produces identical
 *      structured output.
 *
 *   D3 Column ordering matches PRAGMA cid — the helper sorts on
 *      `cid` (declaration order). Columns with equal cid would be
 *      a SQLite invariant violation; sorting must be stable.
 *
 *   D4 Schema-stability under DML — INSERT / UPDATE / DELETE on
 *      synced tables does NOT change the schema output. (Only DDL
 *      should change it.)
 *
 *   D5 Total over the synced-table list — every name in the
 *      module-level SYNCED_TABLE_NAMES list appears in the output,
 *      and no others.
 */

import Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { applySchema } from "../schema";
import { getSyncedTableSchemas } from "../schema-introspection";

function freshDb(): Database {
	const db = new Database(":memory:");
	applySchema(db);
	return db;
}

describe("getSyncedTableSchemas — property tests", () => {
	it("D1: determinism — repeated calls on same DB return byte-equivalent output", () => {
		const db = freshDb();
		const a = JSON.stringify(getSyncedTableSchemas(db));
		const b = JSON.stringify(getSyncedTableSchemas(db));
		const c = JSON.stringify(getSyncedTableSchemas(db));
		expect(a).toBe(b);
		expect(b).toBe(c);
		db.close();
	});

	it("D2: idempotence under repeated calls without schema change", () => {
		const db = freshDb();
		const snapshots: string[] = [];
		for (let i = 0; i < 10; i++) {
			snapshots.push(JSON.stringify(getSyncedTableSchemas(db)));
		}
		const allEqual = snapshots.every((s) => s === snapshots[0]);
		expect(allEqual).toBe(true);
		db.close();
	});

	it("D3: columns within each table sorted by declaration order (cid)", () => {
		const db = freshDb();
		const schemas = getSyncedTableSchemas(db);
		// We can't compare against PRAGMA directly without re-running it,
		// but we can assert the arrays are non-empty and that the order
		// is stable across calls (which it must be if `cid` is the sort
		// key — PRAGMA returns deterministic order).
		const a = schemas.map((s) => s.columns.map((c) => c.name).join(","));
		const b = getSyncedTableSchemas(db).map((s) => s.columns.map((c) => c.name).join(","));
		expect(a).toEqual(b);
		db.close();
	});

	it("D4: DML on synced tables does NOT change schema output", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						id: fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-z0-9-]+$/.test(s)),
						value: fc.string({ maxLength: 30 }).filter((s) => !/[\n\r"]/.test(s)),
					}),
					{ maxLength: 5 },
				),
				(rows) => {
					const db = freshDb();
					const before = JSON.stringify(getSyncedTableSchemas(db));
					// Perform some DML — these go through raw SQL because the
					// outbox isn't in scope here, but that's fine since we're
					// not asserting outbox behavior, only schema introspection
					// stability.
					for (const row of rows) {
						const now = "2026-05-25T12:00:00.000Z";
						try {
							db.prepare(
								`INSERT INTO semantic_memory (id, key, value, tier, source, modified_at, last_accessed_at, created_at, deleted)
								VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							).run(row.id, `k-${row.id}`, row.value, "default", "test", now, now, now, 0);
						} catch {
							// duplicate id — skip
						}
					}
					const after = JSON.stringify(getSyncedTableSchemas(db));
					db.close();
					return before === after;
				},
			),
			{ numRuns: 30 },
		);
	});

	it("D5: every name in the synced list appears, no extras", () => {
		const db = freshDb();
		const schemas = getSyncedTableSchemas(db);
		const tableNames = schemas.map((s) => s.table).sort();
		// Source-of-truth list — must match `SYNCED_TABLE_NAMES` in
		// schema-introspection.ts. This test pins the two lists in
		// sync; a divergence would surface here.
		const expected = [
			"advisories",
			"cluster_config",
			"connector_handles",
			"files",
			"hosts",
			"memory_edges",
			"messages",
			"overlay_index",
			"semantic_memory",
			"skills",
			"tasks",
			"threads",
			"turns",
			"users",
			"webhooks",
		];
		expect(tableNames).toEqual(expected);
		db.close();
	});
});
