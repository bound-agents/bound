import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../../index";
import { listFileModificationNotices } from "../file-modification-notices";

const SITE = "site-test";
const TS = "2026-01-01T00:00:00.000Z";

/**
 * Seed a `_internal.file_thread.<path>` memory entry whose VALUE is the
 * modifying thread id. The finder LEFT-JOINs threads on `t.id = sm.value`.
 */
function seedFileNotice(
	db: Database,
	args: { id: string; path: string; threadId: string; modifiedAt: string; deleted?: boolean },
): void {
	insertRow(
		db,
		"semantic_memory",
		{
			id: args.id,
			key: `_internal.file_thread.${args.path}`,
			value: args.threadId,
			source: null,
			created_at: TS,
			modified_at: args.modifiedAt,
			last_accessed_at: null,
			deleted: 0,
		} as never,
		SITE,
	);
	if (args.deleted) {
		softDelete(db, "semantic_memory", args.id, SITE);
	}
}

function seedThread(
	db: Database,
	args: { id: string; title: string | null; hostOrigin: string; deleted?: boolean },
): void {
	insertRow(
		db,
		"threads",
		{
			id: args.id,
			user_id: "u1",
			interface: "web",
			host_origin: args.hostOrigin,
			color: 0,
			title: args.title,
			summary: null,
			summary_through: null,
			summary_model_id: null,
			extracted_through: null,
			created_at: TS,
			last_message_at: TS,
			modified_at: TS,
			deleted: 0,
		} as never,
		SITE,
	);
	if (args.deleted) {
		softDelete(db, "threads", args.id, SITE);
	}
}

function seedHost(
	db: Database,
	args: { siteId: string; hostName: string; deleted?: boolean },
): void {
	insertRow(
		db,
		"hosts",
		{
			site_id: args.siteId,
			host_name: args.hostName,
			version: null,
			sync_url: null,
			mcp_servers: null,
			mcp_tools: null,
			mcp_tool_annotations: null,
			mcp_capabilities: null,
			models: null,
			online_at: null,
			modified_at: TS,
			platforms: null,
		} as never,
		SITE,
	);
	if (args.deleted) {
		softDelete(db, "hosts", args.siteId, SITE);
	}
}

describe("listFileModificationNotices", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	const baseArgs = {
		currentThreadId: "current-thread",
		localSite: "",
		localHost: "",
		limit: 50,
	};

	it("resolves the full projection: key, thread_id, thread_title, host_origin, host_name", () => {
		seedHost(db, { siteId: "site-A", hostName: "alpha" });
		seedThread(db, { id: "thread-1", title: "Edited config", hostOrigin: "site-A" });
		seedFileNotice(db, {
			id: "mem-1",
			path: "/etc/config",
			threadId: "thread-1",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "_internal.file_thread./etc/config",
			thread_id: "thread-1",
			thread_title: "Edited config",
			host_origin: "site-A",
			host_name: "alpha",
		});
	});

	it("LEFT-JOIN null case: thread absent -> thread_title/host_origin/host_name all null", () => {
		// Memory points at a thread id that has no threads row at all.
		seedFileNotice(db, {
			id: "mem-orphan",
			path: "/orphan.txt",
			threadId: "thread-missing",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "_internal.file_thread./orphan.txt",
			thread_id: "thread-missing",
			thread_title: null,
			host_origin: null,
			host_name: null,
		});
	});

	it("LEFT-JOIN null case: thread present but no matching host -> host_name null, host_origin populated", () => {
		// Thread exists with a host_origin that has no hosts row.
		seedThread(db, { id: "thread-2", title: "Lonely thread", hostOrigin: "site-ghost" });
		seedFileNotice(db, {
			id: "mem-2",
			path: "/lonely.txt",
			threadId: "thread-2",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "_internal.file_thread./lonely.txt",
			thread_id: "thread-2",
			thread_title: "Lonely thread",
			host_origin: "site-ghost",
			host_name: null,
		});
	});

	it("excludes notices whose value equals the current thread id", () => {
		seedFileNotice(db, {
			id: "mem-self",
			path: "/self.txt",
			threadId: "current-thread",
			modifiedAt: TS,
		});
		seedFileNotice(db, {
			id: "mem-other",
			path: "/other.txt",
			threadId: "thread-other",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows.map((r) => r.key)).toEqual(["_internal.file_thread./other.txt"]);
	});

	it("excludes soft-deleted semantic_memory rows", () => {
		seedFileNotice(db, {
			id: "mem-live",
			path: "/live.txt",
			threadId: "thread-live",
			modifiedAt: TS,
		});
		seedFileNotice(db, {
			id: "mem-dead",
			path: "/dead.txt",
			threadId: "thread-dead",
			modifiedAt: TS,
			deleted: true,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows.map((r) => r.key)).toEqual(["_internal.file_thread./live.txt"]);
	});

	it("excludes soft-deleted hosts on the host JOIN (h.deleted = 0): host_name null", () => {
		// The host exists but is tombstoned. The JOIN condition filters deleted=0,
		// so host_name must come back null even though host_origin still resolves.
		seedHost(db, { siteId: "site-B", hostName: "beta", deleted: true });
		seedThread(db, { id: "thread-3", title: "Beta edit", hostOrigin: "site-B" });
		seedFileNotice(db, {
			id: "mem-3",
			path: "/beta.txt",
			threadId: "thread-3",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "_internal.file_thread./beta.txt",
			thread_id: "thread-3",
			thread_title: "Beta edit",
			host_origin: "site-B",
			host_name: null,
		});
	});

	it("does NOT match non file_thread keys", () => {
		// A regular memory entry that happens to be live but uses a different prefix.
		insertRow(
			db,
			"semantic_memory",
			{
				id: "mem-regular",
				key: "_standing.note",
				value: "thread-x",
				source: null,
				created_at: TS,
				modified_at: TS,
				last_accessed_at: null,
				deleted: 0,
			} as never,
			SITE,
		);
		seedFileNotice(db, {
			id: "mem-real",
			path: "/real.txt",
			threadId: "thread-real",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows.map((r) => r.key)).toEqual(["_internal.file_thread./real.txt"]);
	});

	it("orders local-host edits ahead of remote ones, then newest-first within each group", () => {
		// localSite resolves "site-local"; localHost resolves "localhost:3001".
		// Threads whose host_origin matches either go to group 0; others group 1.
		seedThread(db, { id: "t-remote-new", title: "remote new", hostOrigin: "site-remote" });
		seedThread(db, { id: "t-remote-old", title: "remote old", hostOrigin: "site-remote" });
		seedThread(db, { id: "t-local-new", title: "local new", hostOrigin: "site-local" });
		seedThread(db, { id: "t-local-old", title: "local old", hostOrigin: "localhost:3001" });

		// modified_at chosen so that, absent the local-first CASE, remote-new would
		// sort first. The CASE must override pure modified_at DESC.
		seedFileNotice(db, {
			id: "m-remote-new",
			path: "/r-new",
			threadId: "t-remote-new",
			modifiedAt: "2026-01-04T00:00:00.000Z",
		});
		seedFileNotice(db, {
			id: "m-remote-old",
			path: "/r-old",
			threadId: "t-remote-old",
			modifiedAt: "2026-01-03T00:00:00.000Z",
		});
		seedFileNotice(db, {
			id: "m-local-new",
			path: "/l-new",
			threadId: "t-local-new",
			modifiedAt: "2026-01-02T00:00:00.000Z",
		});
		seedFileNotice(db, {
			id: "m-local-old",
			path: "/l-old",
			threadId: "t-local-old",
			modifiedAt: "2026-01-01T00:00:00.000Z",
		});

		const rows = listFileModificationNotices(db, {
			currentThreadId: "current-thread",
			localSite: "site-local",
			localHost: "localhost:3001",
			limit: 50,
		});

		expect(rows.map((r) => r.thread_id)).toEqual([
			// group 0 (local), newest-first
			"t-local-new",
			"t-local-old",
			// group 1 (remote), newest-first
			"t-remote-new",
			"t-remote-old",
		]);
	});

	it("empty localSite/localHost: a real host_origin never equals '' so everything is remote (group 1)", () => {
		seedThread(db, { id: "t-a", title: "a", hostOrigin: "site-A" });
		seedThread(db, { id: "t-b", title: "b", hostOrigin: "site-B" });
		seedFileNotice(db, {
			id: "m-a",
			path: "/a",
			threadId: "t-a",
			modifiedAt: "2026-01-01T00:00:00.000Z",
		});
		seedFileNotice(db, {
			id: "m-b",
			path: "/b",
			threadId: "t-b",
			modifiedAt: "2026-01-02T00:00:00.000Z",
		});

		const rows = listFileModificationNotices(db, baseArgs);
		// All remote => pure modified_at DESC ordering.
		expect(rows.map((r) => r.thread_id)).toEqual(["t-b", "t-a"]);
	});

	it("caps the result set at `limit`, keeping the newest within ordering", () => {
		// Seed 5 remote notices; cap at 3. Newest three survive (modified_at DESC).
		for (let i = 1; i <= 5; i++) {
			const day = String(i).padStart(2, "0");
			seedThread(db, { id: `t-${i}`, title: `thread ${i}`, hostOrigin: "site-R" });
			seedFileNotice(db, {
				id: `m-${i}`,
				path: `/f${i}`,
				threadId: `t-${i}`,
				modifiedAt: `2026-01-${day}T00:00:00.000Z`,
			});
		}

		const rows = listFileModificationNotices(db, {
			currentThreadId: "current-thread",
			localSite: "",
			localHost: "",
			limit: 3,
		});
		expect(rows).toHaveLength(3);
		expect(rows.map((r) => r.thread_id)).toEqual(["t-5", "t-4", "t-3"]);
	});

	it("returns [] when there are no file_thread notices at all", () => {
		seedThread(db, { id: "t-none", title: "nothing edited", hostOrigin: "site-A" });

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toEqual([]);
	});

	it("a soft-deleted thread is still left-joined (no t.deleted=0 filter) and its fields surface", () => {
		// The finder does NOT filter threads on deleted=0 (only hosts). A tombstoned
		// thread still resolves its title/host_origin. Pin this behavior so a future
		// added thread-deleted filter would be caught.
		seedThread(db, {
			id: "t-tomb",
			title: "tombstoned thread",
			hostOrigin: "site-A",
			deleted: true,
		});
		seedHost(db, { siteId: "site-A", hostName: "alpha" });
		seedFileNotice(db, {
			id: "m-tomb",
			path: "/tomb.txt",
			threadId: "t-tomb",
			modifiedAt: TS,
		});

		const rows = listFileModificationNotices(db, baseArgs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			key: "_internal.file_thread./tomb.txt",
			thread_id: "t-tomb",
			thread_title: "tombstoned thread",
			host_origin: "site-A",
			host_name: "alpha",
		});
	});
});
