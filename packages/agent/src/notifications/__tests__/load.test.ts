/**
 * Tests for `loadNotificationInputs` — specifically the surface-gating flags
 * `includeRetiredSkills` / `includeResolvedAdvisories` introduced for #70
 * (strip resolved-advisory operator-ack notifications from active-conversation
 * contexts; preserve them on the heartbeat surface).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadNotificationInputs } from "../load";

const SITE_ID = "site-test";

function seedDb(db: Database, nowMs: number): void {
	// Minimal table shapes — only the columns the loader reads.
	db.run(`CREATE TABLE skills (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT NOT NULL,
		retired_by TEXT,
		retired_reason TEXT,
		modified_at TEXT NOT NULL,
		deleted INTEGER NOT NULL DEFAULT 0
	)`);
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
		"INSERT INTO skills (id, name, status, retired_by, retired_reason, modified_at, deleted) VALUES (?, ?, 'retired', 'operator', ?, ?, 0)",
		["s1", "old-skill", "superseded", recent],
	);
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

	it("loads both kinds by default (back-compat: no flags)", () => {
		const out = loadNotificationInputs({ db, siteId: SITE_ID, nowMs: NOW });
		expect(out.retiredSkills.map((s) => s.name)).toEqual(["old-skill"]);
		expect(out.resolvedAdvisories.map((a) => a.title)).toEqual([
			"Task has failed 3 times consecutively",
		]);
	});

	it("active-conversation surface: includeResolvedAdvisories=false strips advisory acks but keeps skill retirements", () => {
		const out = loadNotificationInputs({
			db,
			siteId: SITE_ID,
			nowMs: NOW,
			includeResolvedAdvisories: false,
		});
		expect(out.retiredSkills.map((s) => s.name)).toEqual(["old-skill"]);
		expect(out.resolvedAdvisories).toEqual([]);
	});

	it("heartbeat surface: includeRetiredSkills=false keeps advisory acks but drops skill retirements", () => {
		const out = loadNotificationInputs({
			db,
			siteId: SITE_ID,
			nowMs: NOW,
			includeRetiredSkills: false,
			includeResolvedAdvisories: true,
		});
		expect(out.retiredSkills).toEqual([]);
		expect(out.resolvedAdvisories.map((a) => a.title)).toEqual([
			"Task has failed 3 times consecutively",
		]);
	});

	it("both gates false yields empty inputs without touching the DB rows", () => {
		const out = loadNotificationInputs({
			db,
			siteId: SITE_ID,
			nowMs: NOW,
			includeRetiredSkills: false,
			includeResolvedAdvisories: false,
		});
		expect(out.retiredSkills).toEqual([]);
		expect(out.resolvedAdvisories).toEqual([]);
	});
});
