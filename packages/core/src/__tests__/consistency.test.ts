import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	type ConsistencyEntry,
	getBackfillableEntriesSorted,
	hashRow,
	mergeDiffEntries,
} from "../consistency.js";

describe("hashRow", () => {
	test("produces deterministic hashes regardless of key insertion order", () => {
		const a = {
			id: "1",
			value: "x",
			deleted: 0,
			tier: "default",
			modified_at: "2026-01-01T00:00:00Z",
		};
		const b = {
			tier: "default",
			deleted: 0,
			modified_at: "2026-01-01T00:00:00Z",
			value: "x",
			id: "1",
		};
		expect(hashRow(a)).toBe(hashRow(b));
	});

	test("excludes modified_at from hash (else perpetual mismatches on apply)", () => {
		const a = { id: "1", value: "x", modified_at: "2026-01-01T00:00:00Z" };
		const b = { id: "1", value: "x", modified_at: "2026-12-31T23:59:59Z" };
		expect(hashRow(a)).toBe(hashRow(b));
	});

	test("includes deleted flag in hash (soft-delete tombstone detection)", () => {
		const live = {
			id: "1",
			value: "x",
			deleted: 0,
			modified_at: "2026-01-01T00:00:00Z",
		};
		const tombstoned = {
			id: "1",
			value: "x",
			deleted: 1,
			modified_at: "2026-01-01T00:00:00Z",
		};
		expect(hashRow(live)).not.toBe(hashRow(tombstoned));
	});

	test("includes tier in hash (tier-flip detection)", () => {
		const pinned = {
			id: "1",
			value: "x",
			tier: "pinned",
			modified_at: "2026-01-01T00:00:00Z",
		};
		const def = {
			id: "1",
			value: "x",
			tier: "default",
			modified_at: "2026-01-01T00:00:00Z",
		};
		expect(hashRow(pinned)).not.toBe(hashRow(def));
	});

	test("includes value mutations", () => {
		const before = { id: "1", value: "old", modified_at: "2026-01-01T00:00:00Z" };
		const after = { id: "1", value: "new", modified_at: "2026-01-01T00:00:00Z" };
		expect(hashRow(before)).not.toBe(hashRow(after));
	});

	test("treats null and undefined as equivalent (both serialize to null)", () => {
		const withNull = { id: "1", source: null };
		const withUndefined = { id: "1", source: undefined };
		expect(hashRow(withNull)).toBe(hashRow(withUndefined));
	});

	test("produces 64-char hex strings (SHA-256)", () => {
		const h = hashRow({ id: "1", value: "x" });
		expect(h).toMatch(/^[0-9a-f]{64}$/);
	});

	test("different rows produce different hashes (no collision on common shapes)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			seen.add(hashRow({ id: String(i), value: `v${i}` }));
		}
		expect(seen.size).toBe(1000);
	});
});

describe("mergeDiffEntries", () => {
	const e = (
		pk: string,
		hash: string,
		modified_at: string | null = "2026-01-01T00:00:00Z",
	): ConsistencyEntry => ({ pk, hash, modified_at });

	test("classifies localOnly correctly", () => {
		const local = [e("a", "h1"), e("b", "h2")];
		const remote = [e("a", "h1")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.localOnly).toEqual(["b"]);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.matching).toBe(1);
	});

	test("classifies remoteOnly correctly", () => {
		const local = [e("a", "h1")];
		const remote = [e("a", "h1"), e("c", "h3")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.localOnly).toEqual([]);
		expect(diff.remoteOnly).toEqual(["c"]);
		expect(diff.matching).toBe(1);
	});

	test("counts matching when hashes equal (no drift)", () => {
		const local = [e("a", "h1"), e("b", "h2")];
		const remote = [e("a", "h1"), e("b", "h2")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.matching).toBe(2);
		expect(diff.localOnly).toEqual([]);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.localNewerMismatch).toEqual([]);
		expect(diff.remoteNewerMismatch).toEqual([]);
	});

	test("classifies localNewerMismatch when local modified_at strictly greater", () => {
		const local = [e("a", "h_local", "2026-01-02T00:00:00Z")];
		const remote = [e("a", "h_remote", "2026-01-01T00:00:00Z")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.localNewerMismatch).toEqual(["a"]);
		expect(diff.remoteNewerMismatch).toEqual([]);
	});

	test("classifies remoteNewerMismatch when remote modified_at strictly greater", () => {
		const local = [e("a", "h_local", "2026-01-01T00:00:00Z")];
		const remote = [e("a", "h_remote", "2026-01-02T00:00:00Z")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.localNewerMismatch).toEqual([]);
		expect(diff.remoteNewerMismatch).toEqual(["a"]);
	});

	test("on tied modified_at, hub authoritative (remoteNewerMismatch)", () => {
		const local = [e("a", "h_local", "2026-01-01T00:00:00Z")];
		const remote = [e("a", "h_remote", "2026-01-01T00:00:00Z")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.remoteNewerMismatch).toEqual(["a"]);
		expect(diff.localNewerMismatch).toEqual([]);
	});

	test("when modified_at missing on local, falls to remoteNewerMismatch", () => {
		const local = [e("a", "h_local", null)];
		const remote = [e("a", "h_remote", "2026-01-02T00:00:00Z")];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.remoteNewerMismatch).toEqual(["a"]);
	});

	test("when modified_at missing on remote, falls to remoteNewerMismatch", () => {
		const local = [e("a", "h_local", "2026-01-02T00:00:00Z")];
		const remote = [e("a", "h_remote", null)];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.remoteNewerMismatch).toEqual(["a"]);
	});

	test("handles empty local", () => {
		const diff = mergeDiffEntries([], [e("a", "h1"), e("b", "h2")]);
		expect(diff.remoteOnly).toEqual(["a", "b"]);
		expect(diff.localOnly).toEqual([]);
	});

	test("handles empty remote", () => {
		const diff = mergeDiffEntries([e("a", "h1"), e("b", "h2")], []);
		expect(diff.localOnly).toEqual(["a", "b"]);
		expect(diff.remoteOnly).toEqual([]);
	});

	test("handles both empty", () => {
		const diff = mergeDiffEntries([], []);
		expect(diff.localOnly).toEqual([]);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.matching).toBe(0);
	});

	test("complex case: mix of all four categories", () => {
		const local = [
			e("a", "h_a", "2026-01-01T00:00:00Z"), // matching
			e("b", "h_b_local", "2026-01-02T00:00:00Z"), // localNewerMismatch
			e("c", "h_c_local", "2026-01-01T00:00:00Z"), // remoteNewerMismatch
			e("d", "h_d", "2026-01-01T00:00:00Z"), // localOnly
		];
		const remote = [
			e("a", "h_a", "2026-01-01T00:00:00Z"),
			e("b", "h_b_remote", "2026-01-01T00:00:00Z"),
			e("c", "h_c_remote", "2026-01-02T00:00:00Z"),
			e("e", "h_e", "2026-01-01T00:00:00Z"), // remoteOnly
		];
		const diff = mergeDiffEntries(local, remote);
		expect(diff.localOnly).toEqual(["d"]);
		expect(diff.remoteOnly).toEqual(["e"]);
		expect(diff.localNewerMismatch).toEqual(["b"]);
		expect(diff.remoteNewerMismatch).toEqual(["c"]);
		expect(diff.matching).toBe(1);
	});
});

describe("getBackfillableEntriesSorted", () => {
	function makeDb(): Database {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT,
				deleted INTEGER,
				tier TEXT
			);
		`);
		return db;
	}

	test("returns empty for empty table", () => {
		const db = makeDb();
		expect(getBackfillableEntriesSorted(db, "semantic_memory")).toEqual([]);
	});

	test("returns sorted entries with hashes and modified_at populated", () => {
		const db = makeDb();
		db.exec(`
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('row2', 'k2', 'v2', '2026-01-01', '2026-01-02T00:00:00Z', 0, 'default');
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('row1', 'k1', 'v1', '2026-01-01', '2026-01-01T00:00:00Z', 0, 'pinned');
		`);
		const entries = getBackfillableEntriesSorted(db, "semantic_memory");
		expect(entries.map((e) => e.pk)).toEqual(["row1", "row2"]);
		expect(entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
		expect(entries[0].modified_at).toBe("2026-01-01T00:00:00Z");
		expect(entries[1].modified_at).toBe("2026-01-02T00:00:00Z");
		expect(entries[0].hash).not.toBe(entries[1].hash);
	});

	test("BUG FIX: hash changes when tier flips (the actual MSI bug)", () => {
		const db = makeDb();
		db.exec(`
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('r', 'k', 'v', '2026-01-01', '2026-01-01T00:00:00Z', 0, 'pinned');
		`);
		const before = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		db.exec(`UPDATE semantic_memory SET tier = 'default' WHERE id = 'r';`);
		const after = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		expect(before).not.toBe(after);
	});

	test("BUG FIX: hash changes when soft-delete flag set", () => {
		const db = makeDb();
		db.exec(`
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('r', 'k', 'v', '2026-01-01', '2026-01-01T00:00:00Z', 0, 'default');
		`);
		const before = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		db.exec(`UPDATE semantic_memory SET deleted = 1 WHERE id = 'r';`);
		const after = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		expect(before).not.toBe(after);
	});

	test("BUG FIX: hash changes when value mutates", () => {
		const db = makeDb();
		db.exec(`
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('r', 'k', 'old', '2026-01-01', '2026-01-01T00:00:00Z', 0, 'default');
		`);
		const before = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		db.exec(`UPDATE semantic_memory SET value = 'new' WHERE id = 'r';`);
		const after = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		expect(before).not.toBe(after);
	});

	test("hash unchanged when only modified_at differs (avoids perpetual mismatch)", () => {
		const db = makeDb();
		db.exec(`
			INSERT INTO semantic_memory (id, key, value, created_at, modified_at, deleted, tier)
			VALUES ('r', 'k', 'v', '2026-01-01', '2026-01-01T00:00:00Z', 0, 'default');
		`);
		const before = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		db.exec(`UPDATE semantic_memory SET modified_at = '2026-12-31T23:59:59Z' WHERE id = 'r';`);
		const after = getBackfillableEntriesSorted(db, "semantic_memory")[0].hash;
		expect(before).toBe(after);
	});
});
