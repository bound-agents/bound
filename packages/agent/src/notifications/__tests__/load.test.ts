/**
 * Tests for `loadNotificationInputs` — the surface-gating flag
 * `includeResolvedAdvisories` introduced for #70 (strip resolved-advisory
 * operator-ack notifications from active-conversation contexts; preserve them
 * on the heartbeat surface).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadNotificationInputs } from "../load";

const SITE_ID = "site-test";

function seedDb(db: Database, nowMs: number): void {
	// Minimal table shape — only the columns the loader reads.
	db.run(`CREATE TABLE advisories (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		status TEXT NOT NULL,
		created_by TEXT,
		resolved_at TEXT,
		deleted INTEGER NOT NULL DEFAULT 0
	)`);

	const recent = new Date(nowMs - 60 * 60 * 1000).toISOString(); // 1h ago
	db.run(
		"INSERT INTO advisories (id, title, status, created_by, resolved_at, deleted) VALUES (?, ?, 'dismissed', ?, ?, 0)",
		["a1", "Task has failed 3 times consecutively", SITE_ID, recent],
	);
}

describe("loadNotificationInputs surface gating (#70)", () => {
	let db: Database;
	const NOW = Date.parse("2026-05-30T20:00:00.000Z");

	beforeEach(() => {
		db = new Database(":memory:");
		seedDb(db, NOW);
	});

	afterEach(() => {
		db.close();
	});

	it("loads resolved advisories by default (back-compat: no flags)", () => {
		const out = loadNotificationInputs({ db, siteId: SITE_ID, nowMs: NOW });
		expect(out.resolvedAdvisories.map((a) => a.title)).toEqual([
			"Task has failed 3 times consecutively",
		]);
	});

	it("active-conversation surface: includeResolvedAdvisories=false strips advisory acks", () => {
		const out = loadNotificationInputs({
			db,
			siteId: SITE_ID,
			nowMs: NOW,
			includeResolvedAdvisories: false,
		});
		expect(out.resolvedAdvisories).toEqual([]);
	});

	it("heartbeat surface: includeResolvedAdvisories=true keeps advisory acks", () => {
		const out = loadNotificationInputs({
			db,
			siteId: SITE_ID,
			nowMs: NOW,
			includeResolvedAdvisories: true,
		});
		expect(out.resolvedAdvisories.map((a) => a.title)).toEqual([
			"Task has failed 3 times consecutively",
		]);
	});
});
