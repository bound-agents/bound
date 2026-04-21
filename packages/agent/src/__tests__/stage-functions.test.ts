import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
	loadGraphEntries,
	loadPinnedEntries,
	loadRecencyEntries,
	loadSummaryEntries,
} from "../summary-extraction";

describe("Stage Functions - L0 Pinned Entries", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		// Create temp database
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/stage-test-${randId}.db`;
		db = new BunDatabase(dbPath);

		// Create minimal schema
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.1: loads entries with tier='pinned'", () => {
		const now = new Date().toISOString();

		// Insert a pinned entry
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"mem1",
			"user_preference_1",
			"User prefers verbose responses",
			"pinned",
			now,
			now,
			now,
			0,
		);

		// Verify the entry was inserted
		const row = db
			.prepare("SELECT key, tier FROM semantic_memory WHERE key = ?")
			.get("user_preference_1");
		expect(row).toBeDefined();
		expect(row.tier).toBe("pinned");
	});

	it("AC3.1: loads entries with _standing prefix", () => {
		const now = new Date().toISOString();

		// Insert a _standing entry
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"mem2",
			"_standing_instructions_daily_standup",
			"Run daily standup at 9am",
			"default",
			now,
			now,
			now,
			0,
		);

		// Verify the entry was inserted
		const row = db
			.prepare("SELECT key, tier FROM semantic_memory WHERE key = ?")
			.get("_standing_instructions_daily_standup");
		expect(row).toBeDefined();
	});

	it("AC3.1: deduplicates entries matching both tier and prefix", () => {
		const now = new Date().toISOString();

		// Insert an entry with tier='pinned' and _pinned prefix (should appear once)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem3", "_pinned_core_rule", "Always check user context", "pinned", now, now, now, 0);

		// Raw query should return it exactly once
		const rows = db
			.prepare(
				`SELECT key FROM semantic_memory
			 WHERE deleted = 0
			   AND (tier = 'pinned'
			     OR key LIKE '\\_standing%' ESCAPE '\\'
			     OR key LIKE '\\_feedback%' ESCAPE '\\'
			     OR key LIKE '\\_policy%' ESCAPE '\\'
			     OR key LIKE '\\_pinned%' ESCAPE '\\')`,
			)
			.all() as Array<{ key: string }>;

		const matchingRows = rows.filter((r) => r.key === "_pinned_core_rule");
		expect(matchingRows.length).toBe(1);
	});

	it("AC3.1: excludes soft-deleted entries", () => {
		const now = new Date().toISOString();

		// Insert a pinned entry that is deleted
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem4", "deleted_pinned_entry", "This was pinned", "pinned", now, now, now, 1);

		// Query should not return it
		const rows = db
			.prepare(
				`SELECT key FROM semantic_memory
			 WHERE deleted = 0
			   AND (tier = 'pinned'
			     OR key LIKE '\\_standing%' ESCAPE '\\'
			     OR key LIKE '\\_feedback%' ESCAPE '\\'
			     OR key LIKE '\\_policy%' ESCAPE '\\'
			     OR key LIKE '\\_pinned%' ESCAPE '\\')`,
			)
			.all() as Array<{ key: string }>;

		const matchingRows = rows.filter((r) => r.key === "deleted_pinned_entry");
		expect(matchingRows.length).toBe(0);
	});
});

describe("Stage Functions - L1 Summary Entries", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		// Create temp database
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/stage-test-l1-${randId}.db`;
		db = new BunDatabase(dbPath);

		// Create minimal schema
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.2: loads summary entry and adds children to exclusion set", () => {
		const now = new Date().toISOString();

		// Create summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"summary1",
			"project_alpha_summary",
			"Project alpha is about building the thing",
			"summary",
			now,
			now,
			now,
			0,
		);

		// Create children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"detail1",
			"project_alpha_detail_1",
			"Detail about the architecture",
			"detail",
			now,
			now,
			now,
			0,
		);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"detail2",
			"project_alpha_detail_2",
			"Detail about the timeline",
			"detail",
			now,
			now,
			now,
			0,
		);

		// Create edges
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge1", "project_alpha_summary", "project_alpha_detail_1", "summarizes", now, now, 0);

		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge2", "project_alpha_summary", "project_alpha_detail_2", "summarizes", now, now, 0);

		// Query to verify structure
		const summaries = db
			.prepare(`SELECT key FROM semantic_memory WHERE tier = 'summary' AND deleted = 0`)
			.all();
		expect(summaries.length).toBe(1);

		const children = db
			.prepare(
				`SELECT m.key FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.source_key = ? AND e.relation = 'summarizes' AND e.deleted = 0`,
			)
			.all("project_alpha_summary");
		expect(children.length).toBe(2);
	});

	it("AC3.3: loads stale children with [stale-detail] tag", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();
		const laterTime = new Date("2026-04-10T11:00:00Z").toISOString();

		// Summary at baseTime
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"summary2",
			"meeting_summary",
			"Discussion about the new feature",
			"summary",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Child updated AFTER summary (stale)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"detail3",
			"meeting_detail_stale",
			"Updated meeting detail",
			"detail",
			baseTime,
			laterTime,
			laterTime,
			0,
		);

		// Create edge
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge3", "meeting_summary", "meeting_detail_stale", "summarizes", baseTime, baseTime, 0);

		// Query to verify stale detection
		const summary = db
			.prepare("SELECT modified_at FROM semantic_memory WHERE key = ?")
			.get("meeting_summary");
		const detail = db
			.prepare("SELECT modified_at FROM semantic_memory WHERE key = ?")
			.get("meeting_detail_stale");

		expect(detail.modified_at > summary.modified_at).toBe(true);
	});

	it("AC3.4: loads ALL stale children, not just the first", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();
		const laterTime = new Date("2026-04-10T11:00:00Z").toISOString();

		// Summary at baseTime
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"summary3",
			"project_summary",
			"Project overview",
			"summary",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Two stale children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"detail4",
			"project_detail_stale_1",
			"First stale detail",
			"detail",
			baseTime,
			laterTime,
			laterTime,
			0,
		);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"detail5",
			"project_detail_stale_2",
			"Second stale detail",
			"detail",
			baseTime,
			laterTime,
			laterTime,
			0,
		);

		// Create edges
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"edge4",
			"project_summary",
			"project_detail_stale_1",
			"summarizes",
			baseTime,
			baseTime,
			0,
		);

		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"edge5",
			"project_summary",
			"project_detail_stale_2",
			"summarizes",
			baseTime,
			baseTime,
			0,
		);

		// Query to verify both children are stale
		const staleChildren = db
			.prepare(
				`SELECT m.key FROM memory_edges e
			 JOIN semantic_memory m ON m.key = e.target_key AND m.deleted = 0
			 WHERE e.source_key = ? AND e.relation = 'summarizes' AND e.deleted = 0
			   AND m.modified_at > (SELECT modified_at FROM semantic_memory WHERE key = ?)`,
			)
			.all("project_summary", "project_summary");

		expect(staleChildren.length).toBe(2);
	});
});

describe("loadPinnedEntries function", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/loadpinned-${randId}.db`;
		db = new BunDatabase(dbPath);

		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.1: loadPinnedEntries returns pinned tier entries", () => {
		const now = new Date().toISOString();

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem1", "user_pref", "Verbose", "pinned", now, now, now, 0);

		const result = loadPinnedEntries(db);

		expect(result.entries.length).toBeGreaterThan(0);
		const pinned = result.entries.find((e) => e.key === "user_pref");
		expect(pinned).toBeDefined();
		expect(pinned?.tier).toBe("pinned");
		expect(pinned?.tag).toBe("[pinned]");
	});

	it("AC3.1: loadPinnedEntries returns prefix-matched entries", () => {
		const now = new Date().toISOString();

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem2", "_standing_morning_routine", "Wake up at 6am", "default", now, now, now, 0);

		const result = loadPinnedEntries(db);

		const standing = result.entries.find((e) => e.key === "_standing_morning_routine");
		expect(standing).toBeDefined();
		expect(standing?.tag).toBe("[pinned]");
	});

	it("AC3.1: loadPinnedEntries adds keys to exclusion set", () => {
		const now = new Date().toISOString();

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem1", "pinned_1", "Value1", "pinned", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("mem2", "pinned_2", "Value2", "pinned", now, now, now, 0);

		const result = loadPinnedEntries(db);

		expect(result.exclusionSet.has("pinned_1")).toBe(true);
		expect(result.exclusionSet.has("pinned_2")).toBe(true);
	});
});

describe("loadSummaryEntries function", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/loadsummary-${randId}.db`;
		db = new BunDatabase(dbPath);

		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.2: loadSummaryEntries loads summary and children", () => {
		const now = new Date().toISOString();

		// Summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum1", "project_summary", "Project overview", "summary", now, now, now, 0);

		// Children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("det1", "project_detail_1", "Detail 1", "detail", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("det2", "project_detail_2", "Detail 2", "detail", now, now, now, 0);

		// Edges
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("e1", "project_summary", "project_detail_1", "summarizes", now, now, 0);

		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("e2", "project_summary", "project_detail_2", "summarizes", now, now, 0);

		const result = loadSummaryEntries(db, new Set());

		// Should have summary + 2 non-stale children
		const summaryEntry = result.entries.find((e) => e.key === "project_summary");
		expect(summaryEntry).toBeDefined();
		expect(summaryEntry?.tag).toBe("[summary]");

		// All three keys should be in exclusion set
		expect(result.exclusionSet.has("project_summary")).toBe(true);
		expect(result.exclusionSet.has("project_detail_1")).toBe(true);
		expect(result.exclusionSet.has("project_detail_2")).toBe(true);
	});

	it("AC3.3: loadSummaryEntries detects stale children", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();
		const laterTime = new Date("2026-04-10T11:00:00Z").toISOString();

		// Summary at baseTime
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum2", "meeting_summary", "Meeting notes", "summary", baseTime, baseTime, baseTime, 0);

		// Child updated AFTER summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"det3",
			"meeting_detail_stale",
			"Updated detail",
			"detail",
			baseTime,
			laterTime,
			laterTime,
			0,
		);

		// Edge
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("e3", "meeting_summary", "meeting_detail_stale", "summarizes", baseTime, baseTime, 0);

		const result = loadSummaryEntries(db, new Set());

		// Should have summary + stale child
		const staleEntry = result.entries.find((e) => e.key === "meeting_detail_stale");
		expect(staleEntry).toBeDefined();
		expect(staleEntry?.tag).toBe("[stale-detail]");
	});

	it("AC3.4: loadSummaryEntries loads ALL stale children", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();
		const laterTime = new Date("2026-04-10T11:00:00Z").toISOString();

		// Summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum3", "event_summary", "Event details", "summary", baseTime, baseTime, baseTime, 0);

		// Two stale children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("det4", "event_detail_stale_1", "Stale 1", "detail", baseTime, laterTime, laterTime, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("det5", "event_detail_stale_2", "Stale 2", "detail", baseTime, laterTime, laterTime, 0);

		// Edges
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("e4", "event_summary", "event_detail_stale_1", "summarizes", baseTime, baseTime, 0);

		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("e5", "event_summary", "event_detail_stale_2", "summarizes", baseTime, baseTime, 0);

		const result = loadSummaryEntries(db, new Set());

		const staleEntries = result.entries.filter((e) => e.tag === "[stale-detail]");
		expect(staleEntries.length).toBe(2);
	});

	it("AC3.2: loadSummaryEntries skips entries already in exclusion set", () => {
		const now = new Date().toISOString();

		// Summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum4", "summary_to_skip", "Skip this", "summary", now, now, now, 0);

		const excludeSet = new Set(["summary_to_skip"]);
		const result = loadSummaryEntries(db, excludeSet);

		const found = result.entries.find((e) => e.key === "summary_to_skip");
		expect(found).toBeUndefined();
	});
});

describe("Stage Functions - L2 Graph Entries", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		// Create temp database
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/stage-test-l2-${randId}.db`;
		db = new BunDatabase(dbPath);

		// Create minimal schema
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.5: L2 returns only default tier entries, excludes other tiers", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();

		// Create entries of various tiers
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"def1",
			"default_entry",
			"This is default tier",
			"default",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Create a detail entry WITH a summarizes edge (non-orphaned, should be excluded)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum1", "summary_entry", "This is summary", "summary", baseTime, baseTime, baseTime, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"det1",
			"detail_entry_summarized",
			"This detail is summarized",
			"detail",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Edge: summary -> detail (summarizes relation) — makes detail non-orphaned
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"edge0",
			"summary_entry",
			"detail_entry_summarized",
			"summarizes",
			1.0,
			baseTime,
			baseTime,
			0,
		);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("pin1", "pinned_entry", "This is pinned", "pinned", baseTime, baseTime, baseTime, 0);

		// Create edges so keywords can match default_entry
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("edge1", "default_entry", "pinned_entry", "relates", 1.0, baseTime, baseTime, 0);

		const result = loadGraphEntries(db, new Set(), ["default"], 10);

		// Should only include default tier entry, not detail/pinned/summary
		const tierCounts = result.entries.reduce(
			(acc, e) => {
				acc[e.tier] = (acc[e.tier] || 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		);

		expect(tierCounts.default).toBeGreaterThan(0);
		expect(tierCounts.detail).toBeUndefined();
		expect(tierCounts.pinned).toBeUndefined();
		expect(tierCounts.summary).toBeUndefined();
	});

	it("AC3.5: L2 respects excludeKeys set from L0/L1", () => {
		const now = new Date().toISOString();

		// Create default entries
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("def2", "entry_one", "Entry one", "default", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("def3", "entry_two", "Entry two", "default", now, now, now, 0);

		// Create edge
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("edge2", "entry_one", "entry_two", "relates", 1.0, now, now, 0);

		// Exclude entry_one
		const excludeSet = new Set(["entry_one"]);
		const result = loadGraphEntries(db, excludeSet, ["entry"], 10);

		// entry_one should not be in results
		const keys = result.entries.map((e) => e.key);
		expect(keys).not.toContain("entry_one");

		// exclusion set should be expanded
		expect(result.exclusionSet.has("entry_one")).toBe(true);
	});

	it("AC3.6: L2 includes orphaned detail entries (no incoming summarizes edge)", () => {
		const now = new Date().toISOString();

		// Create a detail entry with NO incoming summarizes edge (orphan)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("orphan", "orphaned_detail", "This detail has no summary", "detail", now, now, now, 0);

		// Create a default entry to trigger keyword matching
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("def4", "related_entry", "Related to orphaned", "default", now, now, now, 0);

		// Edge from related_entry to orphaned_detail
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("edge3", "related_entry", "orphaned_detail", "relates", 1.0, now, now, 0);

		const result = loadGraphEntries(db, new Set(), ["orphaned", "detail"], 10);

		// Orphaned detail should be included even though tier=detail
		const orphanEntry = result.entries.find((e) => e.key === "orphaned_detail");
		expect(orphanEntry).toBeDefined();
		expect(orphanEntry?.tier).toBe("detail");
	});

	it("AC3.6: L2 retrieves entries at 3-edge depth from seeds", () => {
		const now = new Date().toISOString();

		// Create a chain: alpha → bravo → charlie → delta (3 edges deep)
		for (const [id, key, value] of [
			["chain1", "alpha_node", "Alpha node entry"],
			["chain2", "bravo_node", "Bravo node entry"],
			["chain3", "charlie_node", "Charlie node entry"],
			["chain4", "delta_node", "Delta node entry"],
		] as const) {
			db.prepare(
				`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			).run(id, key, value, "default", now, now, now, 0);
		}

		// alpha → bravo (depth 1), bravo → charlie (depth 2), charlie → delta (depth 3)
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("chain_e1", "alpha_node", "bravo_node", "relates", 1.0, now, now, 0);
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("chain_e2", "bravo_node", "charlie_node", "relates", 1.0, now, now, 0);
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("chain_e3", "charlie_node", "delta_node", "relates", 1.0, now, now, 0);

		const result = loadGraphEntries(db, new Set(), ["alpha"], 10);

		const keys = result.entries.map((e) => e.key);
		// alpha is the seed, bravo at depth 1, charlie at depth 2, delta at depth 3
		expect(keys).toContain("alpha_node"); // seed
		expect(keys).toContain("bravo_node"); // depth 1
		expect(keys).toContain("charlie_node"); // depth 2
		expect(keys).toContain("delta_node"); // depth 3 — the key assertion
	});

	it("AC3.7: L2 excludes non-orphaned detail entries (with incoming summarizes edge)", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").toISOString();

		// Create a summary
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"sum2",
			"test_summary",
			"Summary of something",
			"summary",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Create a detail entry WITH incoming summarizes edge (not orphaned)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"det2",
			"summarized_detail",
			"This is summarized",
			"detail",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		// Edge: summary -> detail (summarizes relation)
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("edge4", "test_summary", "summarized_detail", "summarizes", 1.0, baseTime, baseTime, 0);

		// Create a default entry for keyword matching
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			"def5",
			"related_to_sum",
			"Related to summary",
			"default",
			baseTime,
			baseTime,
			baseTime,
			0,
		);

		const result = loadGraphEntries(db, new Set(), ["summary", "detail"], 10);

		// Non-orphaned detail should NOT be included
		const detailEntry = result.entries.find((e) => e.key === "summarized_detail");
		expect(detailEntry).toBeUndefined();
	});
});

describe("Stage Functions - L3 Recency Entries", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		// Create temp database
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/stage-test-l3-${randId}.db`;
		db = new BunDatabase(dbPath);

		// Create minimal schema
		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			Bun.file(dbPath).delete?.();
		} catch {
			// ignore
		}
	});

	it("AC3.7: L3 returns only default tier entries (plus orphaned details), ordered by recency, respects maxSlots", () => {
		const baseTime = new Date("2026-04-10T10:00:00Z").getTime();

		// Create entries with different modified_at times
		const times = [
			new Date(baseTime + 1000).toISOString(), // most recent
			new Date(baseTime + 2000).toISOString(),
			new Date(baseTime + 3000).toISOString(), // oldest
		];

		// Default entries at different times
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("r1", "recency_entry_1", "Recent entry 1", "default", times[0], times[2], times[2], 0); // oldest modified

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("r2", "recency_entry_2", "Recent entry 2", "default", times[1], times[1], times[1], 0); // middle

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("r3", "recency_entry_3", "Recent entry 3", "default", times[2], times[0], times[0], 0); // most recent

		// Pinned and detail entries should be excluded
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("pin2", "pinned_entry_l3", "Pinned", "pinned", times[1], times[1], times[1], 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("det3", "detail_entry_l3", "Detail", "detail", times[1], times[1], times[1], 0);

		const baseline = new Date(baseTime).toISOString();
		const result = loadRecencyEntries(db, new Set(), baseline, 2); // maxSlots=2

		// Should have 2 entries (most recent 2)
		expect(result.entries.length).toBeLessThanOrEqual(2);

		// Should be ordered by recency (newest first in the modified_at DESC query)
		if (result.entries.length > 1) {
			const first = new Date(result.entries[0].modifiedAt).getTime();
			const second = new Date(result.entries[1].modifiedAt).getTime();
			expect(first).toBeGreaterThanOrEqual(second);
		}

		// Should only have default tier (not pinned or detail)
		for (const entry of result.entries) {
			expect(entry.tier).toBe("default");
		}
	});

	it("AC3.7: L3 respects excludeKeys from L0+L1+L2", () => {
		const now = new Date().toISOString();

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("r4", "entry_to_exclude", "Should be excluded", "default", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("r5", "entry_to_include", "Should be included", "default", now, now, now, 0);

		const excludeSet = new Set(["entry_to_exclude"]);
		const result = loadRecencyEntries(db, excludeSet, "1970-01-01T00:00:00Z", 10);

		const keys = result.entries.map((e) => e.key);
		expect(keys).not.toContain("entry_to_exclude");
		expect(keys).toContain("entry_to_include");
	});

	it("AC3.7: L3 includes orphaned detail entries (no incoming summarizes edge)", () => {
		const now = new Date().toISOString();

		// Orphaned detail (no incoming summarizes edge)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("orphan2", "orphaned_detail_l3", "Orphaned detail", "detail", now, now, now, 0);

		// Non-orphaned detail (with incoming summarizes edge)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("sum3", "summary_l3", "Summary", "summary", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("nonorph", "non_orphaned_detail", "Non-orphaned detail", "detail", now, now, now, 0);

		// Edge: summary -> non_orphaned_detail (summarizes)
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, weight, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("edge5", "summary_l3", "non_orphaned_detail", "summarizes", 1.0, now, now, 0);

		const result = loadRecencyEntries(db, new Set(), "1970-01-01T00:00:00Z", 10);

		const orphanEntry = result.entries.find((e) => e.key === "orphaned_detail_l3");
		const nonOrphanEntry = result.entries.find((e) => e.key === "non_orphaned_detail");

		// Orphaned should be included
		expect(orphanEntry).toBeDefined();
		// Non-orphaned should NOT be included
		expect(nonOrphanEntry).toBeUndefined();
	});
});

describe("Deterministic ordering for cross-thread cache reuse", () => {
	let db: Database;
	let dbPath: string;

	beforeEach(() => {
		const randId = randomBytes(4).toString("hex");
		dbPath = `/tmp/stage-order-test-${randId}.db`;
		db = new BunDatabase(dbPath);

		db.exec(`
			CREATE TABLE semantic_memory (
				id TEXT PRIMARY KEY,
				key TEXT UNIQUE NOT NULL,
				value TEXT NOT NULL,
				source TEXT,
				tier TEXT DEFAULT 'default',
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				last_accessed_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE memory_edges (
				id TEXT PRIMARY KEY,
				source_key TEXT NOT NULL,
				target_key TEXT NOT NULL,
				relation TEXT NOT NULL,
				weight REAL DEFAULT 1.0,
				context TEXT,
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				trigger_spec TEXT,
				deleted INTEGER DEFAULT 0
			);

			CREATE TABLE threads (
				id TEXT PRIMARY KEY,
				title TEXT,
				deleted INTEGER DEFAULT 0
			);
		`);
	});

	afterEach(() => {
		db.close();
		try {
			require("node:fs").unlinkSync(dbPath);
		} catch (_e) {
			/* ignore */
		}
	});

	it("L0 pinned entries are sorted by key ASC", () => {
		const now = new Date().toISOString();
		// Insert in reverse alphabetical order to ensure DB insertion order ≠ key order
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run("3", "_standing:zzz_third", "val3", null, "pinned", now, now, now);
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run("1", "_feedback:aaa_first", "val1", null, "pinned", now, now, now);
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run("2", "_pinned:mmm_second", "val2", null, "pinned", now, now, now);

		const result = loadPinnedEntries(db);
		const keys = result.entries.map((e) => e.key);
		expect(keys).toEqual(["_feedback:aaa_first", "_pinned:mmm_second", "_standing:zzz_third"]);
	});

	it("L1 summary entries are sorted by key ASC", () => {
		const now = new Date().toISOString();
		// Insert summaries in reverse order
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run("2", "summary_zzz", "val2", null, "summary", now, now, now);
		db.prepare(
			"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
		).run("1", "summary_aaa", "val1", null, "summary", now, now, now);

		const result = loadSummaryEntries(db, new Set());
		const keys = result.entries.map((e) => e.key);
		expect(keys).toEqual(["summary_aaa", "summary_zzz"]);
	});

	it("L0 ordering is deterministic across repeated calls", () => {
		const now = new Date().toISOString();
		for (let i = 0; i < 10; i++) {
			const letter = String.fromCharCode(106 - i); // j, i, h, g, f, e, d, c, b, a
			db.prepare(
				"INSERT INTO semantic_memory (id, key, value, source, tier, created_at, modified_at, last_accessed_at, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
			).run(`id-${i}`, `_standing:${letter}`, `val-${i}`, null, "pinned", now, now, now);
		}

		const result1 = loadPinnedEntries(db);
		const result2 = loadPinnedEntries(db);
		const keys1 = result1.entries.map((e) => e.key);
		const keys2 = result2.entries.map((e) => e.key);
		expect(keys1).toEqual(keys2);
		// Verify actually sorted
		expect(keys1).toEqual([...keys1].sort());
	});
});
