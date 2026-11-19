import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "@bound/core";
import { runResume, runStop } from "../stop-resume";

/**
 * stop/resume open the DB from a path derived from the config dir:
 * resolveDataDir(configDir) = <parent-of-config>/data/bound.db. So we lay out a
 * temp tree of sibling config/ + data/ dirs, matching `bound init`, and pass
 * configDir = <tmp>/config.
 */
describe("runStop / runResume", () => {
	let tmp: string;
	let configDir: string;
	let dbPath: string;
	let logs: string[];
	let origLog: typeof console.log;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), `stop-resume-${randomBytes(4).toString("hex")}-`));
		configDir = join(tmp, "config");
		const dataDir = join(tmp, "data");
		mkdirSync(configDir);
		mkdirSync(dataDir);
		dbPath = join(dataDir, "bound.db");

		const db = new Database(dbPath);
		applySchema(db);
		db.query("INSERT INTO host_meta (key, value) VALUES (?, ?)").run("site_id", "site-abcd1234");
		db.close();

		logs = [];
		origLog = console.log;
		console.log = (m?: unknown) => logs.push(String(m));
	});

	afterEach(() => {
		console.log = origLog;
		rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	/** Read the live emergency_stop row (deleted = 0) straight from the DB. */
	function liveStopRow(): { value: string } | null {
		const db = new Database(dbPath, { readonly: true });
		try {
			return db
				.query("SELECT value FROM cluster_config WHERE key = 'emergency_stop' AND deleted = 0")
				.get() as { value: string } | null;
		} finally {
			db.close();
		}
	}

	it("sets the emergency_stop flag via the outbox", async () => {
		await runStop({ configDir });
		const row = liveStopRow();
		expect(row).not.toBeNull();
		expect(typeof row?.value).toBe("string");
		expect(logs.join("\n")).toContain("Emergency stop set");
	});

	it("re-setting after a clear un-tombstones the row rather than colliding", async () => {
		await runStop({ configDir });
		await runResume({ configDir });
		expect(liveStopRow()).toBeNull();
		// Second stop must UPDATE the soft-deleted row, not INSERT a PK collision.
		await runStop({ configDir });
		expect(liveStopRow()).not.toBeNull();
	});

	it("resume soft-deletes the flag (tombstone), clearing the live read", async () => {
		await runStop({ configDir });
		await runResume({ configDir });
		expect(liveStopRow()).toBeNull();
		expect(logs.join("\n")).toContain("Emergency stop cleared");

		// The physical row survives as a tombstone (invariant #2: soft deletes).
		const db = new Database(dbPath, { readonly: true });
		try {
			const tomb = db
				.query("SELECT deleted FROM cluster_config WHERE key = 'emergency_stop'")
				.get() as { deleted: number } | null;
			expect(tomb?.deleted).toBe(1);
		} finally {
			db.close();
		}
	});

	it("resume is a no-op when the flag was never set", async () => {
		await runResume({ configDir });
		expect(liveStopRow()).toBeNull();
		expect(logs.join("\n")).toContain("Emergency stop cleared");
	});

	it("throws when the DB has no site_id", async () => {
		// Fresh DB with schema but no host_meta site_id → getSiteId returns
		// "unknown" → the command refuses.
		const db = new Database(dbPath);
		db.query("DELETE FROM host_meta WHERE key = 'site_id'").run();
		db.close();
		await expect(runStop({ configDir })).rejects.toThrow(/site_id/);
		await expect(runResume({ configDir })).rejects.toThrow(/site_id/);
	});
});
