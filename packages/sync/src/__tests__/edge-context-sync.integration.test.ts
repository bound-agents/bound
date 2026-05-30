import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChangeLogEntry } from "@bound/shared";
import { applyLWWReducer, clearColumnCache } from "../reducers.js";

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");

	// Minimal schema for memory_edges table with context column and triggers
	db.exec(`
		CREATE TABLE memory_edges (
			id          TEXT PRIMARY KEY,
			source_key  TEXT NOT NULL,
			target_key  TEXT NOT NULL,
			relation    TEXT NOT NULL,
			weight      REAL DEFAULT 1.0,
			context     TEXT,
			created_at  TEXT NOT NULL,
			modified_at TEXT NOT NULL,
			deleted     INTEGER DEFAULT 0
		);

		CREATE UNIQUE INDEX idx_edges_triple
			ON memory_edges(source_key, target_key, relation) WHERE deleted = 0;
		CREATE INDEX idx_edges_source ON memory_edges(source_key) WHERE deleted = 0;
		CREATE INDEX idx_edges_target ON memory_edges(target_key) WHERE deleted = 0;

		CREATE TRIGGER memory_edges_canonical_relation_insert
		BEFORE INSERT ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
		BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;

		CREATE TRIGGER memory_edges_canonical_relation_update
		BEFORE UPDATE OF relation ON memory_edges
		FOR EACH ROW WHEN NEW.relation NOT IN ('related_to','informs','supports','extends','complements','contrasts-with','competes-with','cites','summarizes','synthesizes')
		BEGIN SELECT RAISE(ABORT, 'Invalid relation. Must be one of: related_to, informs, supports, extends, complements, contrasts-with, competes-with, cites, summarizes, synthesizes. Use context column for bespoke phrasing.'); END;
	`);

	clearColumnCache();
});

afterEach(() => {
	db.close();
});

describe("edge-context-sync (AC5)", () => {
	it("AC5.1: Context column replicates correctly through sync layer", async () => {
		// Simulate a changelog entry from a peer with context
		const entry: ChangeLogEntry = {
			hlc: "2026-03-22T10:00:00.000Z_0001_peer-a",
			table_name: "memory_edges",
			row_id: "edge-ctx-1",
			site_id: "peer-a",
			timestamp: "2026-03-22T10:00:00Z",
			row_data: JSON.stringify({
				id: "edge-ctx-1",
				source_key: "memory_item_1",
				target_key: "memory_item_2",
				relation: "related_to",
				weight: 1.5,
				context: "foo", // Context column with value
				created_at: "2026-03-22T10:00:00Z",
				modified_at: "2026-03-22T10:00:00Z",
				deleted: 0,
			}),
		};

		// Apply the entry through the reducer (simulating sync replication)
		const result = applyLWWReducer(db, entry);
		expect(result.applied).toBe(true);

		// Query the row to verify context was persisted
		const row = db.prepare("SELECT * FROM memory_edges WHERE id = ?").get("edge-ctx-1") as {
			id: string;
			context: string;
			relation: string;
			weight: number;
		} | null;

		// Verify the row was replicated with context intact
		expect(row).not.toBeNull();
		expect(row?.context).toBe("foo");
		expect(row?.relation).toBe("related_to");
		expect(row?.weight).toBe(1.5);
	});

	it("AC5.2 (#105): heals a non-canonical relation on replay instead of rejecting it", async () => {
		// Manually create a ChangeLogEntry with a non-canonical relation
		const nonCanonicalEntry: ChangeLogEntry = {
			hlc: "2026-03-22T10:00:00.000Z_0001_peer-b",
			table_name: "memory_edges",
			row_id: "edge-bad",
			site_id: "peer-b",
			timestamp: "2026-03-22T10:00:00Z",
			row_data: JSON.stringify({
				id: "edge-bad",
				source_key: "mem1",
				target_key: "mem2",
				relation: "invalid-relation", // Non-canonical, bespoke (no spelling variant)
				weight: 1.0,
				context: null,
				created_at: "2026-03-22T10:00:00Z",
				modified_at: "2026-03-22T10:00:00Z",
				deleted: 0,
			}),
		};

		// Apply through the LWW reducer. Pre-#105 the trigger rejected this and the
		// row was dropped + re-warned on every reconnection. Now the receiver heals
		// the relation to the canonical fallback and the row lands.
		const result = applyLWWReducer(db, nonCanonicalEntry);

		expect(result.applied).toBe(true);

		const row = db.prepare("SELECT * FROM memory_edges WHERE id = ?").get("edge-bad") as {
			id: string;
			relation: string;
			context: string | null;
		} | null;
		expect(row).not.toBeNull();
		expect(row?.relation).toBe("related_to");
		// Original bespoke relation preserved in context so phrasing is not lost.
		expect(row?.context).toBe("invalid-relation");
	});

	it("AC5.3: FULL_SCHEMA includes context column and triggers", async () => {
		// Check that memory_edges table has context column
		const tableInfo = db.prepare("PRAGMA table_info(memory_edges)").all() as Array<{
			name: string;
			type: string;
		}>;
		const contextColumn = tableInfo.find((col) => col.name === "context");
		expect(contextColumn).toBeDefined();

		// Check that triggers exist
		const triggers = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='trigger'
				 AND tbl_name='memory_edges'
				 AND name LIKE 'memory_edges_canonical%'`,
			)
			.all() as Array<{ name: string }>;

		expect(triggers.length).toBeGreaterThanOrEqual(2); // INSERT and UPDATE triggers
		expect(triggers.some((t) => t.name.includes("insert"))).toBe(true);
		expect(triggers.some((t) => t.name.includes("update"))).toBe(true);

		// On replay, a non-canonical relation is healed (issue #105) rather than
		// rejected — the trigger still guards LOCAL writes, but synced rows from a
		// peer self-heal so they never trip it.
		const result = applyLWWReducer(db, {
			hlc: "2026-03-22T10:00:00.000Z_0001_test",
			table_name: "memory_edges",
			row_id: "edge-test-bad",
			site_id: "test",
			timestamp: "2026-03-22T10:00:00Z",
			row_data: JSON.stringify({
				id: "edge-test-bad",
				source_key: "m1",
				target_key: "m2",
				relation: "non-canonical-relation",
				weight: 1.0,
				context: null,
				created_at: "2026-03-22T10:00:00Z",
				modified_at: "2026-03-22T10:00:00Z",
				deleted: 0,
			}),
		});

		// The row lands with a healed relation instead of being dropped.
		expect(result.applied).toBe(true);

		const badRow = db.prepare("SELECT * FROM memory_edges WHERE id = ?").get("edge-test-bad") as {
			id: string;
			relation: string;
			context: string | null;
		} | null;
		expect(badRow).not.toBeNull();
		expect(badRow?.relation).toBe("related_to");
		expect(badRow?.context).toBe("non-canonical-relation");

		// Now verify that canonical relations ARE allowed (distinct endpoints so this
		// is not affected by the healed edge-test-bad above, which now occupies
		// (m1, m2, related_to)).
		const validResult = applyLWWReducer(db, {
			hlc: "2026-03-22T10:00:00.000Z_0002_test",
			table_name: "memory_edges",
			row_id: "edge-test-good",
			site_id: "test",
			timestamp: "2026-03-22T10:00:00Z",
			row_data: JSON.stringify({
				id: "edge-test-good",
				source_key: "m3",
				target_key: "m4",
				relation: "related_to", // Canonical!
				weight: 1.0,
				context: "test context",
				created_at: "2026-03-22T10:00:00Z",
				modified_at: "2026-03-22T10:00:00Z",
				deleted: 0,
			}),
		});

		expect(validResult.applied).toBe(true);

		const goodRow = db.prepare("SELECT * FROM memory_edges WHERE id = ?").get("edge-test-good") as {
			id: string;
			context: string;
		} | null;
		expect(goodRow).not.toBeNull();
		expect(goodRow?.context).toBe("test context");
	});
});
