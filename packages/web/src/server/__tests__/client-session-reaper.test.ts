import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applySchema, createDatabase } from "@bound/core";
import { reapStaleClientSessions } from "../client-session-reaper";

const SITE_ID = "site-local";
const OTHER_SITE = "site-remote";

function makeDb(): Database {
	const db = createDatabase(":memory:");
	applySchema(db);
	return db;
}

function seedSession(db: Database, connectionId: string, threadId: string, siteId: string): void {
	const id = `${connectionId}::${threadId}`;
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO client_sessions (id, connection_id, thread_id, site_id, created_at, modified_at, deleted)
		 VALUES (?, ?, ?, ?, ?, ?, 0)`,
		[id, connectionId, threadId, siteId, now, now],
	);
}

function undeletedCount(db: Database, siteId?: string): number {
	const clause = siteId ? "AND site_id = ?" : "";
	const params = siteId ? [siteId] : [];
	return (
		db
			.query(`SELECT COUNT(*) as c FROM client_sessions WHERE deleted = 0 ${clause}`)
			.get(...params) as { c: number }
	).c;
}

describe("reapStaleClientSessions", () => {
	let db: Database;

	beforeEach(() => {
		db = makeDb();
	});
	afterEach(() => {
		db.close();
	});

	it("soft-deletes local sessions whose connection is no longer live", () => {
		seedSession(db, "conn-alive", "thread-a", SITE_ID);
		seedSession(db, "conn-dead", "thread-b", SITE_ID);

		const reaped = reapStaleClientSessions(db, SITE_ID, new Set(["conn-alive"]));

		expect(reaped).toHaveLength(1);
		expect(reaped[0]).toContain("conn-dead");
		expect(undeletedCount(db, SITE_ID)).toBe(1);
	});

	it("leaves live sessions untouched", () => {
		seedSession(db, "conn-alive", "thread-a", SITE_ID);

		reapStaleClientSessions(db, SITE_ID, new Set(["conn-alive"]));

		expect(undeletedCount(db, SITE_ID)).toBe(1);
	});

	it("does not touch sessions from other hosts", () => {
		seedSession(db, "conn-remote-dead", "thread-c", OTHER_SITE);

		const reaped = reapStaleClientSessions(db, SITE_ID, new Set());

		expect(reaped).toHaveLength(0);
		expect(undeletedCount(db, OTHER_SITE)).toBe(1);
	});

	it("reaps all local sessions when the live set is empty", () => {
		seedSession(db, "conn-a", "thread-a", SITE_ID);
		seedSession(db, "conn-b", "thread-b", SITE_ID);
		seedSession(db, "conn-c", "thread-c", SITE_ID);

		const reaped = reapStaleClientSessions(db, SITE_ID, new Set());

		expect(reaped).toHaveLength(3);
		expect(undeletedCount(db, SITE_ID)).toBe(0);
	});

	it("already-deleted rows are not double-counted", () => {
		seedSession(db, "conn-dead", "thread-a", SITE_ID);
		db.run(`UPDATE client_sessions SET deleted = 1 WHERE connection_id = 'conn-dead'`);

		const reaped = reapStaleClientSessions(db, SITE_ID, new Set());

		expect(reaped).toHaveLength(0);
	});
});
