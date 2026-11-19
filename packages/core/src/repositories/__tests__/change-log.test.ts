import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import {
	type ChangeLogRestoreRow,
	countChangeLogEntries,
	findChangeLogEntryByHlc,
	findLatestChangeLogRowAtOrBefore,
	getChangeLogHlcAtOffset,
	getChangeLogHorizon,
	listChangeLogRowsAffectedAfter,
} from "../change-log";

/** change_log is a local, append-only table — seed it with raw INSERTs. */
function seedEntry(
	db: Database,
	row: {
		hlc: string;
		table_name: string;
		row_id: string;
		site_id?: string;
		timestamp: string;
		row_data?: string;
	},
): void {
	db.run(
		`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			row.hlc,
			row.table_name,
			row.row_id,
			row.site_id ?? "site-a",
			row.timestamp,
			row.row_data ?? "{}",
		],
	);
}

describe("change-log repository", () => {
	let db: Database;

	beforeEach(() => {
		db = createCoreTestDb();
	});

	afterEach(() => {
		db.close();
	});

	describe("getChangeLogHorizon", () => {
		it("returns null for an empty log (MIN over empty set)", () => {
			expect(getChangeLogHorizon(db)).toBeNull();
		});

		it("returns the earliest timestamp", () => {
			seedEntry(db, {
				hlc: "h2",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-03-03T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "h1",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "h3",
				table_name: "threads",
				row_id: "t2",
				timestamp: "2026-02-02T00:00:00.000Z",
			});
			expect(getChangeLogHorizon(db)).toBe("2026-01-01T00:00:00.000Z");
		});
	});

	describe("countChangeLogEntries", () => {
		it("returns 0 for an empty log", () => {
			expect(countChangeLogEntries(db)).toBe(0);
		});

		it("counts every entry", () => {
			seedEntry(db, {
				hlc: "h1",
				table_name: "a",
				row_id: "1",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "h2",
				table_name: "a",
				row_id: "2",
				timestamp: "2026-01-02T00:00:00.000Z",
			});
			expect(countChangeLogEntries(db)).toBe(2);
		});
	});

	describe("getChangeLogHlcAtOffset", () => {
		beforeEach(() => {
			// hlc sorts DESC: hlc-c, hlc-b, hlc-a
			seedEntry(db, {
				hlc: "hlc-a",
				table_name: "a",
				row_id: "1",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "hlc-b",
				table_name: "a",
				row_id: "2",
				timestamp: "2026-01-02T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "hlc-c",
				table_name: "a",
				row_id: "3",
				timestamp: "2026-01-03T00:00:00.000Z",
			});
		});

		it("returns the newest hlc at offset 0", () => {
			expect(getChangeLogHlcAtOffset(db, 0)).toBe("hlc-c");
		});

		it("returns the hlc at a given offset from newest", () => {
			expect(getChangeLogHlcAtOffset(db, 2)).toBe("hlc-a");
		});

		it("returns null for an offset past the end", () => {
			expect(getChangeLogHlcAtOffset(db, 99)).toBeNull();
		});
	});

	describe("listChangeLogRowsAffectedAfter", () => {
		it("returns distinct (table_name, row_id) for entries strictly after the timestamp", () => {
			seedEntry(db, {
				hlc: "h1",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "h2",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-05-05T00:00:00.000Z",
			});
			seedEntry(db, {
				hlc: "h3",
				table_name: "messages",
				row_id: "m1",
				timestamp: "2026-05-06T00:00:00.000Z",
			});
			const rows = listChangeLogRowsAffectedAfter(db, "2026-02-02T00:00:00.000Z");
			// t1 appears once despite two post-cutoff edits; the pre-cutoff edit is excluded
			expect(rows).toEqual([
				{ table_name: "messages", row_id: "m1" },
				{ table_name: "threads", row_id: "t1" },
			]);
		});

		it("returns [] when no entries follow the cutoff", () => {
			seedEntry(db, {
				hlc: "h1",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-01-01T00:00:00.000Z",
			});
			expect(listChangeLogRowsAffectedAfter(db, "2026-12-31T00:00:00.000Z")).toEqual([]);
		});
	});

	describe("findLatestChangeLogRowAtOrBefore", () => {
		it("returns the highest-hlc row at or before the timestamp for a given (table,row)", () => {
			seedEntry(db, {
				hlc: "hlc-1",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-01-01T00:00:00.000Z",
				row_data: '{"v":1}',
			});
			seedEntry(db, {
				hlc: "hlc-2",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-02-02T00:00:00.000Z",
				row_data: '{"v":2}',
			});
			seedEntry(db, {
				hlc: "hlc-3",
				table_name: "threads",
				row_id: "t1",
				timestamp: "2026-03-03T00:00:00.000Z",
				row_data: '{"v":3}',
			});
			const row = findLatestChangeLogRowAtOrBefore(
				db,
				"threads",
				"t1",
				"2026-02-15T00:00:00.000Z",
			) as ChangeLogRestoreRow;
			// hlc-3 is after the cutoff; hlc-2 is the latest at-or-before
			expect(row.row_data).toBe('{"v":2}');
			expect(row.timestamp).toBe("2026-02-02T00:00:00.000Z");
		});

		it("returns null when nothing matches the (table,row,cutoff)", () => {
			expect(
				findLatestChangeLogRowAtOrBefore(db, "threads", "ghost", "2026-12-31T00:00:00.000Z"),
			).toBeNull();
		});
	});

	describe("findChangeLogEntryByHlc", () => {
		it("returns the full entry for a known hlc", () => {
			seedEntry(db, {
				hlc: "hlc-x",
				table_name: "messages",
				row_id: "m9",
				site_id: "site-b",
				timestamp: "2026-04-04T00:00:00.000Z",
				row_data: '{"content":"hi"}',
			});
			const row = findChangeLogEntryByHlc<{
				hlc: string;
				table_name: string;
				row_id: string;
				site_id: string;
				timestamp: string;
				row_data: string;
			}>(db, "hlc-x");
			expect(row).toEqual({
				hlc: "hlc-x",
				table_name: "messages",
				row_id: "m9",
				site_id: "site-b",
				timestamp: "2026-04-04T00:00:00.000Z",
				row_data: '{"content":"hi"}',
			});
		});

		it("returns null for an unknown hlc", () => {
			expect(findChangeLogEntryByHlc(db, "nope")).toBeNull();
		});
	});
});
