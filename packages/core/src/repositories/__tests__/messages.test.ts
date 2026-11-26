import type Database from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Message } from "@bound/shared";
import { createCoreTestDb } from "../../__tests__/test-database";
import { applyMetricsSchema, insertRow, softDelete } from "../../index";
import {
	countAssistantMessages,
	countBackgroundToolCallsByThread,
	countLiveAssistantMessagesByThread,
	countLiveMessagesByThread,
	findBackgroundAuxSeed,
	findFirstLiveUserMessageByThreadSince,
	findFirstMessageContentByThreadAndRole,
	findLatestLiveAssistantMessageCreatedAtByThread,
	findLatestLiveMessageCreatedAtByThread,
	findLatestLiveUserMessageCreatedAtByThread,
	findLiveMessageByIdAndThread,
	findMessageById,
	findToolResultByThreadAndCallId,
	findUnresolvedBackgroundPlaceholder,
	getLatestChangeLogHlcForRows,
	listLiveMessageDeltaByThreadSince,
	listLiveMessageProjectionByThreadNewestFirst,
	listLiveMessageProjectionByThreadSince,
	listLiveMessagesByThreadNewestFirst,
	listMessageRoleContentByThreadSince,
	listMessagesByThread,
	listRecentLiveMessageContentByThread,
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
		db = createCoreTestDb({ metrics: true });
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

	// AC.4 / R-UD6 — the delegation segmenter's confirmed-sync gate. A range may
	// cover a row only if its latest change_log HLC is <= the consumer's confirmed
	// watermark, so this finder must report each row's HIGHEST HLC and the gate
	// `hlc <= watermark` must never admit a row whose latest write outran it.
	describe("getLatestChangeLogHlcForRows (segmenter confirmed-sync gate)", () => {
		it("maps each row id to its change_log HLC, ordered by write time", () => {
			seed(db, { id: "m1" });
			seed(db, { id: "m2" });
			const map = getLatestChangeLogHlcForRows(db, ["m1", "m2"]);
			const m1Hlc = map.get("m1");
			const m2Hlc = map.get("m2");
			expect(m1Hlc).toBeDefined();
			expect(m2Hlc).toBeDefined();
			// m2 was inserted after m1, so its HLC is strictly greater — the gate
			// relies on this monotonic ordering to decide range coverage.
			expect((m2Hlc as string) > (m1Hlc as string)).toBe(true);
		});

		it("omits rows with no change_log entry", () => {
			seed(db, { id: "m1" });
			const map = getLatestChangeLogHlcForRows(db, ["m1", "ghost"]);
			expect(map.has("m1")).toBe(true);
			expect(map.has("ghost")).toBe(false);
		});

		it("returns an empty map for no row ids", () => {
			expect(getLatestChangeLogHlcForRows(db, []).size).toBe(0);
		});

		it("the gate `hlc <= watermark` never admits a row whose latest HLC exceeds it (AC.4)", () => {
			seed(db, { id: "old" });
			seed(db, { id: "newer" });
			const map = getLatestChangeLogHlcForRows(db, ["old", "newer"]);
			const oldHlc = map.get("old");
			const newerHlc = map.get("newer");
			expect(oldHlc).toBeDefined();
			expect(newerHlc).toBeDefined();
			// Pick the watermark exactly at the older row: the older row is
			// coverable, the newer row (HLC > watermark) is NOT.
			const watermark = oldHlc as string;
			expect((oldHlc as string) <= watermark).toBe(true);
			expect((newerHlc as string) <= watermark).toBe(false);
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

		it("countLiveAssistantMessagesByThread counts live assistant only", () => {
			expect(countLiveAssistantMessagesByThread(db, THREAD)).toBe(2);
		});

		it("countAssistantMessages counts assistants across all threads, ignoring deleted", () => {
			// a1, a2, dead (in THREAD) + other-a = 4
			expect(countAssistantMessages(db)).toBe(4);
		});

		it("countAssistantMessages is 0 with no assistant rows", () => {
			const fresh = createCoreTestDb();
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

	// #201 — the inline client-tool resolver an aux (nested) loop uses. The WS
	// layer persists a client tool result as role='tool_result' with
	// tool_name=call_id, so this is the lookup that stands in for a loop re-wake.
	describe("findToolResultByThreadAndCallId", () => {
		it("finds the result for a (thread, call_id) pair", () => {
			seed(db, {
				id: "tr1",
				role: "tool_result",
				tool_name: "call_1",
				content: "file contents",
			});
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_1")).toEqual({
				content: "file contents",
				exit_code: null,
			});
		});

		it("carries a non-zero exit_code through so callers can flag an error", () => {
			seed(db, {
				id: "tr-err",
				role: "tool_result",
				tool_name: "call_2",
				content: "Error: nope",
				exit_code: 1,
			});
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_2")?.exit_code).toBe(1);
		});

		// call_ids are only unique WITHIN a turn — boundless reuses call_1, call_2,
		// … every turn — so the newest row is the live one.
		it("returns the newest row when a call_id was reused across turns", () => {
			seed(db, {
				id: "tr-old",
				role: "tool_result",
				tool_name: "call_1",
				content: "stale turn",
				created_at: "2026-01-01T00:00:00.000Z",
			});
			seed(db, {
				id: "tr-new",
				role: "tool_result",
				tool_name: "call_1",
				content: "current turn",
				created_at: "2026-06-01T00:00:00.000Z",
			});
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_1")?.content).toBe("current turn");
		});

		it("ignores rows of other roles that share the tool_name", () => {
			seed(db, { id: "tc1", role: "tool_call", tool_name: "call_1", content: "the call" });
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_1")).toBeNull();
		});

		it("ignores soft-deleted rows", () => {
			seed(db, { id: "tr-del", role: "tool_result", tool_name: "call_1", content: "gone" });
			softDelete(db, "messages", "tr-del", SITE);
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_1")).toBeNull();
		});

		it("scopes to the owning thread", () => {
			seed(db, {
				id: "tr-other",
				thread_id: OTHER_THREAD,
				role: "tool_result",
				tool_name: "call_1",
				content: "other thread",
			});
			expect(findToolResultByThreadAndCallId(db, THREAD, "call_1")).toBeNull();
			expect(findToolResultByThreadAndCallId(db, OTHER_THREAD, "call_1")?.content).toBe(
				"other thread",
			);
		});

		it("misses cleanly when no result exists yet", () => {
			expect(findToolResultByThreadAndCallId(db, THREAD, "never")).toBeNull();
		});

		describe("countBackgroundToolCallsByThread", () => {
			it("counts live tool_result rows still carrying the background marker", () => {
				seed(db, {
					id: "bg1",
					role: "tool_result",
					metadata: JSON.stringify({ background: true }),
				});
				seed(db, {
					id: "bg2",
					role: "tool_result",
					metadata: JSON.stringify({ background: true }),
				});
				expect(countBackgroundToolCallsByThread(db, THREAD)).toBe(2);
			});

			it("ignores resolved tool_result rows whose background marker was stripped", () => {
				seed(db, {
					id: "resolved",
					role: "tool_result",
					metadata: JSON.stringify({ other: 1 }),
				});
				expect(countBackgroundToolCallsByThread(db, THREAD)).toBe(0);
			});

			it("ignores soft-deleted background placeholders", () => {
				seed(db, {
					id: "bg1",
					role: "tool_result",
					metadata: JSON.stringify({ background: true }),
				});
				softDelete(db, "messages", "bg1", SITE);
				expect(countBackgroundToolCallsByThread(db, THREAD)).toBe(0);
			});

			it("returns 0 for a thread with no background placeholders", () => {
				expect(countBackgroundToolCallsByThread(db, "thread-empty")).toBe(0);
			});
		});

		describe("findBackgroundAuxSeed", () => {
			it("returns the parent thread/call ids and instructions for the oldest seed user message", () => {
				seed(db, {
					id: "seed",
					role: "user",
					content: "do the thing",
					created_at: "2026-01-01T00:00:00.000Z",
					metadata: JSON.stringify({
						background_parent: { thread_id: "parent-t", call_id: "call-9" },
					}),
				});
				expect(findBackgroundAuxSeed(db, THREAD)).toEqual({
					parentThreadId: "parent-t",
					parentCallId: "call-9",
					instructions: "do the thing",
				});
			});

			it("returns null for a foreground thread whose user message has no background_parent", () => {
				seed(db, { id: "plain", role: "user", content: "hi" });
				expect(findBackgroundAuxSeed(db, THREAD)).toBeNull();
			});

			it("picks the earliest seed when several carry the marker", () => {
				seed(db, {
					id: "later",
					role: "user",
					content: "second",
					created_at: "2026-01-02T00:00:00.000Z",
					metadata: JSON.stringify({
						background_parent: { thread_id: "p", call_id: "c-late" },
					}),
				});
				seed(db, {
					id: "earlier",
					role: "user",
					content: "first",
					created_at: "2026-01-01T00:00:00.000Z",
					metadata: JSON.stringify({
						background_parent: { thread_id: "p", call_id: "c-early" },
					}),
				});
				expect(findBackgroundAuxSeed(db, THREAD)?.parentCallId).toBe("c-early");
			});
		});

		describe("findUnresolvedBackgroundPlaceholder", () => {
			it("returns the placeholder id while it still carries the background marker", () => {
				seed(db, {
					id: "ph1",
					role: "tool_result",
					tool_name: "call-1",
					metadata: JSON.stringify({ background: true }),
				});
				expect(findUnresolvedBackgroundPlaceholder(db, THREAD, "call-1")).toEqual({ id: "ph1" });
			});

			it("returns null once the marker has been stripped (resolved)", () => {
				seed(db, {
					id: "ph1",
					role: "tool_result",
					tool_name: "call-1",
					metadata: JSON.stringify({ resolved: true }),
				});
				expect(findUnresolvedBackgroundPlaceholder(db, THREAD, "call-1")).toBeNull();
			});

			it("returns null for a call id with no placeholder", () => {
				expect(findUnresolvedBackgroundPlaceholder(db, THREAD, "never")).toBeNull();
			});
		});
	});
});
