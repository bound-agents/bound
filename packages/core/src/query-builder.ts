/**
 * Compile-only Kysely builder for typed reads over `bun:sqlite`.
 *
 * Repository functions are synchronous, so Kysely never executes anything: the
 * `DummyDriver` has no connection, and callers compile a query and run
 * `compiled.sql` / `compiled.parameters` through the existing `db.query(...)`.
 * `getOne` / `getAll` do that and carry the builder's inferred row type.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
	type Compilable,
	DummyDriver,
	Kysely,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";
import type { BoundDatabase } from "./db-types";

export const queryBuilder = new Kysely<BoundDatabase>({
	dialect: {
		createAdapter: () => new SqliteAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (db) => new SqliteIntrospector(db),
		createQueryCompiler: () => new SqliteQueryCompiler(),
	},
});

function compileForBun<O>(query: Compilable<O>): { sql: string; params: SQLQueryBindings[] } {
	const compiled = query.compile();
	return { sql: compiled.sql, params: compiled.parameters as SQLQueryBindings[] };
}

/** First row of `query`, or `null` when it matches nothing. */
export function getOne<O>(db: Database, query: Compilable<O>): O | null {
	const { sql, params } = compileForBun(query);
	return db.query<O, SQLQueryBindings[]>(sql).get(...params);
}

/** Every row of `query`, in the order SQLite returns them. */
export function getAll<O>(db: Database, query: Compilable<O>): O[] {
	const { sql, params } = compileForBun(query);
	return db.query<O, SQLQueryBindings[]>(sql).all(...params);
}
