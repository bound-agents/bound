import { describe, expect, it } from "bun:test";
import { BOUND_TABLE_COLUMNS } from "../db-types";
import { createCoreTestDb } from "./test-database";

const FTS5_SHADOW_SUFFIXES = ["config", "content", "data", "docsize", "idx"];

interface ColumnInfo {
	name: string;
	type: string;
	notnull: number;
	pk: number;
}

/** `PRAGMA table_info` rendered in the `BOUND_TABLE_COLUMNS` spec vocabulary. */
function specFor(column: ColumnInfo): string {
	const base = column.type === "" ? "untyped" : column.type.toLowerCase();
	const nullable = column.notnull === 0 && column.pk === 0;
	return nullable ? `${base}?` : base;
}

function freshSchemaColumns(): Record<string, Record<string, string>> {
	const db = createCoreTestDb({ metrics: true });
	try {
		const tables = db
			.query(
				"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as { name: string; sql: string }[];
		const virtualTables = tables
			.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql))
			.map((t) => t.name);
		const shadowTables = new Set(
			virtualTables.flatMap((vt) => FTS5_SHADOW_SUFFIXES.map((suffix) => `${vt}_${suffix}`)),
		);

		const result: Record<string, Record<string, string>> = {};
		for (const { name } of tables) {
			if (shadowTables.has(name)) continue;
			const columns = db.query(`PRAGMA table_info("${name}")`).all() as ColumnInfo[];
			result[name] = Object.fromEntries(columns.map((c) => [c.name, specFor(c)]));
		}
		return result;
	} finally {
		db.close();
	}
}

describe("BoundDatabase column map", () => {
	const actual = freshSchemaColumns();

	it("models exactly the tables a fresh schema creates", () => {
		expect(Object.keys(BOUND_TABLE_COLUMNS).sort()).toEqual(Object.keys(actual).sort());
	});

	for (const [table, columns] of Object.entries(BOUND_TABLE_COLUMNS)) {
		it(`${table}: columns, declared types, and nullability match PRAGMA table_info`, () => {
			expect({ ...columns }).toEqual(actual[table] ?? {});
		});
	}
});
