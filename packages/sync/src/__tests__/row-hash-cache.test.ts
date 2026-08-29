import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { applySchema, getCachedRowStateHashes } from "@bound/core";
import type { ChangeLogEntry } from "@bound/shared";
import { applyLWWReducer, applySnapshotRows } from "../reducers.js";

function cacheRow(db: Database, id: string): void {
	getCachedRowStateHashes(db, "semantic_memory", [id]);
	expect(
		db
			.query("SELECT 1 FROM row_state_hashes WHERE table_name = 'semantic_memory' AND pk = ?")
			.get(id),
	).not.toBeNull();
}

function memory(id: string, value: string, modifiedAt = "2026-01-01T00:00:00.000Z") {
	return {
		id,
		key: id,
		value,
		source: null,
		created_at: modifiedAt,
		modified_at: modifiedAt,
		last_accessed_at: null,
		tier: "default",
		deleted: 0,
	};
}

describe("row state hash cache invalidation for remote writes", () => {
	it("invalidates a warmed row on LWW application and snapshot raw upsert", () => {
		const db = new Database(":memory:");
		applySchema(db);
		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('lww', 'lww', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		);
		cacheRow(db, "lww");
		const event: ChangeLogEntry = {
			hlc: "2026-01-02T00:00:00.000Z_0001_site",
			table_name: "semantic_memory",
			row_id: "lww",
			site_id: "site",
			timestamp: "2026-01-02T00:00:00.000Z",
			row_data: JSON.stringify(memory("lww", "new", "2026-01-02T00:00:00.000Z")),
		};
		expect(applyLWWReducer(db, event).applied).toBe(true);
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'lww'").get()).toBeNull();

		db.run(
			"INSERT INTO semantic_memory (id, key, value, created_at, modified_at) VALUES ('snapshot', 'snapshot', 'old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
		);
		cacheRow(db, "snapshot");
		expect(
			applySnapshotRows(db, "semantic_memory", [
				memory("snapshot", "new", "2026-01-03T00:00:00.000Z"),
			]),
		).toBe(1);
		expect(db.query("SELECT 1 FROM row_state_hashes WHERE pk = 'snapshot'").get()).toBeNull();
		db.close();
	});
});
