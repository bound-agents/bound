import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncedTableName } from "@bound/shared";
import { createDatabase } from "../database";
import { applyMetricsSchema } from "../metrics-schema";
import { applySchema } from "../schema";
import { getSyncedTableSchemas } from "../schema-introspection";

const EXPECTED_SYNCED_TABLES: readonly SyncedTableName[] = [
	"users",
	"threads",
	"messages",
	"semantic_memory",
	"tasks",
	"files",
	"hosts",
	"overlay_index",
	"cluster_config",
	"advisories",
	"skills",
	"memory_edges",
	"turns",
];

describe("getSyncedTableSchemas", () => {
	let dbPath: string;

	beforeEach(() => {
		dbPath = join(tmpdir(), `bound-test-introspect-${randomBytes(4).toString("hex")}.db`);
	});

	afterEach(() => {
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch {
			// ignore
		}
	});

	it("returns schemas for all synced tables", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const schemas = getSyncedTableSchemas(db);
		const names = schemas.map((s) => s.table).sort();
		const expected = [...EXPECTED_SYNCED_TABLES].sort();

		expect(names).toEqual(expected);

		db.close();
	});

	it("returns columns with name, type, notnull, and pk fields", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const schemas = getSyncedTableSchemas(db);
		const users = schemas.find((s) => s.table === "users");

		expect(users).toBeDefined();
		expect(users?.columns.length ?? 0).toBeGreaterThan(0);
		for (const col of users?.columns ?? []) {
			expect(typeof col.name).toBe("string");
			expect(typeof col.type).toBe("string");
			expect(typeof col.notnull).toBe("boolean");
			expect(typeof col.pk).toBe("boolean");
		}

		db.close();
	});

	it("marks primary key columns with pk=true", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const schemas = getSyncedTableSchemas(db);
		const users = schemas.find((s) => s.table === "users");
		const idCol = users?.columns.find((c) => c.name === "id");

		expect(idCol).toBeDefined();
		expect(idCol?.pk).toBe(true);

		const nonPkCol = users?.columns.find((c) => c.name !== "id" && c.name !== undefined);
		if (nonPkCol) {
			expect(nonPkCol.pk).toBe(false);
		}

		db.close();
	});

	it("preserves column order as declared in schema", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const schemas = getSyncedTableSchemas(db);
		const messages = schemas.find((s) => s.table === "messages");
		expect(messages).toBeDefined();

		// Expect id column first (declared first in schema.ts CREATE TABLE)
		expect(messages?.columns[0]?.name).toBe("id");

		db.close();
	});

	it("includes the turns table (observability)", () => {
		const db = createDatabase(dbPath);
		applySchema(db);
		applyMetricsSchema(db);

		const schemas = getSyncedTableSchemas(db);
		const turns = schemas.find((s) => s.table === "turns");

		expect(turns).toBeDefined();
		expect(turns?.columns.length ?? 0).toBeGreaterThan(0);

		db.close();
	});
});
