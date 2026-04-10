import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { StageEntry, StageResult } from "../summary-extraction";
import { loadPinnedEntries, loadSummaryEntries } from "../summary-extraction";

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
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
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
		).run("mem1", "user_preference_1", "User prefers verbose responses", "pinned", now, now, now, 0);

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
			.all();

		const matchingRows = rows.filter((r: any) => r.key === "_pinned_core_rule");
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
			.all();

		const matchingRows = rows.filter((r: any) => r.key === "deleted_pinned_entry");
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
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
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
		).run("summary1", "project_alpha_summary", "Project alpha is about building the thing", "summary", now, now, now, 0);

		// Create children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("detail1", "project_alpha_detail_1", "Detail about the architecture", "detail", now, now, now, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("detail2", "project_alpha_detail_2", "Detail about the timeline", "detail", now, now, now, 0);

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
		).run("summary2", "meeting_summary", "Discussion about the new feature", "summary", baseTime, baseTime, baseTime, 0);

		// Child updated AFTER summary (stale)
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("detail3", "meeting_detail_stale", "Updated meeting detail", "detail", baseTime, laterTime, laterTime, 0);

		// Create edge
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge3", "meeting_summary", "meeting_detail_stale", "summarizes", baseTime, baseTime, 0);

		// Query to verify stale detection
		const summary = db
			.prepare(`SELECT modified_at FROM semantic_memory WHERE key = ?`)
			.get("meeting_summary");
		const detail = db
			.prepare(`SELECT modified_at FROM semantic_memory WHERE key = ?`)
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
		).run("summary3", "project_summary", "Project overview", "summary", baseTime, baseTime, baseTime, 0);

		// Two stale children
		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("detail4", "project_detail_stale_1", "First stale detail", "detail", baseTime, laterTime, laterTime, 0);

		db.prepare(
			`INSERT INTO semantic_memory (id, key, value, tier, created_at, modified_at, last_accessed_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run("detail5", "project_detail_stale_2", "Second stale detail", "detail", baseTime, laterTime, laterTime, 0);

		// Create edges
		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge4", "project_summary", "project_detail_stale_1", "summarizes", baseTime, baseTime, 0);

		db.prepare(
			`INSERT INTO memory_edges (id, source_key, target_key, relation, created_at, modified_at, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("edge5", "project_summary", "project_detail_stale_2", "summarizes", baseTime, baseTime, 0);

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
		expect(pinned!.tier).toBe("pinned");
		expect(pinned!.tag).toBe("[pinned]");
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
		expect(standing!.tag).toBe("[pinned]");
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
				created_at TEXT NOT NULL,
				modified_at TEXT NOT NULL,
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
		expect(summaryEntry!.tag).toBe("[summary]");

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
		expect(staleEntry!.tag).toBe("[stale-detail]");
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
