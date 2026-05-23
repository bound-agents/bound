import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, insertRow, softDelete } from "@bound/core";
import { BOUND_NAMESPACE, deterministicUUID } from "@bound/shared";
import { loadDetailEntries } from "../summary-extraction.js";

let db: Database;
let dbPath: string;
const siteId = "test-site";

beforeEach(() => {
	dbPath = join(tmpdir(), `bound-test-${randomBytes(4).toString("hex")}.db`);
	db = createDatabase(dbPath);
	applySchema(db);
});

afterEach(() => {
	db.close();
	try {
		unlinkSync(dbPath);
	} catch {
		/* ignore */
	}
});

function insertMemory(
	db: Database,
	siteId: string,
	key: string,
	tier: "pinned" | "summary" | "detail" | "default",
	lastAccessedAt: string | null,
) {
	const now = new Date().toISOString();
	insertRow(
		db,
		"semantic_memory",
		{
			id: deterministicUUID(BOUND_NAMESPACE, key),
			key,
			value: `body of ${key}`,
			tier,
			source: "test",
			created_at: now,
			modified_at: now,
			last_accessed_at: lastAccessedAt,
			deleted: 0,
		},
		siteId,
	);
}

describe("loadDetailEntries", () => {
	it("case 1: Empty table → empty result", () => {
		const result = loadDetailEntries(db);
		expect(result.entries).toEqual([]);
	});

	it("case 2: Tier filtering — only detail entries returned", () => {
		const now = new Date().toISOString();

		insertMemory(db, siteId, "key_pinned", "pinned", now);
		insertMemory(db, siteId, "key_summary", "summary", now);
		insertMemory(db, siteId, "key_detail", "detail", now);
		insertMemory(db, siteId, "key_default", "default", now);

		const result = loadDetailEntries(db);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].key).toBe("key_detail");
	});

	it("case 3: Deleted filtering — soft-deleted rows excluded", () => {
		const now = new Date().toISOString();

		const detailId1 = deterministicUUID(BOUND_NAMESPACE, "detail_1");
		const detailId2 = deterministicUUID(BOUND_NAMESPACE, "detail_2");

		insertRow(
			db,
			"semantic_memory",
			{
				id: detailId1,
				key: "detail_1",
				value: "body 1",
				tier: "detail",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			siteId,
		);

		insertRow(
			db,
			"semantic_memory",
			{
				id: detailId2,
				key: "detail_2",
				value: "body 2",
				tier: "detail",
				source: "test",
				created_at: now,
				modified_at: now,
				last_accessed_at: now,
				deleted: 0,
			},
			siteId,
		);

		// Soft-delete the first entry
		softDelete(db, "semantic_memory", detailId1, siteId);

		const result = loadDetailEntries(db);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].key).toBe("detail_2");
	});

	it("case 4: Ordering by last_accessed_at DESC", () => {
		const time1 = new Date("2026-05-20T10:00:00.000Z").toISOString();
		const time2 = new Date("2026-05-21T10:00:00.000Z").toISOString();
		const time3 = new Date("2026-05-22T10:00:00.000Z").toISOString();

		insertMemory(db, siteId, "detail_oldest", "detail", time1);
		insertMemory(db, siteId, "detail_newest", "detail", time3);
		insertMemory(db, siteId, "detail_middle", "detail", time2);

		const result = loadDetailEntries(db);
		expect(result.entries).toHaveLength(3);
		expect(result.entries[0].key).toBe("detail_newest");
		expect(result.entries[1].key).toBe("detail_middle");
		expect(result.entries[2].key).toBe("detail_oldest");
	});

	it("case 5: Null last_accessed_at is preserved", () => {
		const now = new Date().toISOString();
		insertMemory(db, siteId, "detail_no_access", "detail", null);
		insertMemory(db, siteId, "detail_with_access", "detail", now);

		const result = loadDetailEntries(db);
		expect(result.entries).toHaveLength(2);

		// Find the null entry
		const nullEntry = result.entries.find((e) => e.key === "detail_no_access");
		expect(nullEntry).toBeDefined();
		expect(nullEntry?.last_accessed_at).toBeNull();
	});

	it("case 6: No last_accessed_at mutation (R-MV5)", () => {
		const now = new Date().toISOString();
		insertMemory(db, siteId, "detail_immutable", "detail", now);

		// Capture the value before the call
		const beforeRow = db
			.prepare("SELECT last_accessed_at FROM semantic_memory WHERE key = ?")
			.get("detail_immutable") as { last_accessed_at: string | null };
		const beforeValue = beforeRow.last_accessed_at;

		// Call loadDetailEntries
		loadDetailEntries(db);

		// Re-read after the call
		const afterRow = db
			.prepare("SELECT last_accessed_at FROM semantic_memory WHERE key = ?")
			.get("detail_immutable") as { last_accessed_at: string | null };
		const afterValue = afterRow.last_accessed_at;

		expect(afterValue).toBe(beforeValue);
	});
});
