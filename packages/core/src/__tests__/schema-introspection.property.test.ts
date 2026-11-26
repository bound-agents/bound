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
 *   (D3 column-ordering and D5 synced-list membership live in
 *   schema-introspection.test.ts — not duplicated here.)
 *
 *   D4 Schema-stability under DML — INSERT / UPDATE / DELETE on
 *      synced tables does NOT change the schema output. (Only DDL
 *      should change it.)
 *
 *   D5 Total over the synced-table list — every name in the
 *      TABLE_REDUCER_MAP appears in the output,
 *      and no others.
 */

import type Database from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { TABLE_REDUCER_MAP } from "@bound/shared";
import fc from "fast-check";
import { getSyncedTableSchemas } from "../schema-introspection";
import { createCoreTestDb } from "./test-database";

function freshDb(): Database {
	const db = createCoreTestDb();
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
		const expected = Object.keys(TABLE_REDUCER_MAP).sort();
		expect(tableNames).toEqual(expected);
		db.close();
	});
});
