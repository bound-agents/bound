import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientSession, Host, Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { listClientSessionsWithHost } from "../client-sessions-with-host";

const SITE = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/**
 * Build a fully-populated `client_sessions` row. `id` is `${connection_id}::${thread_id}`
 * per the synced-table convention, though the finder keys off `thread_id`/`site_id`.
 */
function makeSession(overrides: Partial<ClientSession> & { thread_id: string }): ClientSession {
	const connectionId = overrides.connection_id ?? "conn-1";
	return {
		id: overrides.id ?? `${connectionId}::${overrides.thread_id}`,
		connection_id: connectionId,
		thread_id: overrides.thread_id,
		site_id: overrides.site_id ?? SITE,
		created_at: overrides.created_at ?? TS,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? TS,
	};
}

/**
 * Build a `hosts` row. The runtime schema carries `deleted` / `commit_hash`
 * columns that the `Host` TS type omits; we seed `deleted` explicitly because
 * the finder JOINs on `h.deleted = 0`.
 */
function makeHost(overrides: Partial<Host> & { site_id: string }): Host {
	return {
		site_id: overrides.site_id,
		host_name: overrides.host_name ?? "host-default",
		version: overrides.version ?? null,
		sync_url: overrides.sync_url ?? null,
		mcp_servers: overrides.mcp_servers ?? null,
		mcp_tools: overrides.mcp_tools ?? null,
		mcp_tool_annotations: overrides.mcp_tool_annotations ?? null,
		mcp_capabilities: overrides.mcp_capabilities ?? null,
		models: overrides.models ?? null,
		online_at: overrides.online_at ?? null,
		modified_at: overrides.modified_at ?? TS,
		platforms: overrides.platforms ?? null,
		// `deleted` is a real schema column even though the Host type omits it.
		...({ deleted: (overrides as { deleted?: number }).deleted ?? 0 } as object),
	};
}

/**
 * Build a `threads` row. The runtime schema has NO `model_hint` column (the TS
 * type declares one), so we never seed it — `insertRow` writes every key it is
 * given and would fail against the real schema otherwise.
 */
function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
	return {
		id: overrides.id,
		user_id: overrides.user_id ?? "user-1",
		interface: overrides.interface ?? "boundless",
		host_origin: overrides.host_origin ?? SITE,
		color: overrides.color ?? 0,
		title: overrides.title ?? null,
		summary: overrides.summary ?? null,
		summary_through: overrides.summary_through ?? null,
		summary_model_id: overrides.summary_model_id ?? null,
		extracted_through: overrides.extracted_through ?? null,
		created_at: overrides.created_at ?? TS,
		last_message_at: overrides.last_message_at ?? TS,
		modified_at: overrides.modified_at ?? TS,
		deleted: overrides.deleted ?? 0,
	} as Thread;
}

describe("listClientSessionsWithHost", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("returns [] when there are no client sessions", () => {
		expect(listClientSessionsWithHost(db)).toEqual([]);
	});

	it("joins a session to its host (name + heartbeats) and held thread (interface)", () => {
		insertRow(
			db,
			"hosts",
			makeHost({ site_id: SITE, host_name: "laptop", online_at: "2026-01-02T10:00:00.000Z" }),
			SITE,
		);
		insertRow(db, "threads", makeThread({ id: "thread-a", interface: "discord" }), SITE);
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-a" }), SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		// Assert the EXACT projection shape call sites destructure.
		expect(row.thread_id).toBe("thread-a");
		expect(row.site_id).toBe(SITE);
		expect(row.host_name).toBe("laptop");
		// modified_at on hosts is rewritten to wall-clock by updateRow; here it
		// comes straight from the insert, so it equals our fixed timestamp.
		expect(row.modified_at).toBe(TS);
		expect(row.online_at).toBe("2026-01-02T10:00:00.000Z");
		expect(row.interface).toBe("discord");
		// The projection has exactly these six keys.
		expect(Object.keys(row).sort()).toEqual(
			["host_name", "interface", "modified_at", "online_at", "site_id", "thread_id"].sort(),
		);
	});

	it("LEFT JOIN: session with no matching host yields null host columns but keeps thread interface", () => {
		// No hosts row for SITE at all.
		insertRow(db, "threads", makeThread({ id: "thread-b", interface: "web" }), SITE);
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-b" }), SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.thread_id).toBe("thread-b");
		expect(row.site_id).toBe(SITE);
		expect(row.host_name).toBeNull();
		expect(row.modified_at).toBeNull();
		expect(row.online_at).toBeNull();
		// Thread side still matched.
		expect(row.interface).toBe("web");
	});

	it("LEFT JOIN: session whose held thread is absent yields null interface but keeps host columns", () => {
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "vm" }), SITE);
		// No threads row for thread-c.
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-c" }), SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.thread_id).toBe("thread-c");
		expect(row.host_name).toBe("vm");
		expect(row.interface).toBeNull();
	});

	it("LEFT JOIN: session with neither host nor thread yields both sides null", () => {
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-d" }), SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.thread_id).toBe("thread-d");
		expect(row.host_name).toBeNull();
		expect(row.modified_at).toBeNull();
		expect(row.online_at).toBeNull();
		expect(row.interface).toBeNull();
	});

	it("excludes soft-deleted client sessions (WHERE cs.deleted = 0)", () => {
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "laptop" }), SITE);
		insertRow(db, "threads", makeThread({ id: "thread-live" }), SITE);
		insertRow(db, "threads", makeThread({ id: "thread-dead" }), SITE);

		const live = makeSession({ thread_id: "thread-live", connection_id: "conn-live" });
		const dead = makeSession({ thread_id: "thread-dead", connection_id: "conn-dead" });
		insertRow(db, "client_sessions", live, SITE);
		insertRow(db, "client_sessions", dead, SITE);
		softDelete(db, "client_sessions", dead.id, SITE);

		const rows = listClientSessionsWithHost(db);
		// Only the live session survives.
		expect(rows.map((r) => r.thread_id)).toEqual(["thread-live"]);
	});

	it("treats a soft-deleted HOST as unknown: host columns come back null (JOIN h.deleted = 0)", () => {
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "doomed" }), SITE);
		insertRow(db, "threads", makeThread({ id: "thread-e", interface: "discord" }), SITE);
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-e" }), SITE);

		softDelete(db, "hosts", SITE, SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		// Session itself is still present; only the host JOIN drops out.
		expect(row.thread_id).toBe("thread-e");
		expect(row.host_name).toBeNull();
		expect(row.modified_at).toBeNull();
		expect(row.online_at).toBeNull();
		// Thread side untouched.
		expect(row.interface).toBe("discord");
	});

	it("treats a soft-deleted THREAD as unknown: interface comes back null (JOIN t.deleted = 0)", () => {
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "laptop" }), SITE);
		insertRow(db, "threads", makeThread({ id: "thread-f", interface: "web" }), SITE);
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-f" }), SITE);

		softDelete(db, "threads", "thread-f", SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.thread_id).toBe("thread-f");
		// Host side untouched.
		expect(row.host_name).toBe("laptop");
		// Thread JOIN drops out.
		expect(row.interface).toBeNull();
	});

	it("returns one row per live session, joining each to its own host and thread", () => {
		insertRow(db, "hosts", makeHost({ site_id: "site-x", host_name: "host-x" }), "site-x");
		insertRow(db, "hosts", makeHost({ site_id: "site-y", host_name: "host-y" }), "site-y");
		insertRow(db, "threads", makeThread({ id: "t1", interface: "discord" }), SITE);
		insertRow(db, "threads", makeThread({ id: "t2", interface: "web" }), SITE);

		insertRow(
			db,
			"client_sessions",
			makeSession({ thread_id: "t1", site_id: "site-x", connection_id: "c1" }),
			"site-x",
		);
		insertRow(
			db,
			"client_sessions",
			makeSession({ thread_id: "t2", site_id: "site-y", connection_id: "c2" }),
			"site-y",
		);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(2);
		// Hand-written expected map of thread_id -> (host_name, interface, site_id).
		const byThread = new Map(rows.map((r) => [r.thread_id, r]));
		expect(byThread.get("t1")?.site_id).toBe("site-x");
		expect(byThread.get("t1")?.host_name).toBe("host-x");
		expect(byThread.get("t1")?.interface).toBe("discord");
		expect(byThread.get("t2")?.site_id).toBe("site-y");
		expect(byThread.get("t2")?.host_name).toBe("host-y");
		expect(byThread.get("t2")?.interface).toBe("web");
	});

	it("emits one row per (connection,thread) session even when several share one thread", () => {
		// Two distinct connections subscribed to the same thread on the same host.
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "laptop" }), SITE);
		insertRow(db, "threads", makeThread({ id: "shared", interface: "boundless" }), SITE);
		insertRow(
			db,
			"client_sessions",
			makeSession({ thread_id: "shared", connection_id: "conn-a" }),
			SITE,
		);
		insertRow(
			db,
			"client_sessions",
			makeSession({ thread_id: "shared", connection_id: "conn-b" }),
			SITE,
		);

		const rows = listClientSessionsWithHost(db);
		// The finder does NOT dedup (the caller does) — both rows are returned.
		expect(rows.length).toBe(2);
		expect(rows.every((r) => r.thread_id === "shared")).toBe(true);
		expect(rows.every((r) => r.host_name === "laptop")).toBe(true);
		expect(rows.every((r) => r.interface === "boundless")).toBe(true);
	});

	it("reflects a host heartbeat update (modified_at advances past the fixed insert timestamp)", () => {
		insertRow(db, "hosts", makeHost({ site_id: SITE, host_name: "laptop" }), SITE);
		insertRow(db, "threads", makeThread({ id: "thread-h" }), SITE);
		insertRow(db, "client_sessions", makeSession({ thread_id: "thread-h" }), SITE);

		// A heartbeat: updateRow rewrites modified_at to wall-clock.
		updateRow(db, "hosts", SITE, { online_at: "2026-02-02T02:02:02.000Z" }, SITE);

		const rows = listClientSessionsWithHost(db);
		expect(rows.length).toBe(1);
		const row = rows[0];
		expect(row.online_at).toBe("2026-02-02T02:02:02.000Z");
		// modified_at is no longer the seed timestamp — it advanced on the update.
		expect(row.modified_at).not.toBe(TS);
		expect(typeof row.modified_at).toBe("string");
	});
});
