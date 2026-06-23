import Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { applyMetricsSchema, applySchema, insertRow, softDelete } from "../../index";
import {
	countAssistantMessages,
	countLiveAssistantMessagesByThread,
	countLiveMessagesByThread,
	countMessagesByThread,
	findFirstLiveUserMessageByThreadSince,
	findFirstMessageContentByThreadAndRole,
	findLatestAssistantMessageContent,
	findLatestLiveAssistantMessageCreatedAtByThread,
	findLatestLiveAssistantMessageIdByThreadSince,
	findLatestLiveMessageCreatedAtByThread,
	findLatestLiveUserMessageCreatedAtByThread,
	findLiveMessageByIdAndThread,
	findMessageById,
	findMessageMetadataById,
	findMessageRoleById,
	findPairedToolResultId,
	listDistinctToolNamesByThread,
	listLiveAssistantMessagesWithMetadataByThreadSince,
	listLiveDeveloperMessageMetadataByThreadSince,
	listLiveMessageDeltaByThreadSince,
	listLiveMessageProjectionByThreadNewestFirst,
	listLiveMessageProjectionByThreadSince,
	listLiveMessagesByThreadNewestFirst,
	listLiveToolCallContentByThread,
	listMessageHostOriginCountsSince,
	listMessageIdRoleByIds,
	listMessageIdsByThreadNewestFirst,
	listMessageRoleContentByThreadSince,
	listMessagesByThread,
	listRecentLiveMessageContentByThread,
	listToolNameCountsByThread,
} from "../messages";

const SITE = "site-A";
const THREAD = "thread-1";
const OTHER_THREAD = "thread-2";

/** Build a fully-populated messages row; override what the test cares about. */
function makeMessage(overrides: Partial<Message> & { id: string }): Message {
	return {
		id: overrides.id,
		thread_id: THREAD,
		role: "user",
		content: "hello",
		model_id: null,
		tool_name: null,
		created_at: "2026-01-01T00:00:00.000Z",
		modified_at: null,
		host_origin: "host-a",
		deleted: 0,
		exit_code: null,
		metadata: null,
		...overrides,
	};
}

function seed(db: Database, overrides: Partial<Message> & { id: string }): void {
	insertRow(db, "messages", makeMessage(overrides), SITE);
}

describe("messages repository finders", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		applySchema(db);
		applyMetricsSchema(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("findMessageById (by-id; ignores deleted)", () => {
		it("happy: returns the row including soft-deleted ones", () => {
			seed(db, { id: "m1", content: "the body" });
			const row = findMessageById(db, "m1");
			expect(row).not.toBeNull();
			expect(row?.id).toBe("m1");
			expect(row?.content).toBe("the body");
		});

		it("returns a soft-deleted row too (no deleted filter)", () => {
			seed(db, { id: "m1" });
			softDelete(db, "messages", "m1", SITE);
			const row = findMessageById(db, "m1");
			expect(row).not.toBeNull();
			expect(row?.deleted).toBe(1);
		});

		it("miss: returns null for an absent id", () => {
			expect(findMessageById(db, "nope")).toBeNull();
		});
	});

	describe("findLiveMessageByIdAndThread (deleted=0)", () => {
		it("happy: returns the live row matching id + thread", () => {
			seed(db, { id: "m1" });
			const row = findLiveMessageByIdAndThread(db, "m1", THREAD);
			expect(row?.id).toBe("m1");
		});

		it("miss: null when thread does not match", () => {
			seed(db, { id: "m1" });
			expect(findLiveMessageByIdAndThread(db, "m1", OTHER_THREAD)).toBeNull();
		});

		it("miss: null when the row is soft-deleted", () => {
			seed(db, { id: "m1" });
			softDelete(db, "messages", "m1", SITE);
			expect(findLiveMessageByIdAndThread(db, "m1", THREAD)).toBeNull();
		});
	});

	describe("findMessageRoleById (deleted-filter OMISSION)", () => {
		it("returns the tombstoned row's role while a live-only read would not", () => {
			seed(db, { id: "live", role: "user" });
			seed(db, { id: "dead", role: "assistant" });
			softDelete(db, "messages", "dead", SITE);

			// Omission finder sees the tombstone.
			expect(findMessageRoleById(db, "dead")).toEqual({ role: "assistant" });
			// Sanity: its deleted=0 sibling reader does NOT see it.
			expect(findLiveMessageByIdAndThread(db, "dead", THREAD)).toBeNull();
			// Live row is visible to both.
			expect(findMessageRoleById(db, "live")).toEqual({ role: "user" });
		});

		it("miss: null for an absent id", () => {
			expect(findMessageRoleById(db, "nope")).toBeNull();
		});
	});

	describe("findMessageMetadataById (deleted-filter OMISSION)", () => {
		it("returns metadata for a soft-deleted row", () => {
			seed(db, { id: "m1", metadata: '{"k":1}' });
			softDelete(db, "messages", "m1", SITE);
			expect(findMessageMetadataById(db, "m1")).toEqual({ metadata: '{"k":1}' });
		});

		it("returns null metadata field when unset", () => {
			seed(db, { id: "m1" });
			expect(findMessageMetadataById(db, "m1")).toEqual({ metadata: null });
		});

		it("miss: null for an absent id", () => {
			expect(findMessageMetadataById(db, "nope")).toBeNull();
		});
	});

	describe("listMessagesByThread (live, ASC)", () => {
		it("returns only live rows of the thread, oldest first", () => {
			seed(db, { id: "b", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "a", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "dead", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "other", thread_id: OTHER_THREAD });
			softDelete(db, "messages", "dead", SITE);

			const rows = listMessagesByThread(db, THREAD);
			expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
		});

		it("returns [] for an unknown thread", () => {
			expect(listMessagesByThread(db, "ghost")).toEqual([]);
		});
	});

	describe("count finders", () => {
		beforeEach(() => {
			seed(db, { id: "u1", role: "user" });
			seed(db, { id: "a1", role: "assistant" });
			seed(db, { id: "a2", role: "assistant" });
			seed(db, { id: "dead", role: "assistant" });
			softDelete(db, "messages", "dead", SITE);
			seed(db, { id: "other-a", role: "assistant", thread_id: OTHER_THREAD });
		});

		it("countLiveMessagesByThread excludes deleted and other threads", () => {
			expect(countLiveMessagesByThread(db, THREAD)).toBe(3);
		});

		it("countMessagesByThread includes soft-deleted (OMISSION variant)", () => {
			expect(countMessagesByThread(db, THREAD)).toBe(4);
		});

		it("countLiveAssistantMessagesByThread counts live assistant only", () => {
			expect(countLiveAssistantMessagesByThread(db, THREAD)).toBe(2);
		});

		it("countAssistantMessages counts assistants across all threads, ignoring deleted", () => {
			// a1, a2, dead (in THREAD) + other-a = 4
			expect(countAssistantMessages(db)).toBe(4);
		});

		it("counts are 0 for empty / unknown threads", () => {
			expect(countLiveMessagesByThread(db, "ghost")).toBe(0);
			expect(countMessagesByThread(db, "ghost")).toBe(0);
			expect(countLiveAssistantMessagesByThread(db, "ghost")).toBe(0);
		});

		it("countAssistantMessages is 0 with no assistant rows", () => {
			const fresh = new Database(":memory:");
			applySchema(fresh);
			applyMetricsSchema(fresh);
			insertRow(fresh, "messages", makeMessage({ id: "only-user", role: "user" }), SITE);
			expect(countAssistantMessages(fresh)).toBe(0);
			fresh.close();
		});
	});

	describe("listLiveMessagesByThreadNewestFirst (LIMIT, returned ASC)", () => {
		it("keeps the newest N live rows but returns them chronologically", () => {
			seed(db, { id: "m1", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "m2", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "m3", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "m4", created_at: "2026-01-01T00:00:04.000Z" });
			seed(db, { id: "dead", created_at: "2026-01-01T00:00:05.000Z" });
			softDelete(db, "messages", "dead", SITE);

			// 4 live rows, cap 2 → newest two (m3, m4), returned ASC.
			const rows = listLiveMessagesByThreadNewestFirst(db, THREAD, 2);
			expect(rows.map((r) => r.id)).toEqual(["m3", "m4"]);
		});
	});

	describe("findFirstMessageContentByThreadAndRole (LIMIT 1; ignores deleted)", () => {
		it("returns the earliest message content of the role, even if soft-deleted", () => {
			seed(db, {
				id: "u-old",
				role: "user",
				content: "first",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "u-new",
				role: "user",
				content: "second",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			softDelete(db, "messages", "u-old", SITE);
			// Still returns u-old because the finder ignores deleted.
			expect(findFirstMessageContentByThreadAndRole(db, THREAD, "user")).toEqual({
				content: "first",
			});
		});

		it("miss: null when no message of that role exists", () => {
			seed(db, { id: "u1", role: "user" });
			expect(findFirstMessageContentByThreadAndRole(db, THREAD, "assistant")).toBeNull();
		});
	});

	describe("listLiveToolCallContentByThread (rowid tiebreak)", () => {
		it("orders by created_at then rowid; identical timestamps keep insertion order", () => {
			seed(db, { id: "tc1", role: "tool_call", content: "c1" });
			seed(db, { id: "tc2", role: "tool_call", content: "c2" });
			seed(db, { id: "tc3", role: "tool_call", content: "c3" });
			seed(db, { id: "dead", role: "tool_call", content: "cX" });
			softDelete(db, "messages", "dead", SITE);
			seed(db, { id: "not-a-call", role: "assistant", content: "nope" });

			const rows = listLiveToolCallContentByThread(db, THREAD);
			// All identical created_at → stable insertion order via rowid.
			expect(rows.map((r) => r.content)).toEqual(["c1", "c2", "c3"]);
		});
	});

	describe("listMessageRoleContentByThreadSince (created_at > since; ignores deleted)", () => {
		it("returns role+content strictly after the cutoff, including deleted rows", () => {
			seed(db, {
				id: "before",
				role: "user",
				content: "old",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "at",
				role: "user",
				content: "boundary",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			seed(db, {
				id: "after",
				role: "assistant",
				content: "new",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			seed(db, {
				id: "dead-after",
				role: "tool_call",
				content: "deadnew",
				created_at: "2026-01-01T00:00:04.000Z",
			});
			softDelete(db, "messages", "dead-after", SITE);

			// strict > cutoff "...02" → excludes "at", includes after + dead-after
			const rows = listMessageRoleContentByThreadSince(db, THREAD, "2026-01-01T00:00:02.000Z");
			expect(rows).toEqual([
				{ role: "assistant", content: "new" },
				{ role: "tool_call", content: "deadnew" },
			]);
		});
	});

	describe("findLatestLiveUserMessageCreatedAtByThread", () => {
		it("returns latest live user timestamp, ignoring assistant + deleted", () => {
			seed(db, { id: "u1", role: "user", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "u2", role: "user", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "u-dead", role: "user", created_at: "2026-01-01T00:00:05.000Z" });
			softDelete(db, "messages", "u-dead", SITE);
			seed(db, { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:09.000Z" });

			expect(findLatestLiveUserMessageCreatedAtByThread(db, THREAD)).toEqual({
				created_at: "2026-01-01T00:00:03.000Z",
			});
		});

		it("miss: null with no live user messages", () => {
			seed(db, { id: "a1", role: "assistant" });
			expect(findLatestLiveUserMessageCreatedAtByThread(db, THREAD)).toBeNull();
		});
	});

	describe("listToolNameCountsByThread (GROUP BY, ORDER BY MAX(created_at) DESC, LIMIT)", () => {
		it("counts per tool_name, most-recently-used first, capped by limit", () => {
			// alpha: 2 calls, last at ...02
			seed(db, {
				id: "a1",
				role: "tool_call",
				tool_name: "alpha",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "a2",
				role: "tool_call",
				tool_name: "alpha",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			// beta: 1 call, last at ...05 (most recent)
			seed(db, {
				id: "b1",
				role: "tool_call",
				tool_name: "beta",
				created_at: "2026-01-01T00:00:05.000Z",
			});
			// gamma: 3 calls, last at ...03
			seed(db, {
				id: "g1",
				role: "tool_call",
				tool_name: "gamma",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "g2",
				role: "tool_call",
				tool_name: "gamma",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			seed(db, {
				id: "g3",
				role: "tool_call",
				tool_name: "gamma",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			// rows without tool_name are ignored
			seed(db, { id: "plain", role: "user", created_at: "2026-01-01T00:00:09.000Z" });

			// Order by MAX(created_at) DESC: beta(05), gamma(03), alpha(02). Cap 2 → beta, gamma.
			const rows = listToolNameCountsByThread(db, THREAD, 2);
			expect(rows).toEqual([
				{ tool_name: "beta", count: 1 },
				{ tool_name: "gamma", count: 3 },
			]);
		});

		it("returns [] when no tool_name rows exist (zero-row aggregate)", () => {
			seed(db, { id: "u1", role: "user" });
			expect(listToolNameCountsByThread(db, THREAD, 10)).toEqual([]);
		});
	});

	describe("listRecentLiveMessageContentByThread (LIMIT, DESC)", () => {
		it("returns newest N live contents, newest first", () => {
			seed(db, { id: "m1", content: "one", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "m2", content: "two", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "m3", content: "three", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "dead", content: "X", created_at: "2026-01-01T00:00:09.000Z" });
			softDelete(db, "messages", "dead", SITE);

			const rows = listRecentLiveMessageContentByThread(db, THREAD, 2);
			expect(rows.map((r) => r.content)).toEqual(["three", "two"]);
		});
	});

	describe("listMessageIdsByThreadNewestFirst (LIMIT, DESC; ignores deleted)", () => {
		it("returns newest N ids including deleted rows", () => {
			seed(db, { id: "m1", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "m2", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "dead", created_at: "2026-01-01T00:00:03.000Z" });
			softDelete(db, "messages", "dead", SITE);

			const rows = listMessageIdsByThreadNewestFirst(db, THREAD, 2);
			// deleted "dead" is still the newest → included.
			expect(rows.map((r) => r.id)).toEqual(["dead", "m2"]);
		});
	});

	describe("listMessageIdRoleByIds (dynamic IN)", () => {
		beforeEach(() => {
			seed(db, { id: "x", role: "user" });
			seed(db, { id: "y", role: "assistant" });
			seed(db, { id: "z", role: "tool_call" });
			softDelete(db, "messages", "z", SITE); // ignores deleted
		});

		it("empty list returns [] without matching all rows", () => {
			expect(listMessageIdRoleByIds(db, [])).toEqual([]);
		});

		it("single element", () => {
			expect(listMessageIdRoleByIds(db, ["x"])).toEqual([{ id: "x", role: "user" }]);
		});

		it("multiple elements, includes soft-deleted, ignores absent ids", () => {
			const rows = listMessageIdRoleByIds(db, ["x", "z", "absent"]);
			const byId = Object.fromEntries(rows.map((r) => [r.id, r.role]));
			expect(byId).toEqual({ x: "user", z: "tool_call" });
		});
	});

	describe("findPairedToolResultId (correlated subqueries)", () => {
		it("returns the first tool_result after the tool_call in the same thread", () => {
			seed(db, {
				id: "call",
				role: "tool_call",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			// earlier tool_result must NOT be paired
			seed(db, {
				id: "earlier-result",
				role: "tool_result",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "result-1",
				role: "tool_result",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			seed(db, {
				id: "result-2",
				role: "tool_result",
				created_at: "2026-01-01T00:00:04.000Z",
			});
			// a result in a different thread must NOT match
			seed(db, {
				id: "other-result",
				role: "tool_result",
				thread_id: OTHER_THREAD,
				created_at: "2026-01-01T00:00:03.000Z",
			});

			expect(findPairedToolResultId(db, "call")).toEqual({ id: "result-1" });
		});

		it("miss: null when no following tool_result exists", () => {
			seed(db, { id: "call", role: "tool_call", created_at: "2026-01-01T00:00:02.000Z" });
			expect(findPairedToolResultId(db, "call")).toBeNull();
		});
	});

	describe("listDistinctToolNamesByThread (DISTINCT, role='tool', LIMIT 50)", () => {
		it("returns distinct tool names for role='tool' only", () => {
			seed(db, { id: "t1", role: "tool", tool_name: "read" });
			seed(db, { id: "t2", role: "tool", tool_name: "read" });
			seed(db, { id: "t3", role: "tool", tool_name: "write" });
			// role tool_call is excluded even with a tool_name
			seed(db, { id: "tc", role: "tool_call", tool_name: "exec" });
			// null tool_name excluded
			seed(db, { id: "t4", role: "tool", tool_name: null });

			const names = listDistinctToolNamesByThread(db, THREAD)
				.map((r) => r.tool_name)
				.sort();
			expect(names).toEqual(["read", "write"]);
		});

		it("returns [] when the thread has no role='tool' rows", () => {
			seed(db, { id: "u1", role: "user" });
			expect(listDistinctToolNamesByThread(db, THREAD)).toEqual([]);
		});
	});

	describe("listLiveAssistantMessagesWithMetadataByThreadSince (created_at >= since)", () => {
		it("returns live assistant rows with non-null metadata since the inclusive cutoff", () => {
			seed(db, {
				id: "before",
				role: "assistant",
				metadata: '{"a":1}',
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "at",
				role: "assistant",
				content: "atC",
				metadata: '{"b":2}',
				created_at: "2026-01-01T00:00:02.000Z",
			});
			// null metadata excluded
			seed(db, {
				id: "no-meta",
				role: "assistant",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			// non-assistant excluded
			seed(db, {
				id: "dev",
				role: "developer",
				metadata: '{"c":3}',
				created_at: "2026-01-01T00:00:03.000Z",
			});
			// deleted excluded
			seed(db, {
				id: "dead",
				role: "assistant",
				metadata: '{"d":4}',
				created_at: "2026-01-01T00:00:04.000Z",
			});
			softDelete(db, "messages", "dead", SITE);

			// >= cutoff "...02" → includes "at", excludes "before"
			const rows = listLiveAssistantMessagesWithMetadataByThreadSince(
				db,
				THREAD,
				"2026-01-01T00:00:02.000Z",
			);
			expect(rows).toEqual([{ id: "at", content: "atC", metadata: '{"b":2}' }]);
		});
	});

	describe("listLiveDeveloperMessageMetadataByThreadSince (created_at >= since)", () => {
		it("returns live developer rows with non-null metadata since the inclusive cutoff", () => {
			seed(db, {
				id: "d1",
				role: "developer",
				metadata: '{"x":1}',
				created_at: "2026-01-01T00:00:05.000Z",
			});
			seed(db, {
				id: "d-old",
				role: "developer",
				metadata: '{"y":2}',
				created_at: "2026-01-01T00:00:01.000Z",
			});
			seed(db, {
				id: "d-nometa",
				role: "developer",
				created_at: "2026-01-01T00:00:06.000Z",
			});

			const rows = listLiveDeveloperMessageMetadataByThreadSince(
				db,
				THREAD,
				"2026-01-01T00:00:02.000Z",
			);
			expect(rows).toEqual([{ id: "d1", metadata: '{"x":1}' }]);
		});
	});

	describe("findLatestLiveAssistantMessageIdByThreadSince (>= since, DESC LIMIT 1)", () => {
		it("returns the newest live assistant id at/after the cutoff", () => {
			seed(db, { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "a2", role: "assistant", created_at: "2026-01-01T00:00:04.000Z" });
			seed(db, { id: "a-dead", role: "assistant", created_at: "2026-01-01T00:00:09.000Z" });
			softDelete(db, "messages", "a-dead", SITE);

			expect(
				findLatestLiveAssistantMessageIdByThreadSince(db, THREAD, "2026-01-01T00:00:02.000Z"),
			).toEqual({ id: "a2" });
		});

		it("miss: null when all assistant messages predate the cutoff", () => {
			seed(db, { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:01.000Z" });
			expect(
				findLatestLiveAssistantMessageIdByThreadSince(db, THREAD, "2026-01-01T00:00:05.000Z"),
			).toBeNull();
		});
	});

	describe("listMessageHostOriginCountsSince (GROUP BY host_origin, MAX latest)", () => {
		it("groups by non-empty host_origin across threads, counting + latest", () => {
			seed(db, {
				id: "h1",
				host_origin: "alpha",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			seed(db, {
				id: "h2",
				host_origin: "alpha",
				thread_id: OTHER_THREAD,
				created_at: "2026-01-01T00:00:05.000Z",
			});
			seed(db, {
				id: "h3",
				host_origin: "beta",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			// empty host_origin excluded
			seed(db, {
				id: "h-empty",
				host_origin: "",
				created_at: "2026-01-01T00:00:04.000Z",
			});
			// before cutoff excluded
			seed(db, {
				id: "h-old",
				host_origin: "alpha",
				created_at: "2026-01-01T00:00:01.000Z",
			});

			const rows = listMessageHostOriginCountsSince(db, "2026-01-01T00:00:01.000Z");
			const byHost = Object.fromEntries(rows.map((r) => [r.host_origin, r]));
			expect(Object.keys(byHost).sort()).toEqual(["alpha", "beta"]);
			expect(byHost.alpha).toEqual({
				host_origin: "alpha",
				count: 2,
				latest: "2026-01-01T00:00:05.000Z",
			});
			expect(byHost.beta).toEqual({
				host_origin: "beta",
				count: 1,
				latest: "2026-01-01T00:00:03.000Z",
			});
		});

		it("returns [] when nothing is after the cutoff (zero-row aggregate)", () => {
			seed(db, { id: "h1", host_origin: "alpha", created_at: "2026-01-01T00:00:01.000Z" });
			expect(listMessageHostOriginCountsSince(db, "2026-01-01T00:00:09.000Z")).toEqual([]);
		});
	});

	describe("findLatestLiveAssistantMessageCreatedAtByThread", () => {
		it("returns latest live assistant timestamp", () => {
			seed(db, { id: "a1", role: "assistant", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "a2", role: "assistant", created_at: "2026-01-01T00:00:04.000Z" });
			seed(db, { id: "u1", role: "user", created_at: "2026-01-01T00:00:09.000Z" });
			expect(findLatestLiveAssistantMessageCreatedAtByThread(db, THREAD)).toEqual({
				created_at: "2026-01-01T00:00:04.000Z",
			});
		});

		it("miss: null with no live assistant messages", () => {
			seed(db, { id: "u1", role: "user" });
			expect(findLatestLiveAssistantMessageCreatedAtByThread(db, THREAD)).toBeNull();
		});
	});

	describe("findFirstLiveUserMessageByThreadSince (> since, ASC LIMIT 1)", () => {
		it("returns the earliest live user message strictly after the cutoff", () => {
			seed(db, {
				id: "at",
				role: "user",
				content: "boundary",
				created_at: "2026-01-01T00:00:02.000Z",
			});
			seed(db, {
				id: "next",
				role: "user",
				content: "earliest-after",
				created_at: "2026-01-01T00:00:03.000Z",
			});
			seed(db, {
				id: "later",
				role: "user",
				content: "later",
				created_at: "2026-01-01T00:00:04.000Z",
			});

			// strict > "...02" excludes "at"; earliest after is "next"
			expect(findFirstLiveUserMessageByThreadSince(db, THREAD, "2026-01-01T00:00:02.000Z")).toEqual(
				{ id: "next", content: "earliest-after", role: "user" },
			);
		});

		it("miss: null when no live user message follows the cutoff", () => {
			seed(db, { id: "u1", role: "user", created_at: "2026-01-01T00:00:01.000Z" });
			expect(
				findFirstLiveUserMessageByThreadSince(db, THREAD, "2026-01-01T00:00:05.000Z"),
			).toBeNull();
		});
	});

	describe("findLatestLiveMessageCreatedAtByThread (any role)", () => {
		it("returns latest live timestamp regardless of role", () => {
			seed(db, { id: "u1", role: "user", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "tc", role: "tool_call", created_at: "2026-01-01T00:00:05.000Z" });
			seed(db, { id: "dead", role: "assistant", created_at: "2026-01-01T00:00:09.000Z" });
			softDelete(db, "messages", "dead", SITE);
			expect(findLatestLiveMessageCreatedAtByThread(db, THREAD)).toEqual({
				created_at: "2026-01-01T00:00:05.000Z",
			});
		});

		it("miss: null for an empty thread", () => {
			expect(findLatestLiveMessageCreatedAtByThread(db, "ghost")).toBeNull();
		});
	});

	describe("listLiveMessageDeltaByThreadSince (> since; ASC, rowid tiebreak)", () => {
		it("returns live rows strictly after the cutoff, stable by rowid on ties", () => {
			seed(db, { id: "before", created_at: "2026-01-01T00:00:01.000Z" });
			// three identical timestamps after the cutoff → insertion-order tiebreak
			seed(db, { id: "d1", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "d2", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "d3", created_at: "2026-01-01T00:00:03.000Z" });
			seed(db, { id: "dead", created_at: "2026-01-01T00:00:04.000Z" });
			softDelete(db, "messages", "dead", SITE);

			const rows = listLiveMessageDeltaByThreadSince(db, THREAD, "2026-01-01T00:00:02.000Z");
			expect(rows.map((r) => r.id)).toEqual(["d1", "d2", "d3"]);
			// projection includes the deleted column
			expect(rows[0].deleted).toBe(0);
		});
	});

	describe("listLiveMessageProjectionByThreadNewestFirst (DESC, rowid DESC, LIMIT)", () => {
		it("returns newest-first live rows, rowid DESC tiebreak, capped", () => {
			seed(db, { id: "p1", created_at: "2026-01-01T00:00:01.000Z" });
			// identical timestamps → newest by rowid DESC = p3, p2
			seed(db, { id: "p2", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "p3", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "dead", created_at: "2026-01-01T00:00:09.000Z" });
			softDelete(db, "messages", "dead", SITE);

			const rows = listLiveMessageProjectionByThreadNewestFirst(db, THREAD, 2);
			expect(rows.map((r) => r.id)).toEqual(["p3", "p2"]);
		});
	});

	describe("listLiveMessageProjectionByThreadSince (>= since; ASC, rowid tiebreak)", () => {
		it("returns live rows at/after the inclusive cutoff", () => {
			seed(db, { id: "before", created_at: "2026-01-01T00:00:01.000Z" });
			seed(db, { id: "at", created_at: "2026-01-01T00:00:02.000Z" });
			seed(db, { id: "after", created_at: "2026-01-01T00:00:03.000Z" });

			const rows = listLiveMessageProjectionByThreadSince(db, THREAD, "2026-01-01T00:00:02.000Z");
			// >= includes "at"
			expect(rows.map((r) => r.id)).toEqual(["at", "after"]);
		});
	});

	describe("findLatestAssistantMessageContent (all threads; ignores deleted; DESC, rowid DESC)", () => {
		it("returns most-recent assistant content across threads, rowid DESC tiebreak", () => {
			seed(db, {
				id: "a1",
				role: "assistant",
				content: "older",
				created_at: "2026-01-01T00:00:01.000Z",
			});
			// two identical newest timestamps in different threads → rowid DESC picks last inserted
			seed(db, {
				id: "a2",
				role: "assistant",
				content: "tie-first",
				created_at: "2026-01-01T00:00:05.000Z",
			});
			seed(db, {
				id: "a3",
				role: "assistant",
				content: "tie-second",
				thread_id: OTHER_THREAD,
				created_at: "2026-01-01T00:00:05.000Z",
			});
			expect(findLatestAssistantMessageContent(db)).toEqual({ content: "tie-second" });
		});

		it("returns deleted assistant content too (ignores deleted flag)", () => {
			seed(db, {
				id: "a1",
				role: "assistant",
				content: "deleted-newest",
				created_at: "2026-01-01T00:00:09.000Z",
			});
			softDelete(db, "messages", "a1", SITE);
			expect(findLatestAssistantMessageContent(db)).toEqual({ content: "deleted-newest" });
		});

		it("miss: null with no assistant messages", () => {
			seed(db, { id: "u1", role: "user" });
			expect(findLatestAssistantMessageContent(db)).toBeNull();
		});
	});
});
