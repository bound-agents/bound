import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createCoreTestDb } from "../../__tests__/test-database";
import { insertRow, softDelete } from "../../index";
import { listRemoteClientToolsForThreads } from "../client-sessions";

const LOCAL = "site-local";
const REMOTE = "site-remote";
const NOW = Date.parse("2026-11-25T04:00:00.000Z");
const FRESH = new Date(NOW - 60_000).toISOString();
const STALE = new Date(NOW - 10 * 60_000).toISOString();

let db: Database;

function seedHost(siteId: string, modifiedAt: string): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: siteId,
			host_name: siteId,
			online_at: modifiedAt,
			modified_at: modifiedAt,
			work_spool_capable: 0,
			deleted: 0,
		},
		siteId,
	);
}

function seedSession(id: string, threadId: string, siteId: string, tools: string | null): void {
	insertRow(
		db,
		"client_sessions",
		{
			id,
			connection_id: id,
			thread_id: threadId,
			site_id: siteId,
			client_tools: tools,
			created_at: FRESH,
			deleted: 0,
			modified_at: FRESH,
		},
		siteId,
	);
}

beforeEach(() => {
	db = createCoreTestDb({ metrics: true });
});

afterEach(() => {
	db.close();
});

describe("listRemoteClientToolsForThreads", () => {
	it("returns tools from a live session on a fresh remote host", () => {
		seedHost(REMOTE, FRESH);
		seedSession("s1", "t1", REMOTE, '[{"x":1}]');
		expect(listRemoteClientToolsForThreads(db, ["t1"], LOCAL, undefined, NOW)).toEqual([
			'[{"x":1}]',
		]);
	});

	it("resolves through the parent thread candidate", () => {
		seedHost(REMOTE, FRESH);
		seedSession("s1", "parent", REMOTE, "[]");
		expect(listRemoteClientToolsForThreads(db, ["child", "parent"], LOCAL, undefined, NOW)).toEqual(
			["[]"],
		);
	});

	it("excludes deleted sessions, stale hosts, local sessions, and tool-less rows", () => {
		seedHost(REMOTE, FRESH);
		seedHost("site-stale", STALE);
		seedHost(LOCAL, FRESH);
		seedSession("deleted", "t1", REMOTE, "[1]");
		softDelete(db, "client_sessions", "deleted", REMOTE);
		seedSession("stale", "t1", "site-stale", "[2]");
		seedSession("local", "t1", LOCAL, "[3]");
		seedSession("empty", "t1", REMOTE, null);
		expect(listRemoteClientToolsForThreads(db, ["t1"], LOCAL, undefined, NOW)).toEqual([]);
	});
});

describe("client_sessions.client_tools migration", () => {
	it("adds the column to a pre-existing table", async () => {
		const { Database } = await import("bun:sqlite");
		const { applySchema } = await import("../../index");
		const legacy = new Database(":memory:");
		legacy.run(`CREATE TABLE client_sessions (
			id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, thread_id TEXT NOT NULL,
			site_id TEXT NOT NULL, created_at TEXT NOT NULL,
			deleted INTEGER NOT NULL DEFAULT 0, modified_at TEXT NOT NULL) STRICT`);
		applySchema(legacy);
		const cols = legacy.query("PRAGMA table_info(client_sessions)").all() as Array<{
			name: string;
		}>;
		expect(cols.map((c) => c.name)).toContain("client_tools");
		legacy.close();
	});

	it("is present on a fresh database", () => {
		const cols = db.query("PRAGMA table_info(client_sessions)").all() as Array<{ name: string }>;
		expect(cols.map((c) => c.name)).toContain("client_tools");
	});
});
