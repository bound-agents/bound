import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, createDatabase, getSiteId } from "@bound/core";
import { cleanupTmpDir } from "@bound/shared/test-utils";
import { runRestore } from "../commands/restore.js";

/**
 * Behavioral coverage for restore.ts beyond the SQL-injection guards already
 * exercised in restore.test.ts: the actual restore-to-prior-snapshot and
 * tombstone-after-cutoff writes (both preview and execute), table filtering,
 * append-only skips, the no-candidates early return, and transaction rollback.
 *
 * Each test drives a file-backed DB under os.tmpdir() because runRestore reopens
 * via openBoundDB(configDir) (resolve(dir, "bound.db")) rather than taking a db
 * handle — so the on-disk bound.db must exist and carry a site_id.
 */

const SITE = "restore-site";

// A monotonic counter keeps every seeded change_log.hlc unique even when rows
// share a timestamp (hlc is the PK).
let hlcCounter = 0;

describe("restore command — restore and tombstone writes", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bound-restore-beh-"));
	});

	afterEach(async () => {
		await cleanupTmpDir(tempDir);
	});

	/** Create config/bound.db, apply schema, seed a site_id into host_meta. */
	function setupDb() {
		const dbPath = join(tempDir, "bound.db");
		const db = createDatabase(dbPath);
		applySchema(db);
		db.exec("INSERT OR REPLACE INTO host_meta (key, value) VALUES ('site_id', ?)", [SITE]);
		expect(getSiteId(db)).toBe(SITE);
		return db;
	}

	/** Insert a change_log row directly (test fixture, mirrors restore.test.ts). */
	function seedChangeLog(
		db: ReturnType<typeof setupDb>,
		opts: {
			table: string;
			rowId: string;
			timestamp: string;
			rowData: Record<string, unknown>;
			site?: string;
		},
	) {
		const hlc = `${opts.timestamp}_${String(hlcCounter++).padStart(4, "0")}_test`;
		db.query(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, ?, ?, ?, ?, ?)`,
		).run(
			hlc,
			opts.table,
			opts.rowId,
			opts.site ?? SITE,
			opts.timestamp,
			JSON.stringify(opts.rowData),
		);
	}

	function captureLog() {
		const lines: string[] = [];
		const original = console.log;
		console.log = (msg?: unknown) => {
			lines.push(String(msg ?? ""));
		};
		return {
			lines,
			restore: () => {
				console.log = original;
			},
		};
	}

	it("restores a row to its prior snapshot when a post-cutoff change edited it", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();

		// A real users row exists now in the mutated state.
		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u1", "Edited Name", before, after);

		// Prior snapshot (at/before cutoff) holds the original name.
		seedChangeLog(db, {
			table: "users",
			rowId: "u1",
			timestamp: before,
			rowData: {
				id: "u1",
				display_name: "Original Name",
				first_seen_at: before,
				modified_at: before,
				deleted: 0,
			},
		});
		// A post-cutoff edit flags the row as affected.
		seedChangeLog(db, {
			table: "users",
			rowId: "u1",
			timestamp: after,
			rowData: { id: "u1", display_name: "Edited Name", deleted: 0 },
		});
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: false, configDir: tempDir });
		} finally {
			cap.restore();
		}

		const reopened = createDatabase(join(tempDir, "bound.db"));
		const row = reopened.query("SELECT display_name FROM users WHERE id = ?").get("u1") as {
			display_name: string;
		} | null;
		expect(row?.display_name).toBe("Original Name");
		// A change_log entry was written for outbox compliance (restore + the two seeds).
		const clCount = reopened
			.query("SELECT COUNT(*) AS n FROM change_log WHERE table_name = 'users' AND row_id = 'u1'")
			.get() as { n: number };
		expect(clCount.n).toBeGreaterThanOrEqual(3);
		reopened.close();

		expect(cap.lines.join("\n")).toContain("Restore completed: 1 restored, 0 tombstoned.");
	});

	it("tombstones a row created after the cutoff (no prior snapshot)", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();

		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u2", "Created After", after, after);

		// Only a post-cutoff change_log entry — the row did not exist at the cutoff.
		seedChangeLog(db, {
			table: "users",
			rowId: "u2",
			timestamp: after,
			rowData: { id: "u2", display_name: "Created After", deleted: 0 },
		});
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: false, configDir: tempDir });
		} finally {
			cap.restore();
		}

		const reopened = createDatabase(join(tempDir, "bound.db"));
		const row = reopened.query("SELECT deleted FROM users WHERE id = ?").get("u2") as {
			deleted: number;
		} | null;
		expect(row?.deleted).toBe(1);
		reopened.close();

		expect(cap.lines.join("\n")).toContain("Restore completed: 0 restored, 1 tombstoned.");
	});

	it("preview mode reports actions without mutating rows", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();

		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u3", "Edited", before, after);
		seedChangeLog(db, {
			table: "users",
			rowId: "u3",
			timestamp: before,
			rowData: {
				id: "u3",
				display_name: "Original",
				first_seen_at: before,
				modified_at: before,
				deleted: 0,
			},
		});
		seedChangeLog(db, {
			table: "users",
			rowId: "u3",
			timestamp: after,
			rowData: { id: "u3", display_name: "Edited", deleted: 0 },
		});
		// A second row that was created after the cutoff → would tombstone.
		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u4", "New", after, after);
		seedChangeLog(db, {
			table: "users",
			rowId: "u4",
			timestamp: after,
			rowData: { id: "u4", display_name: "New", deleted: 0 },
		});
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: true, configDir: tempDir });
		} finally {
			cap.restore();
		}

		const joined = cap.lines.join("\n");
		expect(joined).toContain("PREVIEW MODE");
		expect(joined).toContain("RESTORE users.u3");
		expect(joined).toContain("TOMBSTONE users.u4");
		expect(joined).toContain("Preview summary: 1 would restore, 1 would tombstone.");
		expect(joined).toContain("Run without --preview to execute.");

		// Nothing changed on disk.
		const reopened = createDatabase(join(tempDir, "bound.db"));
		const u3 = reopened.query("SELECT display_name FROM users WHERE id = ?").get("u3") as {
			display_name: string;
		};
		const u4 = reopened.query("SELECT deleted FROM users WHERE id = ?").get("u4") as {
			deleted: number;
		};
		expect(u3.display_name).toBe("Edited");
		expect(u4.deleted).toBe(0);
		reopened.close();
	});

	it("skips append-only tables (messages) even when affected", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();
		seedChangeLog(db, {
			table: "messages",
			rowId: "m1",
			timestamp: after,
			rowData: { id: "m1", content: "hi" },
		});
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: true, configDir: tempDir });
		} finally {
			cap.restore();
		}
		expect(cap.lines.join("\n")).toContain(
			"No restorable rows affected after the given timestamp.",
		);
	});

	it("honors --tables filter, restoring only the named table", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();

		// users row affected after cutoff, with prior snapshot.
		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u5", "Edited", before, after);
		seedChangeLog(db, {
			table: "users",
			rowId: "u5",
			timestamp: before,
			rowData: {
				id: "u5",
				display_name: "Orig",
				first_seen_at: before,
				modified_at: before,
				deleted: 0,
			},
		});
		seedChangeLog(db, {
			table: "users",
			rowId: "u5",
			timestamp: after,
			rowData: { id: "u5", display_name: "Edited", deleted: 0 },
		});
		// A threads row also affected — but excluded by the --tables filter.
		seedChangeLog(db, {
			table: "threads",
			rowId: "t1",
			timestamp: after,
			rowData: { id: "t1" },
		});
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: true, tables: ["users"], configDir: tempDir });
		} finally {
			cap.restore();
		}
		const joined = cap.lines.join("\n");
		expect(joined).toContain("Found 1 affected row(s) across tables.");
		expect(joined).toContain("users.u5");
		expect(joined).not.toContain("threads.t1");
	});

	it("rolls back the whole restore when one row has an invalid column name", async () => {
		const db = setupDb();
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();

		// Good row: would restore cleanly on its own.
		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("good", "Edited", before, after);
		seedChangeLog(db, {
			table: "users",
			rowId: "good",
			timestamp: before,
			rowData: {
				id: "good",
				display_name: "Original",
				first_seen_at: before,
				modified_at: before,
				deleted: 0,
			},
		});
		seedChangeLog(db, {
			table: "users",
			rowId: "good",
			timestamp: after,
			rowData: { id: "good", display_name: "Edited", deleted: 0 },
		});
		// Bad row: prior snapshot carries an injection column name → throws mid-tx.
		seedChangeLog(db, {
			table: "users",
			rowId: "bad",
			timestamp: before,
			rowData: { id: "bad", "evil; DROP TABLE users; --": 1 },
		});
		seedChangeLog(db, {
			table: "users",
			rowId: "bad",
			timestamp: after,
			rowData: { id: "bad", display_name: "x", deleted: 0 },
		});
		db.close();

		const cap = captureLog();
		let threw = false;
		try {
			await runRestore({ before, preview: false, configDir: tempDir });
		} catch (error) {
			threw = true;
			expect(error instanceof Error ? error.message : "").toMatch(
				/Invalid column name|Invalid table name/,
			);
		} finally {
			cap.restore();
		}
		expect(threw).toBe(true);

		// ROLLBACK: the good row must NOT have been restored (still "Edited").
		const reopened = createDatabase(join(tempDir, "bound.db"));
		const row = reopened.query("SELECT display_name FROM users WHERE id = ?").get("good") as {
			display_name: string;
		};
		expect(row.display_name).toBe("Edited");
		reopened.close();
	});

	it("warns but proceeds when site_id is unreadable", async () => {
		const dbPath = join(tempDir, "bound.db");
		const db = createDatabase(dbPath);
		applySchema(db);
		// No site_id row seeded → getSiteId returns "unknown".
		const before = new Date(Date.now() - 120000).toISOString();
		const after = new Date().toISOString();
		db.query(
			"INSERT INTO users (id, display_name, first_seen_at, modified_at, deleted) VALUES (?, ?, ?, ?, 0)",
		).run("u6", "After", after, after);
		db.query(
			`INSERT INTO change_log (hlc, table_name, row_id, site_id, timestamp, row_data)
			VALUES (?, 'users', 'u6', 'x', ?, ?)`,
		).run(`${after}_0000_test`, after, JSON.stringify({ id: "u6", deleted: 0 }));
		db.close();

		const cap = captureLog();
		try {
			await runRestore({ before, preview: false, configDir: tempDir });
		} finally {
			cap.restore();
		}
		expect(cap.lines.join("\n")).toContain("Warning: unable to read site_id, using fallback.");
	});
});
