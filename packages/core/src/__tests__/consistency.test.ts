import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	type ConsistencyEntry,
	compareAllTables,
	countUnsyncableLocalOnly,
	getBackfillableEntriesSorted,
	getBackfillablePksSorted,
	getLocalPksSorted,
	hashRow,
	mergeDiffEntries,
	mergeDiffPks,
	syncableRowPredicate,
	syncableWhereClause,
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

describe("syncable-row filter symmetry (invariant #19; non-converging backfill regression)", () => {
	function makeMessagesDb(): Database {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT,
				modified_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			);
		`);
		// Two syncable rows and one unsyncable role='system' row.
		db.exec(`
			INSERT INTO messages (id, role, content, modified_at) VALUES ('m1', 'user', 'hi', '2026-01-01T00:00:00Z');
			INSERT INTO messages (id, role, content, modified_at) VALUES ('m2', 'assistant', 'yo', '2026-01-02T00:00:00Z');
			INSERT INTO messages (id, role, content, modified_at) VALUES ('sys', 'system', 'forbidden', '2026-01-03T00:00:00Z');
		`);
		return db;
	}

	test("predicate excludes role='system' for messages, null for other tables", () => {
		expect(syncableRowPredicate("messages")).toBe("role != 'system'");
		expect(syncableWhereClause("messages")).toBe(" WHERE role != 'system'");
		expect(syncableRowPredicate("turns")).toBeNull();
		expect(syncableWhereClause("turns")).toBe("");
	});

	test("comparing side (getBackfillable*) omits role='system' rows", () => {
		const db = makeMessagesDb();
		expect(getBackfillablePksSorted(db, "messages")).toEqual(["m1", "m2"]);
		expect(getBackfillableEntriesSorted(db, "messages").map((e) => e.pk)).toEqual(["m1", "m2"]);
	});

	test("advertising side (shared WHERE clause) yields the SAME pk set as the comparing side", () => {
		// The hub advertiser in ws-transport builds its query as
		// `SELECT * FROM messages{whereClause} ORDER BY id`. Simulate it here and
		// assert byte-for-byte agreement with the comparing side. Divergence is
		// exactly the bug: advertised-but-not-compared rows loop as remoteOnly.
		const db = makeMessagesDb();
		const advertised = (
			db
				.query(`SELECT id FROM messages${syncableWhereClause("messages")} ORDER BY id ASC`)
				.all() as Array<{ id: string }>
		).map((r) => r.id);
		const compared = getBackfillablePksSorted(db, "messages");
		expect(advertised).toEqual(compared);

		// The diff of the two identical sets must be empty — no phantom remoteOnly.
		const localEntries = getBackfillableEntriesSorted(db, "messages");
		const remoteEntries: ConsistencyEntry[] = advertised.map((pk) => {
			const e = localEntries.find((x) => x.pk === pk);
			if (!e) throw new Error(`advertised pk ${pk} missing from local entries`);
			return e;
		});
		const diff = mergeDiffEntries(localEntries, remoteEntries);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.localOnly).toEqual([]);
	});
});

describe("getLocalPksSorted / getBackfillablePksSorted (real synced tables)", () => {
	function makeMessagesDb(): Database {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				role TEXT NOT NULL,
				content TEXT,
				modified_at TEXT NOT NULL,
				deleted INTEGER NOT NULL DEFAULT 0
			);
		`);
		db.exec(`
			INSERT INTO messages (id, role, content, modified_at) VALUES ('m2', 'user', 'b', '2026-01-02T00:00:00Z');
			INSERT INTO messages (id, role, content, modified_at) VALUES ('m1', 'assistant', 'a', '2026-01-01T00:00:00Z');
			INSERT INTO messages (id, role, content, modified_at) VALUES ('sys', 'system', 'forbidden', '2026-01-03T00:00:00Z');
		`);
		return db;
	}

	test("getLocalPksSorted returns ALL pks ascending, including unsyncable system rows", () => {
		const db = makeMessagesDb();
		expect(getLocalPksSorted(db, "messages")).toEqual(["m1", "m2", "sys"]);
	});

	test("getBackfillablePksSorted drops the role='system' row", () => {
		const db = makeMessagesDb();
		expect(getBackfillablePksSorted(db, "messages")).toEqual(["m1", "m2"]);
	});

	test("getLocalPksSorted on a table with no syncable filter returns every row", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, modified_at TEXT NOT NULL);");
		db.exec(`
			INSERT INTO turns (id, modified_at) VALUES ('t2', '2026-01-02T00:00:00Z');
			INSERT INTO turns (id, modified_at) VALUES ('t1', '2026-01-01T00:00:00Z');
		`);
		expect(getLocalPksSorted(db, "turns")).toEqual(["t1", "t2"]);
		expect(getBackfillablePksSorted(db, "turns")).toEqual(["t1", "t2"]);
	});
});

describe("mergeDiffPks (PK-set three-way diff)", () => {
	test("classifies interleaved local-only, remote-only, and matching pks", () => {
		const diff = mergeDiffPks(["a", "c", "e"], ["b", "c", "d"]);
		expect(diff.localOnly).toEqual(["a", "e"]);
		expect(diff.remoteOnly).toEqual(["b", "d"]);
		expect(diff.matching).toBe(1);
	});

	test("drains a longer local tail into localOnly", () => {
		const diff = mergeDiffPks(["a", "b", "c", "d"], ["a"]);
		expect(diff.localOnly).toEqual(["b", "c", "d"]);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.matching).toBe(1);
	});

	test("drains a longer remote tail into remoteOnly", () => {
		const diff = mergeDiffPks(["a"], ["a", "b", "c"]);
		expect(diff.localOnly).toEqual([]);
		expect(diff.remoteOnly).toEqual(["b", "c"]);
		expect(diff.matching).toBe(1);
	});

	test("two empty inputs produce an empty diff", () => {
		expect(mergeDiffPks([], [])).toEqual({ localOnly: [], remoteOnly: [], matching: 0 });
	});
});

describe("countUnsyncableLocalOnly", () => {
	function dbWithMessages(rows: Array<{ id: string; role: string }>): Database {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL);");
		for (const r of rows) {
			db.query("INSERT INTO messages (id, role) VALUES (?, ?)").run(r.id, r.role);
		}
		return db;
	}

	test("returns [] for an empty local-only set without touching the db", () => {
		const db = dbWithMessages([]);
		expect(countUnsyncableLocalOnly(db, [])).toEqual([]);
	});

	test("reports the count of role='system' rows among the local-only pks", () => {
		const db = dbWithMessages([
			{ id: "a", role: "user" },
			{ id: "b", role: "system" },
			{ id: "c", role: "system" },
		]);
		const result = countUnsyncableLocalOnly(db, ["a", "b", "c"]);
		expect(result).toEqual([
			{ table: "messages", count: 2, reason: "role='system' (invariant #19, hub rejects these)" },
		]);
	});

	test("returns [] when the local-only set has no system rows", () => {
		const db = dbWithMessages([
			{ id: "a", role: "user" },
			{ id: "b", role: "assistant" },
		]);
		expect(countUnsyncableLocalOnly(db, ["a", "b"])).toEqual([]);
	});

	test("ignores a pk that does not resolve to a messages row", () => {
		const db = dbWithMessages([{ id: "a", role: "system" }]);
		// 'missing' has no row → null role → not counted; only 'a' counts.
		const result = countUnsyncableLocalOnly(db, ["a", "missing"]);
		expect(result).toEqual([
			{ table: "messages", count: 1, reason: "role='system' (invariant #19, hub rejects these)" },
		]);
	});
});

describe("compareAllTables", () => {
	function dbWithUsers(ids: string[]): Database {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, modified_at TEXT);");
		for (const id of ids) {
			db.query("INSERT INTO users (id, modified_at) VALUES (?, ?)").run(id, "2026-01-01T00:00:00Z");
		}
		return db;
	}

	test("a table absent from the remote map lands entirely in localOnly", () => {
		const db = dbWithUsers(["u1", "u2"]);
		const [diff] = compareAllTables(db, new Map(), ["users"]);
		expect(diff.table).toBe("users");
		expect(diff.localCount).toBe(2);
		expect(diff.remoteCount).toBe(0);
		expect(diff.localOnly).toEqual(["u1", "u2"]);
		expect(diff.remoteOnly).toEqual([]);
		expect(diff.matching).toBe(0);
	});

	test("diffs local pks against a present remote entry", () => {
		const db = dbWithUsers(["u1", "u2"]);
		const remote = new Map([["users", { count: 2, pks: ["u2", "u3"] }]]);
		const [diff] = compareAllTables(db, remote, ["users"]);
		expect(diff.localCount).toBe(2);
		expect(diff.remoteCount).toBe(2);
		expect(diff.localOnly).toEqual(["u1"]);
		expect(diff.remoteOnly).toEqual(["u3"]);
		expect(diff.matching).toBe(1);
	});

	test("defaults to the full synced-table list when no subset is given", () => {
		const db = new Database(":memory:");
		// Create every table compareAllTables enumerates so getLocalPksSorted can query each.
		const tables = [
			"users",
			"threads",
			"messages",
			"semantic_memory",
			"tasks",
			"files",
			"hosts",
			"cluster_config",
			"advisories",
			"skills",
			"memory_edges",
			"turns",
		];
		for (const t of tables) {
			const pk = t === "hosts" ? "site_id" : t === "cluster_config" ? "key" : "id";
			db.exec(`CREATE TABLE ${t} (${pk} TEXT PRIMARY KEY, role TEXT, modified_at TEXT);`);
		}
		const diffs = compareAllTables(db, new Map());
		expect(diffs.map((d) => d.table)).toEqual(tables);
		for (const d of diffs) {
			expect(d.localCount).toBe(0);
			expect(d.remoteCount).toBe(0);
		}
	});
});
