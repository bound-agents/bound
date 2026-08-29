import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dangerouslyExecuteRawWrite, insertRow, softDelete, updateRow } from "../change-log.js";
import { SYNCED_TABLE_NAMES } from "../change-log.js";
import { applyMetricsSchema } from "../metrics-schema.js";
import { computeRowStateHash } from "../row-hash-cache.js";
import { getCachedRowStateHashes } from "../row-hash-cache.js";
import { applySchema, installRowHashInvalidationTriggers } from "../schema.js";

describe("row state hash cache", () => {
	test("computes canonical hashes for cache misses and reuses warm entries", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'key', 'value', 'now', 'now')",
		);
		const cold = getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(cold.cacheMissCount).toBe(1);
		expect(cold.cacheHitCount).toBe(0);
		expect(cold.hashes.get("m1")).toBe(
			computeRowStateHash(
				db.query("SELECT * FROM semantic_memory WHERE id = 'm1'").get() as Record<string, unknown>,
			),
		);
		const warm = getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(warm.cacheHitCount).toBe(1);
		expect(warm.cacheMissCount).toBe(0);
		db.close();
	});

	test("selects every table column on a cache miss", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'k', 'v', 'now', 'now')",
		);
		const queries: string[] = [];
		const query = db.query.bind(db);
		(db as unknown as { query: typeof db.query }).query = ((sql: string) => {
			queries.push(sql);
			return query(sql);
		}) as typeof db.query;
		getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(queries.some((sql) => sql.startsWith("SELECT * FROM semantic_memory"))).toBe(true);
		expect(
			(db.query("PRAGMA table_info(semantic_memory)").all() as Array<{ name: string }>).map(
				(x) => x.name,
			),
		).toContain("last_accessed_at");
		db.close();
	});

	test("matches independent fixed SHA-256 digest fixtures for representative values", () => {
		const row = {
			id: "m1",
			key: "null-json",
			value: '{"x":1}',
			n: null,
			i: 42,
			f: 1.5,
			blob: new Uint8Array([1, 2, 255]),
			modified_at: "ignored",
		};
		expect(computeRowStateHash(row)).toBe(
			"c05b700393e9d797b038c7c7db40389f395aa51b5d0996c86981493a4fbf87cd",
		);
	});

	test("uses a UTF-8 byte range scan for non-ASCII cache keys", () => {
		const db = new Database(":memory:");
		applySchema(db);
		const ids = ["a", "x\u{10000}b", "x\uFF61a"];
		for (const id of ids)
			db.run(
				"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES (?, ?, ?, 'now', 'now')",
				[id, id, id],
			);
		getCachedRowStateHashes(db, "semantic_memory", ids);

		const result = getCachedRowStateHashes(db, "semantic_memory", ids);

		expect(result.cacheHitCount).toBe(3);
		expect(result.cacheMissCount).toBe(0);
		for (const id of ids)
			expect(result.hashes.get(id)).toBe(
				computeRowStateHash(
					db.query("SELECT * FROM semantic_memory WHERE id = ?").get(id) as Record<string, unknown>,
				),
			);
		db.close();
	});

	test("starts using a cache table created after an initial uncached lookup", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'key', 'value', 'now', 'now')",
		);
		db.run("DROP TABLE row_state_hashes");

		const uncached = getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(uncached.cacheMissCount).toBe(1);
		expect(uncached.cacheHitCount).toBe(0);

		installRowHashInvalidationTriggers(db);
		const cached = getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(cached.cacheMissCount).toBe(1);
		expect(
			db
				.query(
					"SELECT state_hash FROM row_state_hashes WHERE table_name = 'semantic_memory' AND pk = 'm1'",
				)
				.get(),
		).not.toBeNull();
		expect(getCachedRowStateHashes(db, "semantic_memory", ["m1"]).cacheHitCount).toBe(1);
		db.close();
	});

	test("triggers invalidate cached rows after a raw synced-table update", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('m1', 'key', 'old', 'now', 'now')",
		);
		getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		db.run("UPDATE semantic_memory SET value = 'new' WHERE id = 'm1'");
		const result = getCachedRowStateHashes(db, "semantic_memory", ["m1"]);
		expect(result.cacheMissCount).toBe(1);
		expect(result.hashes.get("m1")).toBe(
			computeRowStateHash(
				db.query("SELECT * FROM semantic_memory WHERE id = 'm1'").get() as Record<string, unknown>,
			),
		);
		db.close();
	});

	test("installs exactly three correct triggers for every synced table in either schema order and is idempotent", () => {
		for (const appliers of [
			[applySchema, applyMetricsSchema],
			[applyMetricsSchema, applySchema],
		] as const) {
			const db = new Database(":memory:");
			for (const apply of appliers) apply(db);
			for (const apply of appliers) apply(db);
			const triggers = db
				.query(
					"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'rsh_inv_%'",
				)
				.all() as Array<{ name: string; sql: string }>;
			expect(triggers).toHaveLength(17 * 3);
			for (const table of SYNCED_TABLE_NAMES)
				for (const op of ["insert", "update", "delete"])
					expect(triggers.map((t) => t.name)).toContain(`rsh_inv_${table}_${op}`);
			expect(
				triggers.filter((t) => t.name.includes("hosts_")).every((t) => t.sql.includes("site_id")),
			).toBe(true);
			expect(
				triggers
					.filter((t) => t.name.includes("cluster_config_"))
					.every((t) => t.sql.includes("key")),
			).toBe(true);
			expect(triggers.some((t) => t.name.includes("row_state_hashes"))).toBe(false);
			expect(SYNCED_TABLE_NAMES).not.toContain("row_state_hashes" as never);
			db.close();
		}
	});

	test("turns writes invalidate a cached row when metrics schema is applied after core schema", () => {
		const db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
		db.run(
			"INSERT INTO turns (id, model_id, tokens_in, tokens_out, created_at) VALUES ('t1', 'm', 1, 1, 'now')",
		);
		getCachedRowStateHashes(db, "turns", ["t1"]);
		expect(
			db.query("SELECT 1 FROM row_state_hashes WHERE table_name = 'turns' AND pk = 't1'").get(),
		).not.toBeNull();
		db.run("UPDATE turns SET tokens_in = 2 WHERE id = 't1'");
		expect(
			db.query("SELECT 1 FROM row_state_hashes WHERE table_name = 'turns' AND pk = 't1'").get(),
		).toBeNull();
		db.close();
	});

	test("schema write seams invalidate cached rows", () => {
		const db = new Database(":memory:");
		applySchema(db);
		const memory = (id: string, value: string) => ({
			id,
			key: id,
			value,
			created_at: "now",
			modified_at: "now",
			deleted: 0,
		});
		db.run("INSERT INTO row_state_hashes VALUES ('semantic_memory', 'insert', 'stale', 'now')");
		insertRow(db, "semantic_memory", memory("insert", "v"), "site");
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'insert'").get()).toBeNull();
		insertRow(db, "semantic_memory", memory("update", "v"), "site");
		getCachedRowStateHashes(db, "semantic_memory", ["update"]);
		updateRow(db, "semantic_memory", "update", { value: "new" }, "site");
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'update'").get()).toBeNull();
		expect(getCachedRowStateHashes(db, "semantic_memory", ["update"]).hashes.get("update")).toBe(
			computeRowStateHash(
				db.query("SELECT * FROM semantic_memory WHERE id = 'update'").get() as Record<
					string,
					unknown
				>,
			),
		);
		insertRow(db, "semantic_memory", memory("delete", "v"), "site");
		getCachedRowStateHashes(db, "semantic_memory", ["delete"]);
		softDelete(db, "semantic_memory", "delete", "site");
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'delete'").get()).toBeNull();
		insertRow(db, "semantic_memory", memory("raw", "v"), "site");
		getCachedRowStateHashes(db, "semantic_memory", ["raw"]);
		dangerouslyExecuteRawWrite(db, {
			sql: "UPDATE semantic_memory SET value = 'raw-new' WHERE id = 'raw'",
			reason: "test cache invalidation",
		});
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'raw'").get()).toBeNull();
		expect(getCachedRowStateHashes(db, "semantic_memory", ["raw"]).hashes.get("raw")).toBe(
			computeRowStateHash(
				db.query("SELECT * FROM semantic_memory WHERE id = 'raw'").get() as Record<string, unknown>,
			),
		);
		db.close();
	});
});
