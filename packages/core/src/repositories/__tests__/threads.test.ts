import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Thread } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	findLatestThreadColorExcludingInterfaces,
	findLiveThreadById,
	findLiveThreadIdById,
	findLiveThreadInterfaceById,
	findThreadAgentIdById,
	findThreadById,
	findThreadCreatedAtById,
	findThreadIdById,
	findThreadModelHintById,
	findThreadParentIdById,
	findThreadSummaryById,
	findThreadSummaryStateById,
	findThreadTitleById,
	findThreadUserAndInterfaceById,
	listLiveThreadIdsIdleBefore,
	listThreadsByUser,
} from "../threads";

const SITE_ID = "site-test";

function makeThread(overrides: Partial<Thread> = {}): Thread {
	return {
		id: "thread-1",
		user_id: "user-1",
		interface: "web",
		host_origin: "host-a",
		color: 0,
		title: null,
		summary: null,
		summary_through: null,
		summary_model_id: null,
		extracted_through: null,
		created_at: "2026-01-01T00:00:00.000Z",
		last_message_at: "2026-01-01T00:00:00.000Z",
		modified_at: "2026-01-01T00:00:00.000Z",
		deleted: 0,
		model_hint: null,
		...overrides,
	};
}

function seedThread(db: Database, overrides: Partial<Thread> = {}): Thread {
	const row = makeThread(overrides);
	insertRow(db, "threads", row, SITE_ID);
	return row;
}

describe("threads repository", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	// --- simple by-id finders: happy + miss ---

	describe("findThreadById", () => {
		it("returns the full row for a live thread", () => {
			seedThread(db, { id: "t-a", user_id: "u-1", title: "Hello" });
			const got = findThreadById(db, "t-a");
			expect(got).not.toBeNull();
			expect(got?.id).toBe("t-a");
			expect(got?.user_id).toBe("u-1");
			expect(got?.title).toBe("Hello");
		});

		it("returns a soft-deleted row too (no deleted filter)", () => {
			seedThread(db, { id: "t-del" });
			softDelete(db, "threads", "t-del", SITE_ID);
			const got = findThreadById(db, "t-del");
			expect(got).not.toBeNull();
			expect(got?.deleted).toBe(1);
		});

		it("returns null for an absent id", () => {
			expect(findThreadById(db, "missing")).toBeNull();
		});
	});

	describe("findThreadTitleById", () => {
		it("returns the title for an existing thread", () => {
			seedThread(db, { id: "t-title", title: "My Title" });
			expect(findThreadTitleById(db, "t-title")).toEqual({ title: "My Title" });
		});

		it("returns null for an absent id", () => {
			expect(findThreadTitleById(db, "nope")).toBeNull();
		});
	});

	describe("findThreadCreatedAtById", () => {
		it("returns created_at for an existing thread", () => {
			seedThread(db, { id: "t-cre", created_at: "2026-02-02T03:04:05.000Z" });
			expect(findThreadCreatedAtById(db, "t-cre")).toEqual({
				created_at: "2026-02-02T03:04:05.000Z",
			});
		});

		it("returns null for an absent id", () => {
			expect(findThreadCreatedAtById(db, "nope")).toBeNull();
		});
	});

	describe("findThreadModelHintById", () => {
		it("returns the model_hint value", () => {
			seedThread(db, { id: "t-mh", model_hint: "opus" });
			expect(findThreadModelHintById(db, "t-mh")).toEqual({ model_hint: "opus" });
		});

		it("returns a null model_hint when unset", () => {
			seedThread(db, { id: "t-mh-null", model_hint: null });
			expect(findThreadModelHintById(db, "t-mh-null")).toEqual({ model_hint: null });
		});

		it("returns null for an absent id", () => {
			expect(findThreadModelHintById(db, "nope")).toBeNull();
		});
	});

	describe("findThreadUserAndInterfaceById", () => {
		it("returns user_id and interface", () => {
			seedThread(db, { id: "t-ui", user_id: "u-9", interface: "discord" });
			expect(findThreadUserAndInterfaceById(db, "t-ui")).toEqual({
				user_id: "u-9",
				interface: "discord",
			});
		});

		it("ignores the deleted flag (returns soft-deleted row)", () => {
			seedThread(db, { id: "t-ui-del", user_id: "u-x", interface: "web" });
			softDelete(db, "threads", "t-ui-del", SITE_ID);
			expect(findThreadUserAndInterfaceById(db, "t-ui-del")).toEqual({
				user_id: "u-x",
				interface: "web",
			});
		});

		it("returns null for an absent id", () => {
			expect(findThreadUserAndInterfaceById(db, "nope")).toBeNull();
		});
	});

	describe("findThreadSummaryById", () => {
		it("returns the summary", () => {
			seedThread(db, { id: "t-sum", summary: "a recap" });
			expect(findThreadSummaryById(db, "t-sum")).toEqual({ summary: "a recap" });
		});

		it("returns null for an absent id", () => {
			expect(findThreadSummaryById(db, "nope")).toBeNull();
		});
	});

	describe("findThreadSummaryStateById", () => {
		it("returns summary and summary_through", () => {
			seedThread(db, {
				id: "t-ss",
				summary: "recap",
				summary_through: "2026-01-05T00:00:00.000Z",
			});
			expect(findThreadSummaryStateById(db, "t-ss")).toEqual({
				summary: "recap",
				summary_through: "2026-01-05T00:00:00.000Z",
				last_message_at: "2026-01-01T00:00:00.000Z",
			});
		});

		it("returns null for an absent id", () => {
			expect(findThreadSummaryStateById(db, "nope")).toBeNull();
		});
	});

	// --- deleted-filter OMISSION variants ---
	// The four (id-based) probes come in deleted-omission and live-only pairs.

	describe("deleted-filter omission: findThreadIdById vs findLiveThreadIdById", () => {
		it("findThreadIdById returns the tombstoned row; the live sibling does not", () => {
			seedThread(db, { id: "t-live" });
			seedThread(db, { id: "t-dead" });
			softDelete(db, "threads", "t-dead", SITE_ID);

			// omission finder: ignores deleted flag
			expect(findThreadIdById(db, "t-dead")).toEqual({ id: "t-dead" });
			expect(findThreadIdById(db, "t-live")).toEqual({ id: "t-live" });

			// live-only sibling: tombstone is invisible
			expect(findLiveThreadIdById(db, "t-dead")).toBeNull();
			expect(findLiveThreadIdById(db, "t-live")).toEqual({ id: "t-live" });
		});

		it("both return null for an absent id", () => {
			expect(findThreadIdById(db, "nope")).toBeNull();
			expect(findLiveThreadIdById(db, "nope")).toBeNull();
		});
	});

	describe("deleted-filter omission: findThreadById vs findLiveThreadById", () => {
		it("findLiveThreadById hides the tombstone while findThreadById surfaces it", () => {
			seedThread(db, { id: "t2-dead" });
			softDelete(db, "threads", "t2-dead", SITE_ID);

			expect(findThreadById(db, "t2-dead")?.deleted).toBe(1);
			expect(findLiveThreadById(db, "t2-dead")).toBeNull();
		});

		it("findLiveThreadById returns a live row", () => {
			seedThread(db, { id: "t2-live", title: "x" });
			expect(findLiveThreadById(db, "t2-live")?.id).toBe("t2-live");
		});
	});

	describe("findLiveThreadInterfaceById (live only)", () => {
		it("returns the interface for a live thread", () => {
			seedThread(db, { id: "t-if", interface: "scheduler" });
			expect(findLiveThreadInterfaceById(db, "t-if")).toEqual({ interface: "scheduler" });
		});

		it("returns null for a soft-deleted thread", () => {
			seedThread(db, { id: "t-if-del", interface: "web" });
			softDelete(db, "threads", "t-if-del", SITE_ID);
			expect(findLiveThreadInterfaceById(db, "t-if-del")).toBeNull();
		});

		it("returns null for an absent id", () => {
			expect(findLiveThreadInterfaceById(db, "nope")).toBeNull();
		});
	});

	// --- list finder with deleted=0 filter + ORDER BY last_message_at DESC ---

	describe("listThreadsByUser", () => {
		it("returns only live threads for the user, newest-message first", () => {
			seedThread(db, {
				id: "u1-old",
				user_id: "u-1",
				last_message_at: "2026-01-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "u1-new",
				user_id: "u-1",
				last_message_at: "2026-03-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "u1-mid",
				user_id: "u-1",
				last_message_at: "2026-02-01T00:00:00.000Z",
			});
			// other user — must be excluded
			seedThread(db, { id: "u2-only", user_id: "u-2" });
			// soft-deleted for u-1 — must be excluded
			seedThread(db, { id: "u1-dead", user_id: "u-1" });
			softDelete(db, "threads", "u1-dead", SITE_ID);

			const rows = listThreadsByUser(db, "u-1");
			expect(rows.map((r) => r.id)).toEqual(["u1-new", "u1-mid", "u1-old"]);
		});

		it("returns [] when the user has no threads", () => {
			seedThread(db, { id: "x", user_id: "someone-else" });
			expect(listThreadsByUser(db, "nobody")).toEqual([]);
		});
	});

	// --- listLiveThreadIdsIdleBefore: strict < cutoff, deleted=0 ---

	describe("listLiveThreadIdsIdleBefore", () => {
		it("returns live thread ids strictly older than the cutoff", () => {
			seedThread(db, { id: "idle-a", last_message_at: "2026-01-01T00:00:00.000Z" });
			seedThread(db, { id: "idle-b", last_message_at: "2026-01-02T00:00:00.000Z" });
			// equal to cutoff — excluded by strict <
			seedThread(db, { id: "boundary", last_message_at: "2026-01-03T00:00:00.000Z" });
			// after cutoff — excluded
			seedThread(db, { id: "fresh", last_message_at: "2026-01-04T00:00:00.000Z" });
			// soft-deleted but old — excluded by deleted=0
			seedThread(db, { id: "old-dead", last_message_at: "2026-01-01T00:00:00.000Z" });
			softDelete(db, "threads", "old-dead", SITE_ID);

			const ids = listLiveThreadIdsIdleBefore(db, "2026-01-03T00:00:00.000Z")
				.map((r) => r.id)
				.sort();
			expect(ids).toEqual(["idle-a", "idle-b"]);
		});

		it("returns [] when nothing is idle before the cutoff", () => {
			seedThread(db, { id: "recent", last_message_at: "2026-05-01T00:00:00.000Z" });
			expect(listLiveThreadIdsIdleBefore(db, "2026-01-01T00:00:00.000Z")).toEqual([]);
		});
	});

	// --- findLatestThreadColorExcludingInterfaces: dynamic NOT IN + ORDER BY + LIMIT 1 ---

	describe("findLatestThreadColorExcludingInterfaces", () => {
		it("returns the color of the most-recently-created live, non-excluded thread", () => {
			seedThread(db, {
				id: "c-old",
				interface: "web",
				color: 1,
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "c-new",
				interface: "web",
				color: 2,
				created_at: "2026-03-01T00:00:00.000Z",
			});
			// newest overall but on an excluded interface — must be skipped
			seedThread(db, {
				id: "c-sched",
				interface: "scheduler",
				color: 99,
				created_at: "2026-04-01T00:00:00.000Z",
			});
			expect(findLatestThreadColorExcludingInterfaces(db, ["scheduler", "webhook"])).toEqual({
				color: 2,
			});
		});

		it("excludes soft-deleted threads even on allowed interfaces", () => {
			seedThread(db, {
				id: "c-livecolor",
				interface: "web",
				color: 5,
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "c-deadcolor",
				interface: "web",
				color: 7,
				created_at: "2026-09-01T00:00:00.000Z",
			});
			softDelete(db, "threads", "c-deadcolor", SITE_ID);
			expect(findLatestThreadColorExcludingInterfaces(db, ["scheduler"])).toEqual({ color: 5 });
		});

		it("empty exclusion list matches all live threads (NOT IN () must not match-all to empty)", () => {
			seedThread(db, {
				id: "e-old",
				interface: "web",
				color: 3,
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "e-new",
				interface: "scheduler",
				color: 4,
				created_at: "2026-02-01T00:00:00.000Z",
			});
			// With no exclusions, the newest live thread wins regardless of interface.
			expect(findLatestThreadColorExcludingInterfaces(db, [])).toEqual({ color: 4 });
		});

		it("single-element exclusion list", () => {
			seedThread(db, {
				id: "s-keep",
				interface: "web",
				color: 8,
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seedThread(db, {
				id: "s-drop",
				interface: "webhook",
				color: 9,
				created_at: "2026-02-01T00:00:00.000Z",
			});
			expect(findLatestThreadColorExcludingInterfaces(db, ["webhook"])).toEqual({ color: 8 });
		});

		it("returns null when no live, non-excluded thread exists", () => {
			seedThread(db, { id: "only-excluded", interface: "scheduler", color: 1 });
			expect(findLatestThreadColorExcludingInterfaces(db, ["scheduler"])).toBeNull();
		});

		it("returns null on an empty table", () => {
			expect(findLatestThreadColorExcludingInterfaces(db, ["scheduler"])).toBeNull();
		});
	});
	// #201 — the aux ancestry link. The WS layer walks it to route a client tool
	// called from an aux thread to the DISPATCHING thread's session, since nothing
	// ever subscribes to an aux thread.
	describe("findThreadParentIdById", () => {
		it("returns the parent id for a child (aux) thread", () => {
			seedThread(db, { id: "parent" });
			seedThread(db, { id: "child", parent_thread_id: "parent", interface: "aux" });
			expect(findThreadParentIdById(db, "child")).toEqual({ parent_thread_id: "parent" });
		});

		// Ordinary threads must resolve to a null parent so the WS fallback is a
		// no-op for every non-child thread rather than widening delivery.
		it("returns a null parent for an ordinary thread", () => {
			seedThread(db, { id: "solo" });
			expect(findThreadParentIdById(db, "solo")).toEqual({ parent_thread_id: null });
		});

		it("returns null for an unknown thread", () => {
			expect(findThreadParentIdById(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted thread", () => {
			seedThread(db, { id: "gone", parent_thread_id: "parent" });
			softDelete(db, "threads", "gone", SITE_ID);
			expect(findThreadParentIdById(db, "gone")).toBeNull();
		});
	});
	// #201 — the aux-thread discriminator. The generic dispatcher consults this to
	// refuse claiming an aux thread: it builds a MainAgentLoop, which on an aux
	// thread would drop the persona, the agent_id memory scoping, and the
	// EXCLUDED_TOOLS capability boundary.
	describe("findThreadAgentIdById", () => {
		it("returns the owning identity for an aux thread", () => {
			seedThread(db, { id: "aux-1", interface: "aux", agent_id: "agent-abc" });
			expect(findThreadAgentIdById(db, "aux-1")).toEqual({ agent_id: "agent-abc" });
		});

		// Main-agent threads must report null so the dispatcher keeps serving them.
		it("returns a null agent_id for a main-agent thread", () => {
			seedThread(db, { id: "main-1" });
			expect(findThreadAgentIdById(db, "main-1")).toEqual({ agent_id: null });
		});

		// Keyed on agent_id, never the interface tag — `interface` is descriptive
		// only, so an aux-tagged thread without an identity is still dispatchable.
		it("does not infer an identity from the interface tag alone", () => {
			seedThread(db, { id: "tagged-only", interface: "aux" });
			expect(findThreadAgentIdById(db, "tagged-only")).toEqual({ agent_id: null });
		});

		it("returns null for an unknown thread", () => {
			expect(findThreadAgentIdById(db, "nope")).toBeNull();
		});

		it("returns null for a soft-deleted thread", () => {
			seedThread(db, { id: "gone", agent_id: "agent-abc" });
			softDelete(db, "threads", "gone", SITE_ID);
			expect(findThreadAgentIdById(db, "gone")).toBeNull();
		});
	});
});
