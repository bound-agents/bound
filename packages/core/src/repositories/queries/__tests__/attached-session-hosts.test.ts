import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientSession, Host } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete, updateRow } from "../../../index";
import { getAttachedSessionHosts } from "../attached-session-hosts";

const SITE_ID = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/** Seed a client_sessions row. siteId controls the holding host. */
function seedSession(
	db: Database,
	overrides: Partial<ClientSession> & Pick<ClientSession, "id" | "thread_id" | "site_id">,
): void {
	const row: ClientSession = {
		id: overrides.id,
		connection_id: overrides.connection_id ?? `${overrides.id}-conn`,
		thread_id: overrides.thread_id,
		site_id: overrides.site_id,
		created_at: overrides.created_at ?? TS,
		deleted: overrides.deleted ?? 0,
		modified_at: overrides.modified_at ?? TS,
	};
	insertRow(db, "client_sessions", row, SITE_ID);
}

/**
 * Seed a hosts row. The `hosts` table carries a `deleted` column in the schema
 * even though the `Host` type omits it; the query filters `h.deleted = 0`, so we
 * thread a `deleted` value in via a cast.
 */
function seedHost(db: Database, siteId: string, hostName: string, deleted = 0): void {
	const row = {
		site_id: siteId,
		host_name: hostName,
		version: null,
		sync_url: null,
		mcp_servers: null,
		mcp_tools: null,
		mcp_tool_annotations: null,
		mcp_capabilities: null,
		models: null,
		overlay_root: null,
		online_at: null,
		modified_at: TS,
		platforms: null,
		deleted,
	} as Host & { deleted: number };
	insertRow(db, "hosts", row, SITE_ID);
}

describe("getAttachedSessionHosts", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	it("labels a session with its host's host_name when the host exists", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });

		const rows = getAttachedSessionHosts(db, "t1");
		expect(rows).toEqual([{ label: "alpha" }]);
	});

	it("LEFT-JOIN null case: falls back to site_id when no matching host row exists", () => {
		// Session points at host-orphan but no hosts row is seeded for it.
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-orphan" });

		const rows = getAttachedSessionHosts(db, "t1");
		// COALESCE(h.host_name, cs.site_id) => the raw site_id surfaces as the label.
		expect(rows).toEqual([{ label: "host-orphan" }]);
	});

	it("projection shape: only the `label` column is present and populated", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });

		const rows = getAttachedSessionHosts(db, "t1");
		expect(rows).toHaveLength(1);
		expect(Object.keys(rows[0])).toEqual(["label"]);
		expect(rows[0].label).toBe("alpha");
	});

	it("returns [] for a thread with no sessions", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });

		const rows = getAttachedSessionHosts(db, "no-such-thread");
		expect(rows).toEqual([]);
	});

	it("excludes soft-deleted sessions (cs.deleted = 0 filter)", () => {
		seedHost(db, "host-a", "alpha");
		seedHost(db, "host-b", "bravo");
		seedSession(db, { id: "s-live", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s-dead", thread_id: "t1", site_id: "host-b" });
		softDelete(db, "client_sessions", "s-dead", SITE_ID);

		const rows = getAttachedSessionHosts(db, "t1");
		// Only the live session's host survives; bravo's session is tombstoned.
		expect(rows).toEqual([{ label: "alpha" }]);
	});

	it("deleted host on the join side falls back to site_id, not host_name", () => {
		// host-a exists but is soft-deleted: the LEFT JOIN's `h.deleted = 0`
		// predicate makes the match fail, so COALESCE falls through to site_id.
		seedHost(db, "host-a", "alpha", 1);
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });

		const rows = getAttachedSessionHosts(db, "t1");
		expect(rows).toEqual([{ label: "host-a" }]);
	});

	it("groups by (site_id, label): multiple sessions on the same host yield one label", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s2", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s3", thread_id: "t1", site_id: "host-a" });

		const rows = getAttachedSessionHosts(db, "t1");
		expect(rows).toEqual([{ label: "alpha" }]);
	});

	it("returns distinct labels ordered label ASC across multiple hosts", () => {
		seedHost(db, "host-c", "charlie");
		seedHost(db, "host-a", "alpha");
		seedHost(db, "host-b", "bravo");
		// Insert sessions out of label order to prove ORDER BY label ASC sorts them.
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-c" });
		seedSession(db, { id: "s2", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s3", thread_id: "t1", site_id: "host-b" });

		const rows = getAttachedSessionHosts(db, "t1");
		expect(rows).toEqual([{ label: "alpha" }, { label: "bravo" }, { label: "charlie" }]);
	});

	it("scopes strictly to the requested thread", () => {
		seedHost(db, "host-a", "alpha");
		seedHost(db, "host-b", "bravo");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s2", thread_id: "t2", site_id: "host-b" });

		expect(getAttachedSessionHosts(db, "t1")).toEqual([{ label: "alpha" }]);
		expect(getAttachedSessionHosts(db, "t2")).toEqual([{ label: "bravo" }]);
	});

	it("mixed: one host-backed session and one orphan session on the same thread", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });
		seedSession(db, { id: "s2", thread_id: "t1", site_id: "zzz-orphan" });

		const rows = getAttachedSessionHosts(db, "t1");
		// "alpha" < "zzz-orphan" lexicographically.
		expect(rows).toEqual([{ label: "alpha" }, { label: "zzz-orphan" }]);
	});

	it("re-attaching a previously soft-deleted session re-includes its host", () => {
		seedHost(db, "host-a", "alpha");
		seedSession(db, { id: "s1", thread_id: "t1", site_id: "host-a" });
		softDelete(db, "client_sessions", "s1", SITE_ID);
		expect(getAttachedSessionHosts(db, "t1")).toEqual([]);

		// Restore via the outbox write path.
		updateRow(db, "client_sessions", "s1", { deleted: 0 }, SITE_ID);
		expect(getAttachedSessionHosts(db, "t1")).toEqual([{ label: "alpha" }]);
	});
});
