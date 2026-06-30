import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema, insertRow } from "@bound/core";
import {
	clientSessionWakeupWarning,
	getClientSessions,
	isClientSessionLive,
} from "../delegation.js";

// Test database setup
let db: Database;
let testDbPath: string;

beforeEach(() => {
	const testId = randomBytes(4).toString("hex");
	testDbPath = join(tmpdir(), `test-delegation-${testId}.db`);
	const sqlite3 = require("bun:sqlite");
	db = new sqlite3.Database(testDbPath);
	applySchema(db);
});

afterEach(() => {
	try {
		db.close();
	} catch {
		// Already closed
	}
	try {
		require("node:fs").unlinkSync(testDbPath);
	} catch {
		// Already deleted
	}
});

describe("getClientSessions and related tests", () => {
	const LOCAL = "local-site";
	const REMOTE = "remote-site";
	const THREAD = "thread-cs";

	function insertHost(siteId: string, ageMs: number): void {
		const ts = new Date(Date.now() - ageMs).toISOString();
		insertRow(
			db,
			"hosts",
			{
				site_id: siteId,
				host_name: siteId,
				sync_url: null,
				online_at: ts,
				modified_at: ts,
				deleted: 0,
			},
			"test-writer-site",
		);
	}

	function insertSession(connectionId: string, threadId: string, siteId: string): void {
		const now = new Date().toISOString();
		insertRow(
			db,
			"client_sessions",
			{
				id: `${connectionId}::${threadId}`,
				connection_id: connectionId,
				thread_id: threadId,
				site_id: siteId,
				created_at: now,
				deleted: 0,
				modified_at: now,
			},
			"test-writer-site",
		);
	}

	describe("isClientSessionLive", () => {
		it("is false when no session exists for the thread", () => {
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});

		it("is true when a session lives on a fresh host (local or remote)", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-local", THREAD, LOCAL);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
		});

		it("is true for a fresh remote-only session", () => {
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
		});

		it("is false when the only session host is stale/offline", () => {
			insertHost(REMOTE, 10 * 60 * 1000); // 10 min old — past the 5 min window
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});

		it("is true when at least one of several session hosts is fresh", () => {
			insertHost(LOCAL, 10 * 60 * 1000); // stale
			insertHost(REMOTE, 0); // fresh
			insertSession("conn-local", THREAD, LOCAL);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(isClientSessionLive(db, THREAD)).toBe(true);
		});

		it("ignores soft-deleted session rows", () => {
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
			expect(isClientSessionLive(db, THREAD)).toBe(false);
		});
	});

	describe("getClientSessions", () => {
		it("returns an empty array when there are no sessions", () => {
			expect(getClientSessions(db)).toEqual([]);
		});

		it("returns one entry per distinct (thread, host) with a live verdict", () => {
			insertHost(LOCAL, 0); // fresh
			insertHost(REMOTE, 10 * 60 * 1000); // stale
			insertSession("conn-local", THREAD, LOCAL);
			insertSession("conn-remote", "thread-other", REMOTE);

			const sessions = getClientSessions(db);
			expect(sessions).toHaveLength(2);
			const byThread = new Map(sessions.map((s) => [s.threadId, s]));
			expect(byThread.get(THREAD)).toMatchObject({ siteId: LOCAL, hostName: LOCAL, live: true });
			expect(byThread.get("thread-other")).toMatchObject({ siteId: REMOTE, live: false });
		});

		it("dedups multiple connections on the same host into one entry", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-a", THREAD, LOCAL);
			insertSession("conn-b", THREAD, LOCAL);
			expect(getClientSessions(db)).toHaveLength(1);
		});

		it("excludes soft-deleted sessions", () => {
			insertHost(LOCAL, 0);
			insertSession("conn-local", THREAD, LOCAL);
			db.run("UPDATE client_sessions SET deleted = 1 WHERE thread_id = ?", [THREAD]);
			expect(getClientSessions(db)).toEqual([]);
		});
	});

	describe("clientSessionWakeupWarning", () => {
		function insertThread(threadId: string, threadInterface: string): void {
			const now = new Date().toISOString();
			insertRow(
				db,
				"threads",
				{
					id: threadId,
					user_id: "u",
					interface: threadInterface,
					host_origin: "test-writer-site",
					created_at: now,
					last_message_at: now,
					modified_at: now,
					deleted: 0,
				},
				"test-writer-site",
			);
		}

		it("returns null for a non-existent thread", () => {
			expect(clientSessionWakeupWarning(db, "ghost")).toBeNull();
		});

		it("returns null for a non-client-tool interface (e.g. web), session or not", () => {
			insertThread(THREAD, "web");
			expect(clientSessionWakeupWarning(db, THREAD)).toBeNull();
		});

		it("returns null for a boundless thread WITH a live session", () => {
			insertThread(THREAD, "boundless");
			insertHost(REMOTE, 0);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(clientSessionWakeupWarning(db, THREAD)).toBeNull();
		});

		it("warns for a boundless thread with NO session", () => {
			insertThread(THREAD, "boundless");
			const warning = clientSessionWakeupWarning(db, THREAD);
			expect(warning).toContain("no live boundless session");
		});

		it("warns for a boundless thread whose only session is stale", () => {
			insertThread(THREAD, "boundless");
			insertHost(REMOTE, 10 * 60 * 1000);
			insertSession("conn-remote", THREAD, REMOTE);
			expect(clientSessionWakeupWarning(db, THREAD)).toContain("no live boundless session");
		});
	});
});
